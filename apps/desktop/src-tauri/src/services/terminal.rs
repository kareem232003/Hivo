use crate::models::{
    BackgroundJobRecord, CommandExecutionProvenance, CommandFailureDiagnosis, CommandResult,
    CommandRisk, SafetySettingsInput,
};
use crate::services::command_policy::{CommandPolicyAnalysis, CommandPolicyService};
use chrono::Utc;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use std::{io, io::Read};

const FOREGROUND_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const COMMAND_TIMEOUT_POLL_INTERVAL: Duration = Duration::from_millis(20);

pub struct TerminalService;

impl TerminalService {
    pub fn new() -> Self {
        Self
    }

    pub fn run_command(
        &self,
        command: &str,
        cwd: &Path,
        workspace: &Path,
        safety: Option<SafetySettingsInput>,
    ) -> CommandResult {
        self.run_command_with_timeout(command, cwd, workspace, safety, FOREGROUND_COMMAND_TIMEOUT)
    }

    fn run_command_with_timeout(
        &self,
        command: &str,
        cwd: &Path,
        workspace: &Path,
        safety: Option<SafetySettingsInput>,
        foreground_timeout: Duration,
    ) -> CommandResult {
        let safety = safety.unwrap_or(SafetySettingsInput {
            block_dangerous_commands: true,
            redact_secrets: true,
            allow_network_commands: false,
            auto_run_medium_commands: Some(false),
            auto_run_background_commands: Some(false),
            auto_run_network_commands: Some(false),
            approval_granted: None,
        });
        let approval_granted = safety.approval_granted.unwrap_or(false);
        let auto_run_medium = safety.auto_run_medium_commands.unwrap_or(false);
        let auto_run_background = safety.auto_run_background_commands.unwrap_or(false);
        let auto_run_network = safety.auto_run_network_commands.unwrap_or(false);
        let canonical_workspace = match std::fs::canonicalize(workspace) {
            Ok(path) => path,
            Err(err) => {
                return blocked_result(
                    command,
                    cwd,
                    &synthetic_policy("Workspace path is not accessible."),
                    format!("Workspace path is not accessible: {err}"),
                    approval_granted,
                );
            }
        };
        let canonical_cwd = match std::fs::canonicalize(cwd) {
            Ok(path) if path.starts_with(&canonical_workspace) => path,
            Ok(_) => {
                return blocked_result(
                    command,
                    cwd,
                    &synthetic_policy("Command cwd is outside the active workspace."),
                    "Command cwd is outside the active workspace".to_string(),
                    approval_granted,
                );
            }
            Err(err) => {
                return blocked_result(
                    command,
                    cwd,
                    &synthetic_policy("Command cwd is not accessible."),
                    format!("Command cwd is not accessible: {err}"),
                    approval_granted,
                );
            }
        };
        let mut policy = CommandPolicyService::analyze(command, workspace);
        let risk = policy.risk.clone();
        if !safety.block_dangerous_commands && risk == CommandRisk::Dangerous {
            policy.policy_decision = "allow";
            policy.policy_reason =
                "Full Access allowed a command that heuristic policy would normally deny."
                    .to_string();
        }
        if safety.block_dangerous_commands && risk == CommandRisk::Dangerous {
            return CommandResult {
                command: command.to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                risk,
                status: "blocked".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                message: Some("Dangerous command blocked by policy before execution.".to_string()),
                diagnosis: Some(CommandFailureDiagnosis {
                    category: "policy_blocked".to_string(),
                    severity: "error".to_string(),
                    summary: "This command was blocked by policy before execution.".to_string(),
                    next_step: Some(
                        "Use a safe foreground command or explicitly approve a narrower operation."
                            .to_string(),
                    ),
                }),
                provenance: Some(build_provenance(
                    command,
                    cwd,
                    &policy,
                    approval_granted,
                    false,
                    None,
                    Some("Command was denied by policy before execution.".to_string()),
                )),
                background_job: None,
            };
        }

        let network_detected = looks_like_network_command(command);
        let background_detected = looks_like_background_server(command);

        if !safety.allow_network_commands && network_detected {
            return blocked_result(
                command,
                cwd,
                &policy,
                "Network commands are blocked by active safety settings".to_string(),
                approval_granted,
            );
        }

        let medium_needs_approval = risk == CommandRisk::Medium && !auto_run_medium;
        let background_needs_approval = background_detected && !auto_run_background;
        let network_needs_approval = network_detected && !auto_run_network;
        if !approval_granted
            && (medium_needs_approval || background_needs_approval || network_needs_approval)
        {
            return CommandResult {
                command: command.to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                risk,
                status: "approval_required".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                message: Some(approval_required_message(command)),
                diagnosis: Some(CommandFailureDiagnosis {
                    category: if background_detected {
                        "background_command".to_string()
                    } else {
                        "approval_required".to_string()
                    },
                    severity: "warning".to_string(),
                    summary: "This command needs explicit approval before Rust execution.".to_string(),
                    next_step: Some(
                        if background_detected {
                            "Approve it only if you expect a long-running or server command."
                        } else {
                            "Approve it if expected, or choose a policy-classified safe foreground command."
                        }
                        .to_string(),
                    ),
                }),
                provenance: Some(build_provenance(
                    command,
                    cwd,
                    &policy,
                    false,
                    false,
                    None,
                    Some("Policy heuristics require explicit approval before Rust execution.".to_string()),
                )),
                background_job: None,
            };
        }

        if background_detected {
            let spawned = if cfg!(windows) {
                Command::new("cmd")
                    .args(["/C", command])
                    .current_dir(&canonical_cwd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
            } else {
                Command::new("sh")
                    .args(["-lc", command])
                    .current_dir(&canonical_cwd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
            };

            return match spawned {
                Ok(child) => {
                    let now = Utc::now().to_rfc3339();
                    let pid = child.id();
                    CommandResult {
                        command: command.to_string(),
                        cwd: cwd.to_string_lossy().to_string(),
                        risk,
                        status: "running".to_string(),
                        exit_code: None,
                        stdout: String::new(),
                        stderr: String::new(),
                        message: Some(format!(
                            "Policy-classified background command started by Rust terminal authority with pid {}. Background tracking is limited unless a later terminal result is recorded.",
                            pid
                        )),
                        diagnosis: Some(CommandFailureDiagnosis {
                            category: "background_command".to_string(),
                            severity: "warning".to_string(),
                            summary: "This command started a background process with limited tracking.".to_string(),
                            next_step: Some("Use foreground verification commands when you need a terminal result that can feed back into the runtime loop.".to_string()),
                        }),
                        provenance: Some(build_provenance(
                            command,
                            cwd,
                            &policy,
                            approval_granted,
                            true,
                            Some(pid),
                            Some("Background command started by Rust authority with limited tracking.".to_string()),
                        )),
                        background_job: Some(BackgroundJobRecord {
                            job_id: format!("job_{}", pid),
                            request_id: None,
                            session_id: String::new(),
                            command: command.to_string(),
                            cwd: cwd.to_string_lossy().to_string(),
                            process_id: Some(pid),
                            started_at: now.clone(),
                            completed_at: None,
                            status: "running".to_string(),
                            last_known_at: now,
                            exit_code: None,
                            output_summary: Some(
                                "Background process started. Durable completion tracking is limited.".to_string(),
                            ),
                            detection_source: "heuristic".to_string(),
                        }),
                    }
                }
                Err(err) => CommandResult {
                    command: command.to_string(),
                    cwd: cwd.to_string_lossy().to_string(),
                    risk,
                    status: "failed".to_string(),
                    exit_code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                    message: Some(format!(
                        "Approved background command failed to start under Rust terminal authority: {err}"
                    )),
                    diagnosis: Some(CommandFailureDiagnosis {
                        category: "background_command".to_string(),
                        severity: "error".to_string(),
                        summary: "The background command did not start successfully.".to_string(),
                        next_step: Some("Inspect the command and cwd, then retry with an explicit foreground verification command if possible.".to_string()),
                    }),
                    provenance: Some(build_provenance(
                        command,
                        cwd,
                        &policy,
                        approval_granted,
                        true,
                        None,
                        Some("Background command failed to start under Rust authority.".to_string()),
                    )),
                    background_job: Some(BackgroundJobRecord {
                        job_id: format!("job_failed_{}", Utc::now().timestamp_millis()),
                        request_id: None,
                        session_id: String::new(),
                        command: command.to_string(),
                        cwd: cwd.to_string_lossy().to_string(),
                        process_id: None,
                        started_at: Utc::now().to_rfc3339(),
                        completed_at: Some(Utc::now().to_rfc3339()),
                        status: "failed".to_string(),
                        last_known_at: Utc::now().to_rfc3339(),
                        exit_code: None,
                        output_summary: Some("Background process failed to start.".to_string()),
                        detection_source: "heuristic".to_string(),
                    }),
                },
            };
        }

        let output = run_foreground_command(command, &canonical_cwd, foreground_timeout);

        match output {
            Ok(output) => CommandResult {
                command: command.to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                risk,
                status: if output.timed_out {
                    "timed_out"
                } else if output.status.success() {
                    "executed"
                } else {
                    "failed"
                }
                .to_string(),
                exit_code: if output.timed_out {
                    None
                } else {
                    output.status.code()
                },
                stdout: maybe_redact(
                    String::from_utf8_lossy(&output.stdout).to_string(),
                    safety.redact_secrets,
                ),
                stderr: maybe_redact(String::from_utf8_lossy(&output.stderr).to_string(), safety.redact_secrets),
                message: Some(if output.timed_out {
                    format!(
                        "Foreground command exceeded the {} second timeout and was terminated.",
                        foreground_timeout.as_secs()
                    )
                } else {
                    command_result_message(
                        command,
                        output.status.code(),
                        &String::from_utf8_lossy(&output.stdout),
                        &String::from_utf8_lossy(&output.stderr),
                    )
                }),
                diagnosis: if output.timed_out {
                    Some(CommandFailureDiagnosis {
                        category: "timeout".to_string(),
                        severity: "error".to_string(),
                        summary: "The foreground command exceeded its execution timeout.".to_string(),
                        next_step: Some("Inspect the command and retry only with a bounded verification step.".to_string()),
                    })
                } else {
                    diagnose_command_failure(
                        command,
                        output.status.code(),
                        &String::from_utf8_lossy(&output.stdout),
                        &String::from_utf8_lossy(&output.stderr),
                    )
                },
                provenance: Some(build_provenance(
                    command,
                    cwd,
                    &policy,
                    approval_granted,
                    false,
                    None,
                    Some(if output.timed_out {
                        "Foreground command was terminated after reaching the execution timeout.".to_string()
                    } else if output.status.success() {
                        "Foreground command completed under Rust authority.".to_string()
                    } else {
                        "Foreground command failed under Rust authority.".to_string()
                    }),
                )),
                background_job: None,
            },
            Err(err) => CommandResult {
                command: command.to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                risk,
                status: "failed".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: err.to_string(),
                message: Some("Rust terminal authority failed to execute command".to_string()),
                diagnosis: Some(CommandFailureDiagnosis {
                    category: "unknown".to_string(),
                    severity: "error".to_string(),
                    summary: "Rust could not start the command process.".to_string(),
                    next_step: Some("Check whether the executable exists and whether the workspace cwd is correct.".to_string()),
                }),
                provenance: Some(build_provenance(
                    command,
                    cwd,
                    &policy,
                    approval_granted,
                    false,
                    None,
                    Some("Rust terminal authority failed before completion.".to_string()),
                )),
                background_job: None,
            },
        }
    }
}

struct ForegroundCommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
}

fn run_foreground_command(
    command: &str,
    cwd: &Path,
    timeout: Duration,
) -> std::io::Result<ForegroundCommandOutput> {
    let mut command_builder = if cfg!(windows) {
        let mut builder = Command::new("cmd");
        builder.args(["/C", command]);
        builder
    } else {
        let mut builder = Command::new("sh");
        builder.args(["-lc", command]);
        builder
    };

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command_builder.process_group(0);
    }

    let mut child = command_builder
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().expect("stdout was configured as piped");
    let stderr = child.stderr.take().expect("stderr was configured as piped");
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        std::io::BufReader::new(stdout).read_to_end(&mut bytes)?;
        Ok::<_, std::io::Error>(bytes)
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        std::io::BufReader::new(stderr).read_to_end(&mut bytes)?;
        Ok::<_, std::io::Error>(bytes)
    });
    let started = Instant::now();
    let mut timed_out = false;

    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            terminate_process_tree(&mut child)?;
            break child.wait()?;
        }
        thread::sleep(COMMAND_TIMEOUT_POLL_INTERVAL);
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "stdout reader thread panicked"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "stderr reader thread panicked"))??;

    Ok(ForegroundCommandOutput {
        status,
        stdout,
        stderr,
        timed_out,
    })
}

fn terminate_process_tree(child: &mut Child) -> std::io::Result<()> {
    #[cfg(windows)]
    let terminated = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())?;

    #[cfg(unix)]
    let terminated = Command::new("kill")
        .args(["-KILL", "--", &format!("-{}", child.id())])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())?;

    if !terminated {
        if child.try_wait()?.is_none() {
            child.kill()?;
        }
    }
    Ok(())
}

fn blocked_result(
    command: &str,
    cwd: &Path,
    policy: &CommandPolicyAnalysis,
    message: String,
    approval_granted: bool,
) -> CommandResult {
    let lowered_message = message.to_ascii_lowercase();
    CommandResult {
        command: command.to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        risk: policy.risk.clone(),
        status: "blocked".to_string(),
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        message: Some(message.clone()),
        diagnosis: Some(CommandFailureDiagnosis {
            category: if lowered_message.contains("outside the active workspace") {
                "outside_workspace".to_string()
            } else if lowered_message.contains("network") {
                "network_blocked".to_string()
            } else {
                "policy_blocked".to_string()
            },
            severity: "error".to_string(),
            summary: message.clone(),
            next_step: Some(
                if lowered_message.contains("outside the active workspace") {
                    "Run the command inside the current project root or switch to the intended workspace."
                } else if lowered_message.contains("network") {
                    "Use a non-network command or explicitly allow the network action."
                } else {
                    "Choose a narrower safe command or request explicit approval."
                }
                .to_string(),
            ),
        }),
        provenance: Some(build_provenance(
            command,
            cwd,
            policy,
            approval_granted,
            policy.background_detected.unwrap_or(false),
            None,
            Some("Command was blocked before Rust execution.".to_string()),
        )),
        background_job: None,
    }
}

fn synthetic_policy(reason: &str) -> CommandPolicyAnalysis {
    CommandPolicyAnalysis {
        risk: CommandRisk::Dangerous,
        policy_decision: "deny",
        policy_reason: reason.to_string(),
        network_detected: None,
        background_detected: None,
        detection_source: "system",
    }
}

fn build_provenance(
    _command: &str,
    _cwd: &Path,
    policy: &CommandPolicyAnalysis,
    approval_granted: bool,
    background: bool,
    process_id: Option<u32>,
    reason: Option<String>,
) -> CommandExecutionProvenance {
    CommandExecutionProvenance {
        source: if approval_granted {
            "user".to_string()
        } else {
            "system".to_string()
        },
        trigger: if approval_granted {
            "manual".to_string()
        } else {
            "auto_approved".to_string()
        },
        requested_by: Some(if approval_granted {
            "user".to_string()
        } else {
            "system".to_string()
        }),
        approval_source: Some(
            match policy.policy_decision {
                "deny" => "denied",
                "require_approval" if approval_granted => "manual",
                "require_approval" => "none",
                "allow" if approval_granted => "manual",
                "allow" => "policy",
                _ => "unknown",
            }
            .to_string(),
        ),
        policy_decision: Some(policy.policy_decision.to_string()),
        policy_reason: Some(policy.policy_reason.clone()),
        execution_authority: Some("rust".to_string()),
        reason,
        session_id: None,
        request_id: None,
        agent_id: None,
        background: Some(background),
        process_id,
        network_detected: policy.network_detected,
        background_detected: Some(policy.background_detected.unwrap_or(false) || background),
        detection_source: Some(policy.detection_source.to_string()),
        network_detection_source: Some(if policy.network_detected.is_some() {
            policy.detection_source.to_string()
        } else {
            "unknown".to_string()
        }),
        background_detection_source: Some(if policy.background_detected.is_some() || background {
            "heuristic".to_string()
        } else {
            "unknown".to_string()
        }),
        output_summary: None,
        background_tracking_limited: Some(background),
        job_id: process_id.map(|pid| format!("job_{pid}")),
    }
}

fn approval_required_message(command: &str) -> String {
    let mut detail =
        "Command was requested but not executed. Explicit approval is required before Rust terminal execution."
            .to_string();
    if looks_like_network_command(command) {
        detail.push_str(" Network access was detected.");
    }
    if looks_like_background_server(command) {
        detail.push_str(" Background or long-running process behavior was detected.");
    }
    detail
}

fn command_result_message(
    command: &str,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
) -> String {
    if let Some(diagnosis) = diagnose_command_failure(command, exit_code, stdout, stderr) {
        return diagnosis.summary;
    }
    if exit_code == Some(0) {
        "Command executed by Rust terminal authority.".to_string()
    } else {
        format!(
            "Command finished with exit code {}.",
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        )
    }
}

fn diagnose_command_failure(
    command: &str,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
) -> Option<CommandFailureDiagnosis> {
    if exit_code == Some(0) {
        return None;
    }

    let combined = format!("{stdout}\n{stderr}");
    let normalized = combined.to_ascii_lowercase();
    if command
        .trim()
        .to_ascii_lowercase()
        .starts_with("git status")
        && exit_code.unwrap_or(1) != 0
        && normalized.contains("not a git repository")
    {
        return Some(CommandFailureDiagnosis {
            category: "not_git_repository".to_string(),
            severity: "informative".to_string(),
            summary: "This workspace is not a Git repository.".to_string(),
            next_step: Some(
                "Initialize Git or open a Git workspace if you need Git status.".to_string(),
            ),
        });
    }

    if normalized.contains("not recognized as an internal or external command")
        || normalized.contains("command not found")
    {
        return Some(CommandFailureDiagnosis {
            category: "command_not_found".to_string(),
            severity: "error".to_string(),
            summary: "The requested executable was not found in this environment.".to_string(),
            next_step: Some(
                "Check the command name, PATH, or project scripts before retrying.".to_string(),
            ),
        });
    }

    Some(CommandFailureDiagnosis {
        category: "unknown".to_string(),
        severity: "warning".to_string(),
        summary: format!(
            "The command finished with exit code {}.",
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
        next_step: Some("Inspect stdout and stderr to decide the next safe step.".to_string()),
    })
}

fn looks_like_network_command(command: &str) -> bool {
    let normalized = command.to_lowercase();
    [
        "curl",
        "wget",
        "Invoke-WebRequest",
        "iwr ",
        "irm ",
        "npm install",
        "pnpm add",
        "pnpm install",
        "pip install",
        "cargo install",
    ]
    .iter()
    .any(|needle| normalized.contains(&needle.to_lowercase()))
}

fn looks_like_background_server(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    normalized.contains("python -m http.server")
        || normalized.contains("npm run dev")
        || normalized.contains("pnpm dev")
        || normalized.contains("yarn dev")
        || normalized.contains("vite")
        || normalized.contains("next dev")
        || normalized.contains("react-scripts start")
}

fn maybe_redact(text: String, enabled: bool) -> String {
    if !enabled {
        return text;
    }
    let mut redacted = text;
    for marker in [
        "api_key",
        "apikey",
        "token",
        "password",
        "secret",
        "authorization",
    ] {
        redacted = redact_marker(&redacted, marker);
    }
    redacted
}

fn redact_marker(input: &str, marker: &str) -> String {
    input
        .split_whitespace()
        .map(|part| {
            if part.to_lowercase().contains(marker) && (part.contains('=') || part.contains(':')) {
                format!("{}=[REDACTED]", marker)
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::TerminalService;
    use crate::models::SafetySettingsInput;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    #[test]
    fn foreground_command_is_terminated_at_its_timeout() {
        let workspace = temp_workspace();
        let started = Instant::now();
        let command = if cfg!(windows) {
            "ping -n 6 127.0.0.1 > nul"
        } else {
            "sleep 5"
        };
        let result = TerminalService::new().run_command_with_timeout(
            command,
            &workspace,
            &workspace,
            Some(SafetySettingsInput {
                block_dangerous_commands: true,
                redact_secrets: true,
                allow_network_commands: true,
                auto_run_medium_commands: Some(true),
                auto_run_background_commands: Some(true),
                auto_run_network_commands: Some(true),
                approval_granted: Some(true),
            }),
            Duration::from_millis(150),
        );

        assert_eq!(result.status, "timed_out");
        assert_eq!(
            result
                .diagnosis
                .as_ref()
                .map(|diagnosis| diagnosis.category.as_str()),
            Some("timeout")
        );
        assert!(result
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("terminated"));
        assert!(started.elapsed() < Duration::from_secs(3));
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn policy_classified_allowed_command_includes_provenance() {
        let workspace = temp_workspace();
        let service = TerminalService::new();
        let result = service.run_command(
            "node -e \"console.log('ok')\"",
            &workspace,
            &workspace,
            Some(SafetySettingsInput {
                block_dangerous_commands: true,
                redact_secrets: true,
                allow_network_commands: false,
                auto_run_medium_commands: Some(false),
                auto_run_background_commands: Some(false),
                auto_run_network_commands: Some(false),
                approval_granted: None,
            }),
        );
        assert!(matches!(result.status.as_str(), "executed" | "failed"));
        assert_eq!(
            result
                .provenance
                .as_ref()
                .and_then(|provenance| provenance.policy_decision.as_deref()),
            Some("allow")
        );
        assert_eq!(
            result
                .provenance
                .as_ref()
                .and_then(|provenance| provenance.detection_source.as_deref()),
            Some("policy")
        );
        assert_eq!(result.diagnosis.is_none(), true);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn approval_required_command_preserves_heuristic_background_detection() {
        let workspace = temp_workspace();
        let service = TerminalService::new();
        let result = service.run_command(
            "npm run dev",
            &workspace,
            &workspace,
            Some(SafetySettingsInput {
                block_dangerous_commands: true,
                redact_secrets: true,
                allow_network_commands: false,
                auto_run_medium_commands: Some(false),
                auto_run_background_commands: Some(false),
                auto_run_network_commands: Some(false),
                approval_granted: None,
            }),
        );
        assert_eq!(result.status, "approval_required");
        assert_eq!(
            result
                .provenance
                .as_ref()
                .and_then(|provenance| provenance.policy_decision.as_deref()),
            Some("require_approval")
        );
        assert_eq!(
            result
                .provenance
                .as_ref()
                .and_then(|provenance| provenance.background_detected),
            Some(true)
        );
        assert_eq!(
            result
                .diagnosis
                .as_ref()
                .map(|diagnosis| diagnosis.category.as_str()),
            Some("background_command")
        );
        assert_eq!(
            result
                .provenance
                .as_ref()
                .and_then(|provenance| provenance.background_detection_source.as_deref()),
            Some("heuristic")
        );
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn git_status_in_non_git_workspace_returns_informative_diagnosis() {
        let workspace = temp_workspace();
        let service = TerminalService::new();
        let result = service.run_command(
            "git status",
            &workspace,
            &workspace,
            Some(SafetySettingsInput {
                block_dangerous_commands: true,
                redact_secrets: true,
                allow_network_commands: false,
                auto_run_medium_commands: Some(false),
                auto_run_background_commands: Some(false),
                auto_run_network_commands: Some(false),
                approval_granted: None,
            }),
        );
        assert_eq!(result.status, "failed");
        assert_eq!(
            result
                .diagnosis
                .as_ref()
                .map(|diagnosis| diagnosis.category.as_str()),
            Some("not_git_repository")
        );
        assert_eq!(
            result
                .diagnosis
                .as_ref()
                .map(|diagnosis| diagnosis.summary.as_str()),
            Some("This workspace is not a Git repository.")
        );
        let _ = fs::remove_dir_all(&workspace);
    }

    fn temp_workspace() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("hivo-terminal-{}-{}", std::process::id(), unique));
        fs::create_dir_all(&path).expect("workspace");
        path
    }
}
