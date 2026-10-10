use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde_json::Value;

pub struct PatchService;

impl PatchService {
    pub fn new() -> Self {
        Self
    }

    pub fn get_current_diff(&self, diff_text: String) -> String {
        diff_text
    }

    pub fn apply_patch(&self, patch_text: &str, workspace: &Path) -> Result<(), String> {
        self.validate_patch_paths_inside_workspace(patch_text, workspace)?;
        let canonical_workspace = fs::canonicalize(workspace)
            .map_err(|err| format!("Workspace path is not accessible: {err}"))?;
        let patch_path = temp_patch_path();
        fs::write(&patch_path, patch_document(patch_text))
            .map_err(|err| format!("Failed to stage patch: {err}"))?;
        let output = Command::new("git")
            .args([
                "apply",
                "--whitespace=nowarn",
                patch_path.to_string_lossy().as_ref(),
            ])
            .current_dir(&canonical_workspace)
            .output()
            .map_err(|err| format!("Failed to run git apply: {err}"));
        let _ = fs::remove_file(&patch_path);
        let output = output?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(())
    }

    pub fn preflight_patch(
        &self,
        patch_text: &str,
        files_changed: &[String],
        workspace: &Path,
    ) -> Result<(), String> {
        if patch_text.trim().is_empty() {
            return Err("patch_invalid_missing_diff: Patch proposal must include a non-empty unifiedDiff.".to_string());
        }
        if files_changed.is_empty() {
            return Err("patch_invalid_paths: Patch proposal must include at least one filesChanged entry.".to_string());
        }
        for path in files_changed {
            if is_secret_path(path) {
                return Err(format!("patch_invalid_secret_file: Refusing to patch secret file {path}."));
            }
        }
        self.validate_patch_paths_inside_workspace(patch_text, workspace)
            .map_err(|err| format!("patch_invalid_paths: {err}"))?;
        let diff_paths = extract_diff_paths(patch_text)?;
        let mut declared = files_changed.iter().map(|value| normalize_path(value)).collect::<Vec<_>>();
        let mut from_diff = diff_paths.into_iter().map(|value| normalize_path(&value)).collect::<Vec<_>>();
        declared.sort();
        declared.dedup();
        from_diff.sort();
        from_diff.dedup();
        if declared != from_diff {
            return Err(format!(
                "patch_invalid_paths: filesChanged paths do not match diff headers (declared: {}; diff: {}).",
                declared.join(", "),
                from_diff.join(", ")
            ));
        }
        self.git_apply_check(patch_text, workspace)
    }

    fn git_apply_check(&self, patch_text: &str, workspace: &Path) -> Result<(), String> {
        let canonical_workspace = fs::canonicalize(workspace)
            .map_err(|err| format!("patch_invalid_paths: Workspace path is not accessible: {err}"))?;
        let patch_path = temp_patch_path();
        fs::write(&patch_path, patch_document(patch_text))
            .map_err(|err| format!("patch_invalid_apply_check_failed: Failed to stage patch: {err}"))?;
        let output = Command::new("git")
            .args(["apply", "--check", patch_path.to_string_lossy().as_ref()])
            .current_dir(&canonical_workspace)
            .output();
        let _ = fs::remove_file(&patch_path);
        match output {
            Ok(output) if output.status.success() => Ok(()),
            Ok(output) => Err(format!(
                "patch_invalid_apply_check_failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("patch_invalid_apply_check_failed: Failed to run git apply --check: {err}")),
        }
    }

    pub fn validate_patch_paths_inside_workspace(
        &self,
        patch_text: &str,
        workspace: &Path,
    ) -> Result<(), String> {
        for line in patch_text.lines() {
            if let Some(path) = line
                .strip_prefix("+++ b/")
                .or_else(|| line.strip_prefix("--- a/"))
            {
                let relative = Path::new(path);
                if relative.components().any(|component| {
                    matches!(
                        component,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                }) {
                    return Err("Patch references a path outside the workspace".to_string());
                }
                let canonical_workspace = std::fs::canonicalize(workspace)
                    .map_err(|err| format!("Workspace path is not accessible: {err}"))?;
                let candidate = canonical_workspace.join(relative);
                let parent = candidate.parent().unwrap_or(&canonical_workspace);
                let canonical_parent = if parent.exists() {
                    std::fs::canonicalize(parent)
                        .map_err(|err| format!("Patch path parent is not accessible: {err}"))?
                } else {
                    canonicalize_existing_ancestor(parent, &canonical_workspace)?
                };
                if !canonical_parent.starts_with(&canonical_workspace) {
                    return Err("Patch references a path outside the workspace".to_string());
                }
            }
        }
        Ok(())
    }
}

fn normalize_path(value: &str) -> String {
    value.replace('\\', "/").trim_start_matches("./").to_string()
}

pub fn extract_patch_payload(payload: &str, patch_id: &str) -> Result<(String, Vec<String>), String> {
    let value: Value = serde_json::from_str(payload)
        .map_err(|err| format!("Invalid patch event payload: {err}"))?;
    let proposal = value.get("proposal").unwrap_or(&value);
    if proposal.get("id").and_then(Value::as_str) != Some(patch_id) {
        return Err("Patch event payload did not match requested patch id".to_string());
    }
    let patch_text = proposal
        .get("unifiedDiff")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "patch_invalid_missing_diff: Patch payload does not include unifiedDiff".to_string())?;
    let files_changed = proposal
        .get("filesChanged")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|file| file.get("path").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok((patch_text, files_changed))
}

fn patch_document(value: &str) -> String {
    format!("{}\n", value.trim_end())
}

fn is_secret_path(value: &str) -> bool {
    let normalized = normalize_path(value).to_lowercase();
    let name = Path::new(&normalized)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
        || normalized.split('/').any(|part| part == "secret" || part == "secrets" || part == "credential" || part == "credentials")
}

fn extract_diff_paths(patch_text: &str) -> Result<Vec<String>, String> {
    let lines = patch_text.lines().collect::<Vec<_>>();
    let mut paths = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !line.starts_with("diff --git ") {
            continue;
        }
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() != 4 || !parts[2].starts_with("a/") || !parts[3].starts_with("b/") {
            return Err("patch_invalid_paths: Patch contains a malformed diff --git header.".to_string());
        }
        let old_header = lines.iter().skip(index + 1).take(7).find(|line| line.starts_with("--- "));
        let new_header = lines.iter().skip(index + 1).take(7).find(|line| line.starts_with("+++ "));
        let old_path = match old_header {
            Some(&"--- /dev/null") => None,
            Some(header) => header.strip_prefix("--- a/"),
            None => None,
        };
        let new_path = match new_header {
            Some(&"+++ /dev/null") => None,
            Some(header) => header.strip_prefix("+++ b/"),
            None => None,
        };
        if old_header.is_none()
            || new_header.is_none()
            || (old_path.is_none() && new_path.is_none())
            || old_path.is_some_and(|path| path != &parts[2][2..])
            || new_path.is_some_and(|path| path != &parts[3][2..])
        {
            return Err("patch_invalid_paths: Patch contains malformed or mismatched file headers.".to_string());
        }
        paths.push(new_path.or(old_path).expect("validated diff path").to_string());
    }
    if paths.is_empty() {
        return Err("patch_invalid_paths: Patch does not contain a standard diff --git header.".to_string());
    }
    Ok(paths)
}

fn temp_patch_path() -> PathBuf {
    std::env::temp_dir().join(format!("hivo-patch-{}.diff", uuid::Uuid::new_v4()))
}

fn canonicalize_existing_ancestor(path: &Path, workspace: &Path) -> Result<PathBuf, String> {
    let mut current = path;
    while !current.exists() {
        current = current
            .parent()
            .ok_or_else(|| "Patch path has no existing parent".to_string())?;
    }
    let canonical = std::fs::canonicalize(current)
        .map_err(|err| format!("Patch path parent is not accessible: {err}"))?;
    if !canonical.starts_with(workspace) {
        return Err("Patch references a path outside the workspace".to_string());
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::git::GitService;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn rust_git_snapshot_is_unavailable_for_non_git_workspaces() {
        let workspace = temp_workspace_path("non-git");
        fs::create_dir_all(&workspace).expect("workspace");
        let snapshot = GitService::new().snapshot(&workspace, "rust_git_snapshot");
        assert!(!snapshot.available);
        assert_eq!(snapshot.source, "rust_git_snapshot");
        assert_eq!(snapshot.is_git_repo, Some(false));
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn patch_apply_can_be_observed_with_rust_owned_git_snapshots() {
        let workspace = temp_workspace_path("git-apply");
        fs::create_dir_all(&workspace).expect("workspace");
        run_git_ok(&workspace, &["init"]);
        run_git_ok(&workspace, &["config", "user.email", "hivo@example.com"]);
        run_git_ok(&workspace, &["config", "user.name", "Hivo"]);
        fs::write(workspace.join("README.md"), "hello\n").expect("seed file");
        run_git_ok(&workspace, &["add", "README.md"]);
        run_git_ok(&workspace, &["commit", "-m", "seed"]);

        let git = GitService::new();
        let before = git.snapshot(&workspace, "rust_git_snapshot");
        assert!(before.available);
        assert_eq!(before.changed_files.as_deref(), Some(&[][..]));

        fs::write(workspace.join("README.md"), "hello\nfrom rust\n").expect("mutate file");
        let patch = GitService::new().diff(&workspace);
        run_git_ok(&workspace, &["checkout", "--", "README.md"]);
        PatchService::new()
            .apply_patch(&patch, &workspace)
            .expect("apply patch");

        let after = git.snapshot(&workspace, "rust_git_snapshot");
        assert!(after.available);
        assert_eq!(after.source, "rust_git_snapshot");
        assert_eq!(after.changed_files.as_deref(), Some(&["README.md".to_string()][..]));
        assert_eq!(after.file_stats.as_ref().and_then(|stats| stats.first()).and_then(|stat| stat.additions), Some(1));

        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn preflight_rejects_missing_diff_mismatch_and_secret_files() {
        let workspace = temp_workspace_path("preflight");
        fs::create_dir_all(&workspace).expect("workspace");
        let service = PatchService::new();
        assert!(service
            .preflight_patch("", &["safe.txt".to_string()], &workspace)
            .expect_err("missing diff")
            .starts_with("patch_invalid_missing_diff"));
        let actual_diff = [
            "diff --git a/actual.txt b/actual.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/actual.txt",
            "@@ -0,0 +1 @@",
            "+actual",
        ]
        .join("\n");
        assert!(service
            .preflight_patch(&actual_diff, &["declared.txt".to_string()], &workspace)
            .expect_err("mismatch")
            .starts_with("patch_invalid_paths"));
        assert!(service
            .preflight_patch(&actual_diff.replace("actual.txt", ".env"), &[".env".to_string()], &workspace)
            .expect_err("secret")
            .starts_with("patch_invalid_secret_file"));

        fs::write(workspace.join("stale.txt"), "current\n").expect("seed stale target");
        let stale_diff = [
            "diff --git a/stale.txt b/stale.txt",
            "--- a/stale.txt",
            "+++ b/stale.txt",
            "@@ -1 +1 @@",
            "-expected",
            "+changed",
        ]
        .join("\n");
        assert!(service
            .preflight_patch(&stale_diff, &["stale.txt".to_string()], &workspace)
            .expect_err("stale patch")
            .starts_with("patch_invalid_apply_check_failed"));
        assert_eq!(
            fs::read_to_string(workspace.join("stale.txt")).expect("read stale target"),
            "current\n"
        );
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn patch_truth_smoke_scenario_keeps_proposal_unapplied_until_rust_apply() {
        let workspace = temp_workspace_path("patch-truth-smoke");
        fs::create_dir_all(&workspace).expect("workspace");
        run_git_ok(&workspace, &["init"]);
        run_git_ok(&workspace, &["config", "user.email", "hivo@example.com"]);
        run_git_ok(&workspace, &["config", "user.name", "Hivo"]);
        fs::write(workspace.join("truth.txt"), "before\n").expect("seed file");
        run_git_ok(&workspace, &["add", "truth.txt"]);
        run_git_ok(&workspace, &["commit", "-m", "seed"]);
        let patch = [
            "diff --git a/truth.txt b/truth.txt",
            "--- a/truth.txt",
            "+++ b/truth.txt",
            "@@ -1 +1 @@",
            "-before",
            "+after",
            "",
        ]
        .join("\n");
        let service = PatchService::new();

        service
            .preflight_patch(&patch, &["truth.txt".to_string()], &workspace)
            .expect("proposal preflight");
        assert_eq!(fs::read_to_string(workspace.join("truth.txt")).expect("read before apply"), "before\n");

        service.apply_patch(&patch, &workspace).expect("Rust apply");
        assert_eq!(fs::read_to_string(workspace.join("truth.txt")).expect("read after apply").trim_end(), "after");
        run_git_ok(&workspace, &["diff", "--check"]);
        let _ = fs::remove_dir_all(&workspace);
    }

    fn temp_workspace_path(label: &str) -> PathBuf {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_millis();
        std::env::temp_dir().join(format!("hivo-patch-{label}-{millis}"))
    }

    fn run_git_ok(workspace: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(workspace)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
