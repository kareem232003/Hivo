use crate::models::PatchApplyResult;
use crate::services::patch::extract_patch_payload;
use crate::AppState;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub fn apply_runtime_patch(
    session_id: String,
    patch_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<PatchApplyResult, String> {
    apply_runtime_patch_inner(session_id, patch_id, state.inner().as_ref())
}

fn apply_runtime_patch_inner(
    session_id: String,
    patch_id: String,
    state: &AppState,
) -> Result<PatchApplyResult, String> {
    let workspace_path = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned".to_string())?;
        workspace.workspace_path()?
    };
    let payload = {
        let db = state
            .db
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        let approved = db
            .patch_approval_exists_for_session(&session_id, &patch_id)
            .map_err(|err| format!("Failed to load patch approval: {err}"))?;
        let payload = db.patch_payload_for_session(&session_id, &patch_id)
            .map_err(|err| format!("Failed to load patch proposal: {err}"))?;
        eprintln!(
            "patch_apply_lookup proposal_id={} persistence_target=sqlite.session_events lookup_source=session_events lookup_result={} approved={}",
            patch_id,
            if payload.is_some() { "found" } else { "proposal_not_found" },
            approved
        );
        if !approved {
            let error = "patch_not_approved: Rust apply requires a persisted patch.approved event.".to_string();
            record_apply_failure_locked(&db, &session_id, &patch_id, &error)?;
            return Err(error);
        }
        match payload {
            Some(payload) => payload,
            None => {
                let error = "proposal_not_found: Patch proposal not found in Rust session_events (lookup_source=session_events).".to_string();
                record_apply_failure_locked(&db, &session_id, &patch_id, &error)?;
                return Err(error);
            }
        }
    };
    let (patch_text, files_changed) = match extract_patch_payload(&payload, &patch_id) {
        Ok(extracted) => extracted,
        Err(error) => {
            record_apply_failure(state, &session_id, &patch_id, &error)?;
            return Err(error);
        }
    };
    if let Err(error) = state.patch.preflight_patch(&patch_text, &files_changed, &workspace_path) {
        record_apply_failure(state, &session_id, &patch_id, &error)?;
        return Err(error);
    }
    let before_snapshot = state.git.snapshot(&workspace_path, "rust_git_snapshot");
    let apply_started_event_id = append_canonical_runtime_event(
        state,
        &session_id,
        "patch.apply_started",
        &serde_json::json!({
            "sessionId": session_id,
            "patchId": patch_id,
            "status": "started",
            "snapshotSource": "rust_git_snapshot",
            "beforeSnapshotAvailable": before_snapshot.available
        }),
        Some(&patch_id),
    )?;

    if let Err(err) = state.patch.apply_patch(&patch_text, &workspace_path) {
        record_apply_failure(state, &session_id, &patch_id, &err)?;
        return Err(err);
    }

    let after_snapshot = state.git.snapshot(&workspace_path, "rust_git_snapshot");
    eprintln!("patch_apply_result proposal_id={} apply_result=applied", patch_id);
    let reconciliation_event_id = {
        let db = state
            .db
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        db.append_authoritative_session_event(
            &session_id,
            "runtime.patch.applied",
            &serde_json::json!({
                "patchId": patch_id,
                "status": "applied",
                "message": "Patch applied by Rust authority",
                "beforeSnapshot": before_snapshot.clone(),
                "afterSnapshot": after_snapshot.clone(),
                "reconciliationSource": "rust_git_snapshot",
                "provenance": {
                    "executionAuthority": "rust_patch_service"
                }
            })
            .to_string(),
        )
        .map_err(|err| format!("Failed to record patch apply: {err}"))?;
        if after_snapshot.available {
            None
        } else {
            Some(
                append_canonical_runtime_event_locked(
                    &db,
                    &session_id,
                    "patch.reconciled",
                    &serde_json::json!({
                        "sessionId": session_id,
                        "patchId": patch_id,
                        "reconciliation": {
                            "status": "unavailable",
                            "checkedBy": "rust",
                            "evidenceSource": "unavailable",
                            "reason": after_snapshot
                                .unavailable_reason
                                .clone()
                                .unwrap_or_else(|| "Rust could not capture post-apply Git evidence.".to_string())
                        }
                    }),
                    Some(&patch_id),
                )
                .map_err(|err| format!("Failed to append patch reconciliation event: {err}"))?,
            )
        }
    };
    Ok(PatchApplyResult {
        patch_id,
        status: "applied".to_string(),
        message: "Patch applied by Rust authority".to_string(),
        authority: "rust_patch_service".to_string(),
        reconciliation_source: "rust_git_snapshot".to_string(),
        before_snapshot: Some(before_snapshot),
        after_snapshot: Some(after_snapshot),
        durable_event_ids: std::iter::once(apply_started_event_id)
            .chain(reconciliation_event_id.into_iter())
            .collect(),
    })
}

#[tauri::command]
pub fn reject_runtime_patch(
    session_id: String,
    patch_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<PatchApplyResult, String> {
    reject_runtime_patch_inner(session_id, patch_id, state.inner().as_ref())
}

fn reject_runtime_patch_inner(
    session_id: String,
    patch_id: String,
    state: &AppState,
) -> Result<PatchApplyResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.append_authoritative_session_event(
        &session_id,
        "runtime.patch.rejected",
        &serde_json::json!({
            "patchId": patch_id,
            "provenance": {
                "decisionAuthority": "rust_patch_service"
            }
        })
        .to_string(),
    )
    .map_err(|err| format!("Failed to record patch rejection: {err}"))?;
    Ok(PatchApplyResult {
        patch_id,
        status: "rejected".to_string(),
        message: "Patch rejected. No files were changed.".to_string(),
        authority: "rust_patch_service".to_string(),
        reconciliation_source: "unknown".to_string(),
        before_snapshot: None,
        after_snapshot: None,
        durable_event_ids: Vec::new(),
    })
}

fn record_apply_failure(
    state: &AppState,
    session_id: &str,
    patch_id: &str,
    error: &str,
) -> Result<(), String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    record_apply_failure_locked(&db, session_id, patch_id, error)
}

fn record_apply_failure_locked(
    db: &crate::db::DatabaseService,
    session_id: &str,
    patch_id: &str,
    error: &str,
) -> Result<(), String> {
    eprintln!("patch_apply_result proposal_id={} apply_result=apply_failed error={}", patch_id, error);
    db.append_authoritative_session_event(
        session_id,
        "runtime.patch.apply_failed",
        &serde_json::json!({
            "patchId": patch_id,
            "status": "apply_failed",
            "message": error,
            "lookupSource": "sqlite.session_events",
            "provenance": {
                "executionAuthority": "rust_patch_service"
            }
        })
        .to_string(),
    )
    .map_err(|append_err| format!("Failed to record patch apply failure: {append_err}"))
}

fn append_canonical_runtime_event(
    state: &AppState,
    session_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
    correlation_id: Option<&str>,
) -> Result<String, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    append_canonical_runtime_event_locked(&db, session_id, event_type, payload, correlation_id)
        .map_err(|err| format!("Failed to append runtime event: {err}"))
}

fn append_canonical_runtime_event_locked(
    db: &crate::db::DatabaseService,
    session_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
    correlation_id: Option<&str>,
) -> rusqlite::Result<String> {
    let event_id = format!("rt_evt_{}", Uuid::new_v4());
    db.append_runtime_event(crate::db::RuntimeEventInsert {
        id: Some(&event_id),
        session_id,
        sequence: None,
        event_type,
        actor: "rust",
        authority: "rust",
        payload_json: &payload.to_string(),
        created_at: Some(&chrono::Utc::now().to_rfc3339()),
        version: 1,
        correlation_id,
        causation_id: None,
    })?;
    Ok(event_id)
}

#[cfg(test)]
mod tests {
    use super::{apply_runtime_patch_inner, reject_runtime_patch_inner};
    use crate::db::DatabaseService;
    use crate::services::{
        git::GitService, model_provider::ModelProviderService, patch::PatchService,
        project_index::ProjectIndexService, terminal::TerminalService, workspace::WorkspaceService,
    };
    use crate::AppState;
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Mutex;
    use uuid::Uuid;

    const ORIGINAL: &str = "function multiply(a, b) {\n  return a + b;\n}\n";
    const PATCH: &str = "diff --git a/src/calculator.js b/src/calculator.js\n--- a/src/calculator.js\n+++ b/src/calculator.js\n@@ -1,3 +1,3 @@\n function multiply(a, b) {\n-  return a + b;\n+  return a * b;\n }\n";

    #[test]
    fn production_patch_commands_enforce_decisions_and_report_actual_results() {
        let (workspace, state) = fixture("approved");
        let session_id = "session_approved";
        persist_proposal(&state, session_id, "patch_approved", PATCH);
        assert_eq!(
            fs::read_to_string(workspace.join("src/calculator.js")).expect("read proposal source"),
            ORIGINAL,
            "a proposal must not mutate source"
        );
        append_approval(&state, session_id, "patch_approved");
        let applied =
            apply_runtime_patch_inner(session_id.to_string(), "patch_approved".to_string(), &state)
                .expect("approved patch applies");
        assert_eq!(applied.status, "applied");
        assert_eq!(applied.authority, "rust_patch_service");
        assert_eq!(applied.reconciliation_source, "rust_git_snapshot");
        assert!(applied
            .before_snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.available));
        assert!(applied
            .after_snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.available));
        assert_eq!(
            fs::read_to_string(workspace.join("src/calculator.js"))
                .expect("read applied source")
                .replace("\r\n", "\n"),
            "function multiply(a, b) {\n  return a * b;\n}\n"
        );
        let events = state
            .db
            .lock()
            .expect("database")
            .list_runtime_events_for_session(session_id)
            .expect("runtime events");
        assert!(events
            .iter()
            .any(|event| event.payload_json.contains("\"status\":\"applied\"")));
        let _ = fs::remove_dir_all(workspace);

        let (workspace, state) = fixture("rejected");
        let session_id = "session_rejected";
        persist_proposal(&state, session_id, "patch_rejected", PATCH);
        let rejected = reject_runtime_patch_inner(
            session_id.to_string(),
            "patch_rejected".to_string(),
            &state,
        )
        .expect("Rust records rejection");
        assert_eq!(rejected.status, "rejected");
        assert!(apply_runtime_patch_inner(
            session_id.to_string(),
            "patch_rejected".to_string(),
            &state,
        )
        .expect_err("rejected patch cannot apply")
        .contains("patch_not_approved"));
        assert_eq!(
            fs::read_to_string(workspace.join("src/calculator.js")).expect("read rejected source"),
            ORIGINAL
        );
        let _ = fs::remove_dir_all(workspace);

        let (workspace, state) = fixture("approve-reject");
        let session_id = "session_approve_reject";
        persist_proposal(&state, session_id, "patch_revoked", PATCH);
        append_approval(&state, session_id, "patch_revoked");
        reject_runtime_patch_inner(session_id.to_string(), "patch_revoked".to_string(), &state)
            .expect("Rust records revocation");
        assert!(apply_runtime_patch_inner(
            session_id.to_string(),
            "patch_revoked".to_string(),
            &state,
        )
        .expect_err("later rejection revokes approval")
        .contains("patch_not_approved"));
        assert_eq!(
            fs::read_to_string(workspace.join("src/calculator.js")).expect("read revoked source"),
            ORIGINAL
        );
        let _ = fs::remove_dir_all(workspace);

        let (workspace, state) = fixture("stale");
        let session_id = "session_stale";
        let stale_patch = PATCH.replace("-  return a + b;", "-  return a - b;");
        persist_proposal(&state, session_id, "patch_stale", &stale_patch);
        append_approval(&state, session_id, "patch_stale");
        assert!(apply_runtime_patch_inner(
            session_id.to_string(),
            "patch_stale".to_string(),
            &state,
        )
        .expect_err("stale approved patch is rejected")
        .contains("patch_invalid_apply_check_failed"));
        assert_eq!(
            fs::read_to_string(workspace.join("src/calculator.js")).expect("read stale source"),
            ORIGINAL
        );
        let _ = fs::remove_dir_all(workspace);
    }

    fn fixture(label: &str) -> (PathBuf, AppState) {
        let workspace =
            std::env::temp_dir().join(format!("hivo-desktop-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(workspace.join("src")).expect("create fixture");
        fs::write(workspace.join("src/calculator.js"), ORIGINAL).expect("write calculator");
        run_git(&workspace, &["init"]);
        run_git(&workspace, &["config", "user.email", "hivo@example.com"]);
        run_git(&workspace, &["config", "user.name", "Hivo Test"]);
        run_git(&workspace, &["add", "src/calculator.js"]);
        run_git(&workspace, &["commit", "-m", "seed calculator"]);

        let mut workspace_service = WorkspaceService::new();
        workspace_service
            .open_workspace(
                workspace.to_str().expect("workspace path"),
                "fixture".to_string(),
            )
            .expect("open fixture workspace");
        let db = DatabaseService::new_in_memory().expect("isolated database");
        let state = AppState {
            workspace: Mutex::new(workspace_service),
            db: Mutex::new(db),
            git: GitService::new(),
            terminal: TerminalService::new(),
            patch: PatchService::new(),
            index: ProjectIndexService::new(),
            model_provider: ModelProviderService::new(),
        };
        (workspace, state)
    }

    fn persist_proposal(state: &AppState, session_id: &str, patch_id: &str, patch: &str) {
        let db = state.db.lock().expect("database");
        db.create_orchestration_run(
            session_id,
            "Fix calculator multiplication",
            "running",
            "standard",
            "fixture-token",
            "2099-01-01T00:00:00Z",
        )
        .expect("create isolated session");
        db.append_session_event(
            session_id,
            "runtime.patch.proposed",
            &json!({
                "proposal": {
                    "id": patch_id,
                    "title": "Fix multiplication",
                    "filesChanged": [{
                        "path": "src/calculator.js",
                        "changeType": "modify",
                        "explanation": "Correct the multiplication operator."
                    }],
                    "unifiedDiff": patch,
                    "status": "proposed"
                }
            })
            .to_string(),
        )
        .expect("persist proposal through production event format");
    }

    fn append_approval(state: &AppState, session_id: &str, patch_id: &str) {
        state
            .db
            .lock()
            .expect("database")
            .append_session_event(
                session_id,
                "runtime.patch.approved",
                &json!({
                    "patchId": patch_id,
                    "status": "approved"
                })
                .to_string(),
            )
            .expect("persist explicit user approval");
    }

    fn run_git(workspace: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(workspace)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
