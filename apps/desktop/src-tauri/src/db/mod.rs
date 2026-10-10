use crate::models::{AgentStatus, ModelProviderConfig, ModelProviderType, Session, Task};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

const EVENT_AUTHORITY_RUNTIME_BRIDGE: &str = "runtime_bridge";
const EVENT_AUTHORITY_RUST: &str = "rust";
const EVENT_PATCH_PROPOSED: &str = "runtime.patch.proposed";
const EVENT_PATCH_APPROVED: &str = "runtime.patch.approved";
const EVENT_PATCH_APPLY_STARTED: &str = "runtime.patch.apply_started";
const EVENT_PATCH_APPLIED: &str = "runtime.patch.applied";
const EVENT_PATCH_APPLY_FAILED: &str = "runtime.patch.apply_failed";
const EVENT_PATCH_REJECTED: &str = "runtime.patch.rejected";
const EVENT_COMMAND_REQUESTED: &str = "runtime.command.requested";
const EVENT_COMMAND_STARTED: &str = "runtime.command.started";
const EVENT_COMMAND_COMPLETED: &str = "runtime.command.completed";
const EVENT_COMMAND_FAILED: &str = "runtime.command.failed";
const EVENT_COMMAND_BLOCKED: &str = "runtime.command.blocked";
const EVENT_ARTIFACT_CREATED: &str = "runtime.artifact.created";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeEventRecord {
    pub id: String,
    pub session_id: String,
    pub sequence: i64,
    pub event_type: String,
    pub actor: String,
    pub authority: String,
    pub payload_json: String,
    pub created_at: String,
    pub version: i64,
    pub correlation_id: Option<String>,
    pub causation_id: Option<String>,
}

pub struct RuntimeEventInsert<'a> {
    pub id: Option<&'a str>,
    pub session_id: &'a str,
    pub sequence: Option<i64>,
    pub event_type: &'a str,
    pub actor: &'a str,
    pub authority: &'a str,
    pub payload_json: &'a str,
    pub created_at: Option<&'a str>,
    pub version: i64,
    pub correlation_id: Option<&'a str>,
    pub causation_id: Option<&'a str>,
}

pub struct DatabaseService {
    conn: Connection,
}

impl DatabaseService {
    pub fn new() -> rusqlite::Result<Self> {
        let db_path = app_database_path();
        if let Some(parent) = db_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let conn = Connection::open(db_path)?;
        let service = Self { conn };
        service.initialize()?;
        Ok(service)
    }

    #[cfg(test)]
    pub(crate) fn new_in_memory() -> rusqlite::Result<Self> {
        let service = Self {
            conn: Connection::open_in_memory()?,
        };
        service.initialize()?;
        Ok(service)
    }

    fn initialize(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                user_prompt TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id)
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                agent_role TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            );

            CREATE TABLE IF NOT EXISTS agent_runs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                detail TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            );

            CREATE TABLE IF NOT EXISTS tool_calls (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                status TEXT NOT NULL,
                input_summary TEXT,
                output_summary TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            );

            CREATE TABLE IF NOT EXISTS patches (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                title TEXT NOT NULL,
                diff_text TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            );

            CREATE TABLE IF NOT EXISTS project_memory (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id)
            );

            CREATE TABLE IF NOT EXISTS model_provider_config (
                id TEXT PRIMARY KEY,
                provider_type TEXT NOT NULL,
                provider_name TEXT NOT NULL,
                base_url TEXT NOT NULL,
                selected_model TEXT NOT NULL,
                router_model TEXT,
                verifier_model TEXT,
                embedding_model TEXT,
                api_key_configured INTEGER NOT NULL DEFAULT 0,
                is_valid INTEGER NOT NULL DEFAULT 0,
                last_validated_at TEXT,
                last_validation_error TEXT
            );

            CREATE TABLE IF NOT EXISTS orchestration_runs (
                session_id TEXT PRIMARY KEY,
                product_brief TEXT,
                business_brief TEXT,
                technical_plan TEXT,
                assignment_plan TEXT,
                status TEXT NOT NULL,
                trust_profile TEXT,
                token_hash TEXT,
                token_expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                canonical_event_type TEXT,
                authority TEXT,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS command_requests (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                command TEXT NOT NULL,
                risk TEXT NOT NULL,
                reason TEXT,
                status TEXT NOT NULL,
                payload TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS command_results (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                request_id TEXT,
                command TEXT NOT NULL,
                status TEXT NOT NULL,
                exit_code INTEGER,
                stdout TEXT,
                stderr TEXT,
                message TEXT,
                payload TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS background_jobs (
                job_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                request_id TEXT,
                command TEXT NOT NULL,
                cwd TEXT NOT NULL,
                process_id INTEGER,
                status TEXT NOT NULL,
                exit_code INTEGER,
                output_summary TEXT,
                detection_source TEXT,
                payload TEXT,
                source_event_id TEXT,
                source_event_type TEXT,
                source_event_authority TEXT,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                last_known_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS artifacts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                artifact_type TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS runtime_events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                actor TEXT NOT NULL,
                authority TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                version INTEGER NOT NULL,
                correlation_id TEXT,
                causation_id TEXT,
                UNIQUE(session_id, sequence)
            );
            "#,
        )?;
        add_column_if_missing(&self.conn, "agent_runs", "agent_id", "TEXT")?;
        add_column_if_missing(&self.conn, "agent_runs", "role_title", "TEXT")?;
        add_column_if_missing(&self.conn, "agent_runs", "lifecycle_stage", "TEXT")?;
        add_column_if_missing(&self.conn, "agent_runs", "artifact_json", "TEXT")?;
        add_column_if_missing(&self.conn, "agent_runs", "started_at", "TEXT")?;
        add_column_if_missing(&self.conn, "agent_runs", "completed_at", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "updated_at", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "proposal_payload", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "last_event_id", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "last_event_type", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "last_event_authority", "TEXT")?;
        add_column_if_missing(&self.conn, "patches", "last_event_payload", "TEXT")?;
        add_column_if_missing(&self.conn, "session_events", "canonical_event_type", "TEXT")?;
        add_column_if_missing(&self.conn, "session_events", "authority", "TEXT")?;
        add_column_if_missing(&self.conn, "command_requests", "payload", "TEXT")?;
        add_column_if_missing(&self.conn, "command_requests", "updated_at", "TEXT")?;
        add_column_if_missing(&self.conn, "command_requests", "source_event_id", "TEXT")?;
        add_column_if_missing(&self.conn, "command_requests", "source_event_type", "TEXT")?;
        add_column_if_missing(&self.conn, "command_requests", "source_event_authority", "TEXT")?;
        add_column_if_missing(&self.conn, "command_results", "payload", "TEXT")?;
        add_column_if_missing(&self.conn, "command_results", "source_event_id", "TEXT")?;
        add_column_if_missing(&self.conn, "command_results", "source_event_type", "TEXT")?;
        add_column_if_missing(&self.conn, "command_results", "source_event_authority", "TEXT")?;
        add_column_if_missing(&self.conn, "background_jobs", "payload", "TEXT")?;
        add_column_if_missing(&self.conn, "background_jobs", "source_event_id", "TEXT")?;
        add_column_if_missing(&self.conn, "background_jobs", "source_event_type", "TEXT")?;
        add_column_if_missing(&self.conn, "background_jobs", "source_event_authority", "TEXT")?;
        add_column_if_missing(&self.conn, "model_provider_config", "embedding_model", "TEXT")?;
        add_column_if_missing(&self.conn, "model_provider_config", "router_model", "TEXT")?;
        add_column_if_missing(&self.conn, "model_provider_config", "verifier_model", "TEXT")?;
        self.backfill_event_metadata()?;
        Ok(())
    }

    pub fn upsert_project(&self, name: &str, path: &str) -> rusqlite::Result<String> {
        let now = Utc::now().to_rfc3339();
        if let Some(id) = self
            .conn
            .query_row(
                "SELECT id FROM projects WHERE path = ?1",
                params![path],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            self.conn.execute(
                "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![name, &now, &id],
            )?;
            return Ok(id);
        }

        let id = Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&id, name, path, &now, &now],
        )?;
        Ok(id)
    }

    pub fn create_mock_session(
        &self,
        project_id: Option<String>,
        user_prompt: &str,
    ) -> rusqlite::Result<crate::models::CreateSessionResponse> {
        let now = Utc::now().to_rfc3339();
        let session = Session {
            id: Uuid::new_v4().to_string(),
            project_id,
            user_prompt: user_prompt.to_string(),
            status: "planning".to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };

        self.conn.execute(
            "INSERT INTO sessions (id, project_id, user_prompt, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &session.id,
                &session.project_id,
                &session.user_prompt,
                &session.status,
                &session.created_at,
                &session.updated_at
            ],
        )?;

        let tasks = vec![
            Task {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                title: "Analyze project".to_string(),
                status: "todo".to_string(),
                agent_role: Some("Engineering Orchestrator".to_string()),
                created_at: now.clone(),
            },
            Task {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                title: "Create technical plan".to_string(),
                status: "todo".to_string(),
                agent_role: Some("Engineering Orchestrator".to_string()),
                created_at: now.clone(),
            },
            Task {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                title: "Prepare patch proposal".to_string(),
                status: "todo".to_string(),
                agent_role: Some("Engineering Orchestrator".to_string()),
                created_at: now.clone(),
            },
        ];

        for task in &tasks {
            self.conn.execute(
                "INSERT INTO tasks (id, session_id, title, status, agent_role, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &task.id,
                    &task.session_id,
                    &task.title,
                    &task.status,
                    &task.agent_role,
                    &task.created_at
                ],
            )?;
        }

        let agents = vec![
            AgentStatus {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                name: "Product Orchestrator".to_string(),
                status: "done".to_string(),
                detail: Some("Mock product framing complete".to_string()),
            },
            AgentStatus {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                name: "Business Orchestrator".to_string(),
                status: "done".to_string(),
                detail: Some("Mock business constraints reviewed".to_string()),
            },
            AgentStatus {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                name: "Engineering Orchestrator".to_string(),
                status: "planning".to_string(),
                detail: Some("Preparing technical plan".to_string()),
            },
        ];

        for agent in &agents {
            self.conn.execute(
                "INSERT INTO agent_runs (id, session_id, name, status, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &agent.id,
                    &agent.session_id,
                    &agent.name,
                    &agent.status,
                    &agent.detail,
                    &now
                ],
            )?;
        }

        Ok(crate::models::CreateSessionResponse {
            session,
            tasks,
            agents,
        })
    }

    pub fn tasks_for_session(&self, session_id: &str) -> rusqlite::Result<Vec<Task>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, title, status, agent_role, created_at FROM tasks WHERE session_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(Task {
                id: row.get(0)?,
                session_id: row.get(1)?,
                title: row.get(2)?,
                status: row.get(3)?,
                agent_role: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn agents_for_session(&self, session_id: &str) -> rusqlite::Result<Vec<AgentStatus>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, name, status, detail FROM agent_runs WHERE session_id = ?1 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(AgentStatus {
                id: row.get(0)?,
                session_id: row.get(1)?,
                name: row.get(2)?,
                status: row.get(3)?,
                detail: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn save_model_provider_config(&self, config: &ModelProviderConfig) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM model_provider_config", [])?;
        self.conn.execute(
            "INSERT INTO model_provider_config (id, provider_type, provider_name, base_url, selected_model, router_model, verifier_model, embedding_model, api_key_configured, is_valid, last_validated_at, last_validation_error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                config.id,
                provider_type_to_str(&config.provider_type),
                &config.provider_name,
                &config.base_url,
                &config.selected_model,
                &config.router_model,
                &config.verifier_model,
                &config.embedding_model,
                i64::from(config.api_key_configured),
                i64::from(config.is_valid),
                &config.last_validated_at,
                &config.last_validation_error
            ],
        )?;
        Ok(())
    }

    pub fn get_model_provider_config(&self) -> rusqlite::Result<Option<ModelProviderConfig>> {
        self.conn
            .query_row(
                "SELECT id, provider_type, provider_name, base_url, selected_model, router_model, verifier_model, embedding_model, api_key_configured, is_valid, last_validated_at, last_validation_error FROM model_provider_config LIMIT 1",
                [],
                |row| {
                    let provider_type: String = row.get(1)?;
                    Ok(ModelProviderConfig {
                        id: row.get(0)?,
                        provider_type: provider_type_from_str(&provider_type),
                        provider_name: row.get(2)?,
                        base_url: row.get(3)?,
                        selected_model: row.get(4)?,
                        router_model: row.get(5)?,
                        verifier_model: row.get(6)?,
                        embedding_model: row.get(7)?,
                        api_key_configured: row.get::<_, i64>(8)? == 1,
                        is_valid: row.get::<_, i64>(9)? == 1,
                        last_validated_at: row.get(10)?,
                        last_validation_error: row.get(11)?,
                    })
                },
            )
            .optional()
    }

    pub fn clear_model_provider_config(&self) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM model_provider_config", [])?;
        Ok(())
    }

    pub fn create_orchestration_run(
        &self,
        session_id: &str,
        user_prompt: &str,
        status: &str,
        trust_profile: &str,
        token_hash: &str,
        token_expires_at: &str,
    ) -> rusqlite::Result<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT OR REPLACE INTO orchestration_runs (session_id, status, trust_profile, token_hash, token_expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT created_at FROM orchestration_runs WHERE session_id = ?1), ?6), ?6)",
            params![session_id, status, trust_profile, token_hash, token_expires_at, &now],
        )?;
        self.conn.execute(
            "INSERT OR IGNORE INTO sessions (id, project_id, user_prompt, status, created_at, updated_at) VALUES (?1, NULL, ?2, ?3, ?4, ?4)",
            params![session_id, user_prompt, status, &now],
        )?;
        let payload = serde_json::json!({
            "sessionId": session_id,
            "status": status,
            "trustProfile": trust_profile
        })
        .to_string();
        self.append_runtime_event(RuntimeEventInsert {
            id: None,
            session_id,
            sequence: None,
            event_type: "session.created",
            actor: "system",
            authority: "rust",
            payload_json: &payload,
            created_at: Some(&now),
            version: 1,
            correlation_id: None,
            causation_id: None,
        })?;
        Ok(())
    }

    pub fn append_runtime_event(
        &self,
        input: RuntimeEventInsert<'_>,
    ) -> rusqlite::Result<RuntimeEventRecord> {
        let id = input
            .id
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let created_at = input
            .created_at
            .map(str::to_string)
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        let sequence = match input.sequence {
            Some(sequence) => sequence,
            None => self.get_latest_runtime_event_sequence(input.session_id)? + 1,
        };
        self.conn.execute(
            "INSERT INTO runtime_events (id, session_id, sequence, event_type, actor, authority, payload_json, created_at, version, correlation_id, causation_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &id,
                input.session_id,
                sequence,
                input.event_type,
                input.actor,
                input.authority,
                input.payload_json,
                &created_at,
                input.version,
                input.correlation_id,
                input.causation_id
            ],
        )?;
        Ok(RuntimeEventRecord {
            id,
            session_id: input.session_id.to_string(),
            sequence,
            event_type: input.event_type.to_string(),
            actor: input.actor.to_string(),
            authority: input.authority.to_string(),
            payload_json: input.payload_json.to_string(),
            created_at,
            version: input.version,
            correlation_id: input.correlation_id.map(str::to_string),
            causation_id: input.causation_id.map(str::to_string),
        })
    }

    pub fn list_runtime_events_for_session(
        &self,
        session_id: &str,
    ) -> rusqlite::Result<Vec<RuntimeEventRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, sequence, event_type, actor, authority, payload_json, created_at, version, correlation_id, causation_id FROM runtime_events WHERE session_id = ?1 ORDER BY sequence ASC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(RuntimeEventRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                sequence: row.get(2)?,
                event_type: row.get(3)?,
                actor: row.get(4)?,
                authority: row.get(5)?,
                payload_json: row.get(6)?,
                created_at: row.get(7)?,
                version: row.get(8)?,
                correlation_id: row.get(9)?,
                causation_id: row.get(10)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_saved_runtime_session_snapshot(
        &self,
        session_id: &str,
    ) -> rusqlite::Result<Option<Value>> {
        let payload = self
            .conn
            .query_row(
                "SELECT payload FROM session_events WHERE session_id = ?1 AND event_type IN ('runtime.session.updated', 'runtime.session.created', 'runtime.session.restored', 'runtime.session.completed', 'runtime.session.failed', 'runtime.session.expired') ORDER BY created_at DESC LIMIT 1",
                params![session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(payload) = payload else {
            return Ok(None);
        };
        let parsed = match serde_json::from_str::<Value>(&payload) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        Ok(parsed.get("session").cloned())
    }

    pub fn get_latest_runtime_event_sequence(&self, session_id: &str) -> rusqlite::Result<i64> {
        self.conn.query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM runtime_events WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
    }

    pub fn append_session_event(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
    ) -> rusqlite::Result<()> {
        self.append_session_event_with_authority(
            session_id,
            event_type,
            payload,
            EVENT_AUTHORITY_RUNTIME_BRIDGE,
        )
    }

    pub fn append_authoritative_session_event(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
    ) -> rusqlite::Result<()> {
        self.append_session_event_with_authority(session_id, event_type, payload, EVENT_AUTHORITY_RUST)
    }

    fn append_session_event_with_authority(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
        authority: &str,
    ) -> rusqlite::Result<()> {
        let now = Utc::now().to_rfc3339();
        let event_id = Uuid::new_v4().to_string();
        let canonical_event_type = canonical_event_type(event_type);
        self.conn.execute(
            "INSERT INTO session_events (id, session_id, event_type, canonical_event_type, authority, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![event_id, session_id, event_type, canonical_event_type, authority, payload, &now],
        )?;
        self.append_derived_runtime_events(
            session_id,
            event_type,
            canonical_event_type,
            authority,
            payload,
            &now,
            &event_id,
        )?;
        self.persist_event_projection(
            &event_id,
            session_id,
            canonical_event_type,
            payload,
            &now,
            authority,
        )?;
        Ok(())
    }

    fn append_derived_runtime_events(
        &self,
        session_id: &str,
        event_type: &str,
        canonical_event_type: &str,
        authority: &str,
        payload: &str,
        created_at: &str,
        causation_id: &str,
    ) -> rusqlite::Result<()> {
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            return Ok(());
        };
        for derived in derived_runtime_events(
            session_id,
            event_type,
            canonical_event_type,
            authority,
            &value,
        ) {
            let payload_json = derived.payload.to_string();
            self.append_runtime_event(RuntimeEventInsert {
                id: None,
                session_id,
                sequence: None,
                event_type: derived.event_type,
                actor: derived.actor,
                authority: derived.authority,
                payload_json: &payload_json,
                created_at: Some(created_at),
                version: 1,
                correlation_id: derived.correlation_id,
                causation_id: Some(causation_id),
            })?;
        }
        Ok(())
    }

    fn backfill_event_metadata(&self) -> rusqlite::Result<()> {
        let mut stmt = self.conn.prepare(
            "SELECT id, event_type, canonical_event_type, authority FROM session_events",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        let rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;

        for row in rows {
            let (id, event_type, canonical, authority) = row;
            let canonical = canonical.unwrap_or_else(|| canonical_event_type(&event_type).to_string());
            let authority = authority.unwrap_or_else(|| EVENT_AUTHORITY_RUNTIME_BRIDGE.to_string());
            self.conn.execute(
                "UPDATE session_events SET canonical_event_type = ?2, authority = ?3 WHERE id = ?1",
                params![id, canonical, authority],
            )?;
        }
        Ok(())
    }

    fn persist_event_projection(
        &self,
        event_id: &str,
        session_id: &str,
        event_type: &str,
        payload: &str,
        now: &str,
        authority: &str,
    ) -> rusqlite::Result<()> {
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            return Ok(());
        };
        if event_type == EVENT_PATCH_PROPOSED {
            if let Some(proposal) = value.get("proposal").or(Some(&value)) {
                if let (Some(id), Some(title), Some(diff)) = (
                    proposal.get("id").and_then(Value::as_str),
                    proposal.get("title").and_then(Value::as_str),
                    proposal.get("unifiedDiff").and_then(Value::as_str),
                ) {
                    let status = proposal
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("proposed");
                    self.upsert_patch_status(
                        session_id,
                        id,
                        title,
                        diff,
                        status,
                        &proposal.to_string(),
                        event_id,
                        event_type,
                        authority,
                        payload,
                        now,
                    )?;
                }
            }
        }
        if event_type == EVENT_PATCH_APPROVED
            || event_type == EVENT_PATCH_APPLY_STARTED
            || event_type == EVENT_PATCH_APPLIED
            || event_type == EVENT_PATCH_APPLY_FAILED
            || event_type == EVENT_PATCH_REJECTED
        {
            if let Some(patch_id) =
                resolve_patch_event_id(&value, event_type, authority)
            {
                let status = match event_type {
                    EVENT_PATCH_APPROVED => Some("approved"),
                    EVENT_PATCH_APPLY_STARTED => Some("apply_started"),
                    EVENT_PATCH_APPLIED => value
                        .get("status")
                        .and_then(Value::as_str)
                        .or(Some("applied")),
                    EVENT_PATCH_APPLY_FAILED => Some("apply_failed"),
                    EVENT_PATCH_REJECTED => Some("rejected"),
                    _ => None,
                };
                if let Some(status) = status {
                    self.update_patch_status(
                        session_id,
                        &patch_id,
                        status,
                        event_id,
                        event_type,
                        authority,
                        payload,
                        now,
                    )?;
                }
            }
        }
        if event_type == EVENT_COMMAND_REQUESTED {
            if let Some(request) = value.get("commandRequest").or(Some(&value)) {
                if let (Some(id), Some(command), Some(risk)) = (
                    request.get("id").and_then(Value::as_str),
                    request.get("command").and_then(Value::as_str),
                    request.get("risk").and_then(Value::as_str),
                ) {
                    let status = request
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("requested");
                    self.conn.execute(
                        "INSERT OR REPLACE INTO command_requests (id, session_id, command, risk, reason, status, payload, source_event_id, source_event_type, source_event_authority, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE((SELECT created_at FROM command_requests WHERE id = ?1), ?11), ?11)",
                        params![
                            id,
                            session_id,
                            command,
                            risk,
                            request.get("reason").and_then(Value::as_str),
                            status,
                            request.to_string(),
                            event_id,
                            event_type,
                            authority,
                            now
                        ],
                    )?;
                }
            }
        }
        if event_type == EVENT_COMMAND_COMPLETED || event_type == EVENT_COMMAND_FAILED {
            if let Some(result) = resolve_command_result_payload(&value, authority) {
                self.conn.execute(
                    "INSERT INTO command_results (id, session_id, request_id, command, status, exit_code, stdout, stderr, message, payload, source_event_id, source_event_type, source_event_authority, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    params![
                        Uuid::new_v4().to_string(),
                        session_id,
                        result.request_id,
                        result.command,
                        result.status,
                        result.exit_code,
                        result.stdout,
                        result.stderr,
                        result.message,
                        value.to_string(),
                        event_id,
                        event_type,
                        authority,
                        now
                    ],
                )?;
                if let Some(request_id) = result.request_id {
                    self.update_command_request_status(
                        session_id,
                        request_id,
                        command_request_status_from_result(result.status),
                        now,
                    )?;
                }
            }
        }
        if event_type == EVENT_COMMAND_STARTED {
            if let Some(result) = resolve_command_result_payload(&value, authority) {
                if let Some(request_id) = result.request_id {
                    self.update_command_request_status(
                        session_id,
                        request_id,
                        command_request_status_from_result(result.status),
                        now,
                    )?;
                }
            }
        }
        if event_type == EVENT_COMMAND_STARTED
            || event_type == EVENT_COMMAND_COMPLETED
            || event_type == EVENT_COMMAND_FAILED
        {
            if let Some(job) = resolve_background_job_payload(&value, session_id, now) {
                self.conn.execute(
                    "INSERT OR REPLACE INTO background_jobs (job_id, session_id, request_id, command, cwd, process_id, status, exit_code, output_summary, detection_source, payload, source_event_id, source_event_type, source_event_authority, started_at, completed_at, last_known_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, COALESCE((SELECT started_at FROM background_jobs WHERE job_id = ?1), ?15), ?16, ?17)",
                    params![
                        job.job_id,
                        job.session_id,
                        job.request_id,
                        job.command,
                        job.cwd,
                        job.process_id,
                        job.status,
                        job.exit_code,
                        job.output_summary,
                        job.detection_source,
                        value.to_string(),
                        event_id,
                        event_type,
                        authority,
                        job.started_at,
                        job.completed_at,
                        job.last_known_at
                    ],
                )?;
            }
        }
        if event_type == EVENT_ARTIFACT_CREATED {
            if let Some(artifact) = value.get("artifact").or(Some(&value)) {
                if let (Some(id), Some(artifact_type), Some(title)) = (
                    artifact.get("id").and_then(Value::as_str),
                    artifact.get("type").and_then(Value::as_str),
                    artifact.get("title").and_then(Value::as_str),
                ) {
                    self.conn.execute(
                        "INSERT OR REPLACE INTO artifacts (id, session_id, artifact_type, title, summary, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE((SELECT created_at FROM artifacts WHERE id = ?1), ?7))",
                        params![
                            id,
                            session_id,
                            artifact_type,
                            title,
                            artifact.get("summary").and_then(Value::as_str),
                            artifact.to_string(),
                            now
                        ],
                    )?;
                }
            }
        }
        Ok(())
    }

    fn upsert_patch_status(
        &self,
        session_id: &str,
        patch_id: &str,
        title: &str,
        diff: &str,
        status: &str,
        proposal_payload: &str,
        last_event_id: &str,
        last_event_type: &str,
        last_event_authority: &str,
        last_event_payload: &str,
        now: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO patches (id, session_id, title, diff_text, status, proposal_payload, last_event_id, last_event_type, last_event_authority, last_event_payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE((SELECT created_at FROM patches WHERE id = ?1), ?11), ?11)",
            params![
                patch_id,
                session_id,
                title,
                diff,
                status,
                proposal_payload,
                last_event_id,
                last_event_type,
                last_event_authority,
                last_event_payload,
                now
            ],
        )?;
        Ok(())
    }

    pub fn update_patch_status(
        &self,
        session_id: &str,
        patch_id: &str,
        status: &str,
        last_event_id: &str,
        last_event_type: &str,
        last_event_authority: &str,
        last_event_payload: &str,
        now: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE patches SET status = ?3, last_event_id = ?4, last_event_type = ?5, last_event_authority = ?6, last_event_payload = ?7, updated_at = ?8 WHERE session_id = ?1 AND id = ?2",
            params![session_id, patch_id, status, last_event_id, last_event_type, last_event_authority, last_event_payload, now],
        )?;
        Ok(())
    }

    fn update_command_request_status(
        &self,
        session_id: &str,
        request_id: &str,
        status: &str,
        now: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE command_requests SET status = ?3, updated_at = ?4 WHERE session_id = ?1 AND id = ?2",
            params![session_id, request_id, status, now],
        )?;
        Ok(())
    }

    pub fn upsert_orchestration_run(
        &self,
        session_id: &str,
        status: &str,
        product_brief: Option<&str>,
        business_brief: Option<&str>,
        technical_plan: Option<&str>,
        assignment_plan: Option<&str>,
    ) -> rusqlite::Result<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE orchestration_runs SET status = ?2, product_brief = COALESCE(?3, product_brief), business_brief = COALESCE(?4, business_brief), technical_plan = COALESCE(?5, technical_plan), assignment_plan = COALESCE(?6, assignment_plan), updated_at = ?7 WHERE session_id = ?1",
            params![session_id, status, product_brief, business_brief, technical_plan, assignment_plan, &now],
        )?;
        Ok(())
    }

    pub fn upsert_agent_run(
        &self,
        session_id: &str,
        agent_id: &str,
        role_title: &str,
        lifecycle_stage: &str,
        artifact_json: Option<&str>,
        status: &str,
    ) -> rusqlite::Result<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO agent_runs (id, session_id, name, status, detail, created_at, agent_id, role_title, lifecycle_stage, artifact_json, started_at, completed_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?1, ?3, ?6, ?7, ?5, CASE WHEN ?4 IN ('completed','blocked','failed') THEN ?5 ELSE NULL END) ON CONFLICT(id) DO UPDATE SET status = excluded.status, role_title = excluded.role_title, lifecycle_stage = excluded.lifecycle_stage, artifact_json = excluded.artifact_json, completed_at = excluded.completed_at",
            params![agent_id, session_id, role_title, status, &now, lifecycle_stage, artifact_json],
        )?;
        Ok(())
    }

    pub fn patch_payload_for_session(
        &self,
        session_id: &str,
        patch_id: &str,
    ) -> rusqlite::Result<Option<String>> {
        self.conn.query_row(
            "SELECT payload FROM session_events WHERE session_id = ?1 AND (COALESCE(canonical_event_type, event_type) = ?2 OR event_type = 'patch.proposed') AND payload LIKE ?3 ORDER BY created_at DESC LIMIT 1",
            params![session_id, EVENT_PATCH_PROPOSED, format!("%{}%", patch_id)],
            |row| row.get::<_, String>(0),
        ).optional()
    }

    pub fn patch_approval_exists_for_session(
        &self,
        session_id: &str,
        patch_id: &str,
    ) -> rusqlite::Result<bool> {
        let mut statement = self.conn.prepare(
            "SELECT COALESCE(canonical_event_type, event_type), payload FROM session_events WHERE session_id = ?1 AND COALESCE(canonical_event_type, event_type) IN (?2, ?3) ORDER BY rowid",
        )?;
        let events = statement.query_map(
            params![session_id, EVENT_PATCH_APPROVED, EVENT_PATCH_REJECTED],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        let mut latest_decision = None;
        for event in events {
            let (event_type, payload) = event?;
            let Ok(value) = serde_json::from_str::<Value>(&payload) else {
                continue;
            };
            let event_patch_id = value
                .get("patchId")
                .or_else(|| value.get("patch_id"))
                .and_then(Value::as_str)
                .or_else(|| {
                    value
                        .get("proposal")
                        .and_then(|proposal| proposal.get("id"))
                        .and_then(Value::as_str)
                })
                .or_else(|| value.get("id").and_then(Value::as_str));
            if event_patch_id != Some(patch_id) {
                continue;
            }
            latest_decision = Some(event_type == EVENT_PATCH_APPROVED);
        }
        Ok(latest_decision.unwrap_or(false))
    }
}

fn canonical_event_type(event_type: &str) -> &str {
    match event_type {
        "patch.proposed" | EVENT_PATCH_PROPOSED => EVENT_PATCH_PROPOSED,
        "patch.approved" | EVENT_PATCH_APPROVED => EVENT_PATCH_APPROVED,
        "patch.apply_started" | EVENT_PATCH_APPLY_STARTED => EVENT_PATCH_APPLY_STARTED,
        "apply.completed" | EVENT_PATCH_APPLIED => EVENT_PATCH_APPLIED,
        "patch.apply_failed" | EVENT_PATCH_APPLY_FAILED => EVENT_PATCH_APPLY_FAILED,
        "patch.rejected" | EVENT_PATCH_REJECTED => EVENT_PATCH_REJECTED,
        "command.completed" | EVENT_COMMAND_COMPLETED => EVENT_COMMAND_COMPLETED,
        EVENT_COMMAND_REQUESTED => EVENT_COMMAND_REQUESTED,
        EVENT_ARTIFACT_CREATED => EVENT_ARTIFACT_CREATED,
        _ => event_type,
    }
}

struct DerivedRuntimeEvent<'a> {
    event_type: &'a str,
    actor: &'a str,
    authority: &'a str,
    correlation_id: Option<&'a str>,
    payload: Value,
}

fn derived_runtime_events<'a>(
    session_id: &'a str,
    raw_event_type: &'a str,
    canonical_event_type: &'a str,
    authority: &'a str,
    value: &'a Value,
) -> Vec<DerivedRuntimeEvent<'a>> {
    let durable_authority = durable_runtime_event_authority(authority);
    let mut events = Vec::new();

    if let Some(event_type) = durable_runtime_event_type(raw_event_type, canonical_event_type) {
        if let Some(payload) = durable_runtime_payload(event_type, session_id, value) {
            events.push(DerivedRuntimeEvent {
                event_type,
                actor: durable_runtime_event_actor(event_type, authority),
                authority: durable_authority,
                correlation_id: durable_runtime_event_correlation_id(event_type, value),
                payload,
            });
        }
    }

    if raw_event_type == "runtime.session.updated" {
        if let Some(session) = value.get("session") {
            if let Some(review_gate) = session.get("reviewGate") {
                events.push(DerivedRuntimeEvent {
                    event_type: "review_gate.updated",
                    actor: "runtime",
                    authority: durable_authority,
                    correlation_id: None,
                    payload: serde_json::json!({
                        "sessionId": session_id,
                        "reviewGate": review_gate
                    }),
                });
            }
            if let Some(reconciliation) = session.get("reconciliationReport") {
                let derived_type = match reconciliation
                    .get("status")
                    .and_then(Value::as_str)
                {
                    Some("pending") => Some("session.reconciliation_required"),
                    Some("matched") | Some("diverged") | Some("unavailable") | Some("failed") => {
                        Some("patch.reconciled")
                    }
                    _ => None,
                };
                if let Some(event_type) = derived_type {
                    events.push(DerivedRuntimeEvent {
                        event_type,
                        actor: "runtime",
                        authority: durable_authority,
                        correlation_id: reconciliation.get("patchId").and_then(Value::as_str),
                        payload: serde_json::json!({
                            "sessionId": session_id,
                            "reconciliationReport": reconciliation
                        }),
                    });
                }
            }
        }
    }

    events
}

fn durable_runtime_event_type<'a>(
    raw_event_type: &'a str,
    canonical_event_type: &'a str,
) -> Option<&'static str> {
    match raw_event_type {
        "runtime.session.created" => Some("session.created"),
        "runtime.session.restored" => Some("session.restored"),
        "runtime.session.expired" => Some("session.expired"),
        "runtime.product_spec.proposed" => Some("product_spec.proposed"),
        "runtime.product_spec.approved" => Some("product_spec.approved"),
        "runtime.technical_plan.proposed" => Some("technical_plan.proposed"),
        "runtime.technical_plan.approved" => Some("technical_plan.approved"),
        "runtime.recursive_graph.proposed" => Some("recursive_graph.proposed"),
        "runtime.recursive_graph.ready" => Some("recursive_graph.ready"),
        "runtime.recursive_graph.blocked" => Some("recursive_graph.blocked"),
        "runtime.branch_orchestrator.planned" => Some("branch_orchestrator.planned"),
        "runtime.branch_scope.conflict_detected" => Some("branch_scope.conflict_detected"),
        "runtime.patch.proposed" | "patch.proposed" => Some("patch.proposed"),
        "runtime.patch.approved" | "patch.approved" => Some("patch.approved"),
        "runtime.patch.apply_started" | "patch.apply_started" => Some("patch.apply_started"),
        "runtime.patch.rejected" | "patch.rejected" => Some("patch.rejected"),
        "runtime.patch.applied" | "apply.completed" => Some("patch.applied"),
        "runtime.patch.apply_failed" | "patch.apply_failed" => Some("patch.apply_failed"),
        "runtime.command.requested" => Some("command.requested"),
        "runtime.command.started" => Some("command.started"),
        "runtime.command.completed" | "command.completed" => Some("command.completed"),
        "runtime.command.failed" => Some("command.failed"),
        "runtime.verification.pending" | "runtime.verification.running" => Some("verification.started"),
        "runtime.verification.passed"
        | "runtime.verification.failed"
        | "runtime.verification.not_run"
        | "runtime.verification.skipped"
        | "runtime.verification.unavailable" => Some("verification.completed"),
        _ => match canonical_event_type {
            EVENT_PATCH_PROPOSED => Some("patch.proposed"),
            EVENT_PATCH_APPROVED => Some("patch.approved"),
            EVENT_PATCH_APPLY_STARTED => Some("patch.apply_started"),
            EVENT_PATCH_REJECTED => Some("patch.rejected"),
            EVENT_PATCH_APPLIED => Some("patch.applied"),
            EVENT_PATCH_APPLY_FAILED => Some("patch.apply_failed"),
            EVENT_COMMAND_REQUESTED => Some("command.requested"),
            EVENT_COMMAND_STARTED => Some("command.started"),
            EVENT_COMMAND_COMPLETED => Some("command.completed"),
            EVENT_COMMAND_FAILED | EVENT_COMMAND_BLOCKED => Some("command.failed"),
            _ => None,
        },
    }
}

fn durable_runtime_event_actor(event_type: &str, authority: &str) -> &'static str {
    match event_type {
        "patch.approved" | "patch.rejected" | "command.approved" | "command.denied" => "user",
        _ => match authority {
            EVENT_AUTHORITY_RUST => "rust",
            EVENT_AUTHORITY_RUNTIME_BRIDGE => "desktop_bridge",
            _ => "system",
        },
    }
}

fn durable_runtime_event_authority(authority: &str) -> &'static str {
    match authority {
        EVENT_AUTHORITY_RUST => "rust",
        EVENT_AUTHORITY_RUNTIME_BRIDGE => "runtime_bridge",
        _ => "system",
    }
}

fn durable_runtime_event_correlation_id<'a>(
    event_type: &str,
    value: &'a Value,
) -> Option<&'a str> {
    match event_type {
        "patch.proposed" | "patch.approved" | "patch.rejected" | "patch.applied" | "patch.apply_failed" | "patch.reconciled" => value
            .get("patchId")
            .or_else(|| value.get("patch_id"))
            .or_else(|| value.get("proposal").and_then(|proposal| proposal.get("id")))
            .and_then(Value::as_str),
        "command.requested" | "command.started" | "command.completed" | "command.failed" => value
            .get("requestId")
            .or_else(|| value.get("commandRequest").and_then(|request| request.get("id")))
            .or_else(|| value.get("execution").and_then(|execution| execution.get("requestId")))
            .and_then(Value::as_str),
        _ => None,
    }
}

fn durable_runtime_payload(
    event_type: &str,
    session_id: &str,
    value: &Value,
) -> Option<Value> {
    match event_type {
        "product_spec.proposed" | "product_spec.approved" => value.get("productSpec").map(|product_spec| {
            serde_json::json!({
                "sessionId": session_id,
                "productSpec": product_spec
            })
        }),
        "technical_plan.proposed" | "technical_plan.approved" => value.get("technicalPlan").map(|technical_plan| {
            serde_json::json!({
                "sessionId": session_id,
                "technicalPlan": technical_plan
            })
        }),
        "recursive_graph.proposed" | "recursive_graph.ready" | "recursive_graph.blocked" => value.get("graph").map(|graph| {
            serde_json::json!({
                "sessionId": session_id,
                "graph": graph
            })
        }),
        "branch_orchestrator.planned" => value.get("branch").map(|branch| {
            serde_json::json!({
                "sessionId": session_id,
                "branch": branch
            })
        }),
        "branch_scope.conflict_detected" => value.get("conflict").map(|conflict| {
            serde_json::json!({
                "sessionId": session_id,
                "conflict": conflict
            })
        }),
        "patch.proposed" => value.get("proposal").map(|proposal| {
            serde_json::json!({
                "sessionId": session_id,
                "proposal": proposal
            })
        }),
        "patch.approved" | "patch.rejected" | "patch.applied" | "patch.apply_failed" => {
            if let Some(patch_id) = value
                .get("patchId")
                .or_else(|| value.get("patch_id"))
                .or_else(|| value.get("proposal").and_then(|proposal| proposal.get("id")))
                .and_then(Value::as_str)
            {
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "patchId": patch_id,
                    "status": value.get("status").and_then(Value::as_str),
                    "message": value.get("message").and_then(Value::as_str)
                }))
            } else {
                None
            }
        }
        "command.requested" => value.get("commandRequest").map(|request| {
            serde_json::json!({
                "sessionId": session_id,
                "commandRequest": request
            })
        }),
        // Canonical projection payload: top-level requestId with nested result.
        // Compatibility payload: Rust-side authoritative terminal result with the same shape.
        // Quarantined payload: runtime display-only `execution` payloads without canonical fields.
        "command.completed" | "command.failed" | "command.started" => {
            let request_id = value.get("requestId").and_then(Value::as_str);
            let result = value.get("result");
            if let (Some(request_id), Some(result)) = (request_id, result) {
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "requestId": request_id,
                    "result": result
                }))
            } else {
                None
            }
        }
        "session.restored" | "session.expired" | "session.created" => Some(serde_json::json!({
            "sessionId": session_id
        })),
        "verification.started" | "verification.completed" => value.get("verification").map(|verification| {
            serde_json::json!({
                "sessionId": session_id,
                "verification": verification
            })
        }),
        _ => None,
    }
}

fn resolve_patch_event_id(value: &Value, event_type: &str, authority: &str) -> Option<String> {
    if let Some(id) = value
        .get("patchId")
        .or_else(|| value.get("patch_id"))
        .and_then(Value::as_str)
    {
        return Some(id.to_string());
    }

    let proposal_id = value
        .get("proposal")
        .and_then(|proposal| proposal.get("id"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str);

    // Runtime SSE mirror events can carry display-oriented proposal payloads.
    // We only project those fallback shapes for non-terminal review events.
    match (event_type, authority, proposal_id) {
        (EVENT_PATCH_APPROVED, _, Some(id))
        | (EVENT_PATCH_APPLY_STARTED, _, Some(id))
        | (EVENT_PATCH_APPLY_FAILED, _, Some(id))
        | (EVENT_PATCH_REJECTED, _, Some(id)) => {
            Some(id.to_string())
        }
        _ => None,
    }
}

struct ProjectedCommandResult<'a> {
    request_id: Option<&'a str>,
    command: &'a str,
    status: &'a str,
    exit_code: Option<i64>,
    stdout: Option<&'a str>,
    stderr: Option<&'a str>,
    message: Option<&'a str>,
}

fn resolve_command_result_payload<'a>(
    value: &'a Value,
    authority: &str,
) -> Option<ProjectedCommandResult<'a>> {
    // Canonical command completion payloads use a `result` object plus top-level requestId.
    if let Some(result) = value.get("result") {
        if let (Some(command), Some(status)) = (
            result.get("command").and_then(Value::as_str),
            result.get("status").and_then(Value::as_str),
        ) {
            return Some(ProjectedCommandResult {
                request_id: value.get("requestId").and_then(Value::as_str),
                command,
                status,
                exit_code: result.get("exitCode").and_then(Value::as_i64),
                stdout: result.get("stdout").and_then(Value::as_str),
                stderr: result.get("stderr").and_then(Value::as_str),
                message: result.get("message").and_then(Value::as_str),
            });
        }
    }

    // Runtime-bridge display events often carry `execution` payloads. They are
    // useful for UI updates but are not projected into SQLite command_results
    // unless a canonical authoritative shape is present.
    if authority != EVENT_AUTHORITY_RUST {
        return None;
    }

    if let (Some(command), Some(status)) = (
        value.get("command").and_then(Value::as_str),
        value.get("status").and_then(Value::as_str),
    ) {
        return Some(ProjectedCommandResult {
            request_id: value.get("requestId").and_then(Value::as_str),
            command,
            status,
            exit_code: value.get("exitCode").and_then(Value::as_i64),
            stdout: value.get("stdout").and_then(Value::as_str),
            stderr: value.get("stderr").and_then(Value::as_str),
            message: value.get("message").and_then(Value::as_str),
        });
    }

    None
}

fn command_request_status_from_result(result_status: &str) -> &str {
    match result_status {
        "executed" | "completed" => "completed",
        "running" | "executing" => "executing",
        "terminated" | "orphaned" => "failed",
        "blocked" => "blocked",
        "approval_required" => "approval_required",
        _ => "failed",
    }
}

#[derive(Debug)]
struct ProjectedBackgroundJob {
    job_id: String,
    session_id: String,
    request_id: Option<String>,
    command: String,
    cwd: String,
    process_id: Option<u32>,
    status: String,
    exit_code: Option<i64>,
    output_summary: Option<String>,
    detection_source: Option<String>,
    started_at: String,
    completed_at: Option<String>,
    last_known_at: String,
}

fn resolve_background_job_payload(
    value: &Value,
    session_id: &str,
    now: &str,
) -> Option<ProjectedBackgroundJob> {
    let result = value.get("result")?;
    let background_job = result.get("backgroundJob")?;
    let job_id = background_job.get("jobId").and_then(Value::as_str)?;
    let command = result.get("command").and_then(Value::as_str)?;
    let cwd = result.get("cwd").and_then(Value::as_str)?;
    Some(ProjectedBackgroundJob {
        job_id: job_id.to_string(),
        session_id: session_id.to_string(),
        request_id: value
            .get("requestId")
            .and_then(Value::as_str)
            .map(|value| value.to_string()),
        command: command.to_string(),
        cwd: cwd.to_string(),
        process_id: background_job
            .get("processId")
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        status: background_job
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        exit_code: background_job.get("exitCode").and_then(Value::as_i64),
        output_summary: background_job
            .get("outputSummary")
            .and_then(Value::as_str)
            .map(|value| value.to_string()),
        detection_source: background_job
            .get("detectionSource")
            .and_then(Value::as_str)
            .map(|value| value.to_string()),
        started_at: background_job
            .get("startedAt")
            .and_then(Value::as_str)
            .unwrap_or(now)
            .to_string(),
        completed_at: background_job
            .get("completedAt")
            .and_then(Value::as_str)
            .map(|value| value.to_string()),
        last_known_at: background_job
            .get("lastKnownAt")
            .and_then(Value::as_str)
            .unwrap_or(now)
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonicalizes_patch_and_command_event_projections() {
        let db = DatabaseService::new_in_memory().expect("db");
        let session_id = "session_1";
        db.create_orchestration_run(
            session_id,
            "Test prompt",
            "created",
            "standard",
            "token_hash",
            "2099-01-01T00:00:00Z",
        )
        .expect("seed session");

        db.append_session_event(
            session_id,
            "patch.proposed",
            &json!({
                "proposal": {
                    "id": "patch_1",
                    "title": "Patch title",
                    "unifiedDiff": "diff --git a/a.txt b/a.txt",
                    "status": "proposed"
                }
            })
            .to_string(),
        )
        .expect("patch proposed");
        db.append_authoritative_session_event(
            session_id,
            EVENT_PATCH_APPLIED,
            &json!({
                "patchId": "patch_1",
                "status": "applied"
            })
            .to_string(),
        )
        .expect("patch applied");
        db.append_session_event(
            session_id,
            "runtime.command.requested",
            &json!({
                "commandRequest": {
                    "id": "req_1",
                    "command": "cargo test",
                    "risk": "medium",
                    "status": "approval_required"
                }
            })
            .to_string(),
        )
        .expect("command requested");
        db.append_authoritative_session_event(
            session_id,
            "command.completed",
            &json!({
                "requestId": "req_1",
                "result": {
                    "command": "cargo test",
                    "status": "executed",
                    "exitCode": 0,
                    "stdout": "ok",
                    "stderr": "",
                    "message": "done"
                }
            })
            .to_string(),
        )
        .expect("command completed");

        let patch = db
            .conn
            .query_row(
                "SELECT status, last_event_type, last_event_authority, proposal_payload FROM patches WHERE id = 'patch_1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .expect("patch row");
        assert_eq!(patch.0, "applied");
        assert_eq!(patch.1, EVENT_PATCH_APPLIED);
        assert_eq!(patch.2, EVENT_AUTHORITY_RUST);
        assert!(patch.3.contains("\"unifiedDiff\""));

        let command_request = db
            .conn
            .query_row(
                "SELECT status, source_event_type, source_event_authority FROM command_requests WHERE id = 'req_1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .expect("request row");
        assert_eq!(command_request.0, "completed");
        assert_eq!(command_request.1, EVENT_COMMAND_REQUESTED);
        assert_eq!(command_request.2, EVENT_AUTHORITY_RUNTIME_BRIDGE);

        let command_result = db
            .conn
            .query_row(
                "SELECT source_event_type, source_event_authority FROM command_results WHERE request_id = 'req_1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("result row");
        assert_eq!(command_result.0, EVENT_COMMAND_COMPLETED);
        assert_eq!(command_result.1, EVENT_AUTHORITY_RUST);

        let session_event = db
            .conn
            .query_row(
                "SELECT canonical_event_type, authority FROM session_events WHERE event_type = 'command.completed'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("session event");
        assert_eq!(session_event.0, EVENT_COMMAND_COMPLETED);
        assert_eq!(session_event.1, EVENT_AUTHORITY_RUST);

        let runtime_events = db
            .list_runtime_events_for_session(session_id)
            .expect("runtime events");
        assert_eq!(runtime_events.len(), 5);
        assert_eq!(runtime_events[0].event_type, "session.created");
        assert_eq!(runtime_events[1].event_type, "patch.proposed");
        assert_eq!(runtime_events[2].event_type, "patch.applied");
        assert_eq!(runtime_events[3].event_type, "command.requested");
        assert_eq!(runtime_events[4].event_type, "command.completed");
    }

    #[test]
    fn patch_apply_lookup_uses_persisted_proposal_and_approval_events() {
        let db = DatabaseService::new_in_memory().expect("db");
        let session_id = "session_patch_lookup";
        db.create_orchestration_run(
            session_id,
            "Patch lookup test",
            "created",
            "standard",
            "token_hash",
            "2099-01-01T00:00:00Z",
        )
        .expect("seed session");
        db.append_session_event(
            session_id,
            EVENT_PATCH_PROPOSED,
            &json!({
                "proposal": {
                    "id": "patch_lookup",
                    "title": "Lookup patch",
                    "filesChanged": [{ "path": "a.txt", "changeType": "create", "explanation": "test" }],
                    "unifiedDiff": "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+a\n",
                    "status": "proposed"
                }
            })
            .to_string(),
        )
        .expect("proposal");
        assert!(db.patch_payload_for_session(session_id, "patch_lookup").expect("lookup").is_some());
        assert!(!db.patch_approval_exists_for_session(session_id, "patch_lookup").expect("approval lookup"));

        db.append_session_event(
            session_id,
            EVENT_PATCH_APPROVED,
            &json!({ "patchId": "patch_lookup", "status": "approved" }).to_string(),
        )
        .expect("approval");
        assert!(db.patch_approval_exists_for_session(session_id, "patch_lookup").expect("approval lookup"));

        db.append_authoritative_session_event(
            session_id,
            EVENT_PATCH_REJECTED,
            &json!({ "patchId": "patch_lookup" }).to_string(),
        )
        .expect("rejection");
        assert!(!db
            .patch_approval_exists_for_session(session_id, "patch_lookup")
            .expect("revoked approval lookup"));

        db.append_session_event(
            session_id,
            EVENT_PATCH_APPROVED,
            &json!({ "patchId": "patch_lookup_extra", "status": "approved" }).to_string(),
        )
        .expect("similarly named approval");
        assert!(!db
            .patch_approval_exists_for_session(session_id, "patch_lookup")
            .expect("exact patch id lookup"));

        db.append_session_event(
            session_id,
            EVENT_PATCH_APPROVED,
            &json!({ "patchId": "patch_lookup", "status": "approved" }).to_string(),
        )
        .expect("approval after rejection");
        assert!(db
            .patch_approval_exists_for_session(session_id, "patch_lookup")
            .expect("restored approval lookup"));

        db.append_authoritative_session_event(
            session_id,
            EVENT_PATCH_APPLY_FAILED,
            &json!({ "patchId": "patch_lookup", "status": "apply_failed", "message": "test failure" }).to_string(),
        )
        .expect("apply failed");
        let status = db.conn.query_row(
            "SELECT status FROM patches WHERE id = 'patch_lookup'",
            [],
            |row| row.get::<_, String>(0),
        ).expect("patch status");
        assert_eq!(status, "apply_failed");
    }

    #[test]
    fn quarantines_runtime_bridge_terminal_payloads_without_canonical_shapes() {
        let db = DatabaseService::new_in_memory().expect("db");
        let session_id = "session_2";
        db.create_orchestration_run(
            session_id,
            "Test prompt",
            "created",
            "standard",
            "token_hash",
            "2099-01-01T00:00:00Z",
        )
        .expect("seed session");

        db.append_session_event(
            session_id,
            "patch.proposed",
            &json!({
                "proposal": {
                    "id": "patch_bridge",
                    "title": "Patch title",
                    "unifiedDiff": "diff --git a/a.txt b/a.txt",
                    "status": "proposed"
                }
            })
            .to_string(),
        )
        .expect("patch proposed");
        db.append_session_event(
            session_id,
            "runtime.command.requested",
            &json!({
                "commandRequest": {
                    "id": "req_bridge",
                    "command": "cargo test",
                    "risk": "medium",
                    "status": "approval_required"
                }
            })
            .to_string(),
        )
        .expect("command requested");

        db.append_session_event(
            session_id,
            EVENT_PATCH_APPLIED,
            &json!({
                "proposal": {
                    "id": "patch_bridge",
                    "title": "Patch title",
                    "unifiedDiff": "diff --git a/a.txt b/a.txt",
                    "status": "applied"
                }
            })
            .to_string(),
        )
        .expect("runtime bridge patch applied");
        db.append_session_event(
            session_id,
            EVENT_COMMAND_COMPLETED,
            &json!({
                "sessionId": session_id,
                "execution": {
                    "requestId": "req_bridge",
                    "command": "cargo test",
                    "status": "executed",
                    "exitCode": 0,
                    "stdout": "ok",
                    "stderr": "",
                    "message": "display event only"
                }
            })
            .to_string(),
        )
        .expect("runtime bridge command completed");

        let patch_status = db
            .conn
            .query_row(
                "SELECT status, last_event_authority FROM patches WHERE id = 'patch_bridge'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .expect("patch row");
        assert_eq!(patch_status.0, "proposed");
        assert_eq!(patch_status.1, Some(EVENT_AUTHORITY_RUNTIME_BRIDGE.to_string()));

        let command_request_status = db
            .conn
            .query_row(
                "SELECT status FROM command_requests WHERE id = 'req_bridge'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("request row");
        assert_eq!(command_request_status, "approval_required");

        let command_results_count = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM command_results WHERE request_id = 'req_bridge'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("result count");
        assert_eq!(command_results_count, 0);
    }

    #[test]
    fn projects_authoritative_background_command_start_without_fake_completion() {
        let db = DatabaseService::new_in_memory().expect("db");
        let session_id = "session_bg";
        db.create_orchestration_run(
            session_id,
            "Test prompt",
            "created",
            "standard",
            "token_hash",
            "2099-01-01T00:00:00Z",
        )
        .expect("seed session");

        db.append_session_event(
            session_id,
            "runtime.command.requested",
            &json!({
                "commandRequest": {
                    "id": "req_bg",
                    "command": "npm run dev",
                    "risk": "safe",
                    "status": "requested"
                }
            })
            .to_string(),
        )
        .expect("command requested");

        db.append_authoritative_session_event(
            session_id,
            EVENT_COMMAND_STARTED,
            &json!({
                "requestId": "req_bg",
                "result": {
                    "command": "npm run dev",
                    "cwd": "C:/work/project",
                    "status": "running",
                    "risk": "safe",
                    "stdout": "",
                    "stderr": "",
                    "backgroundJob": {
                        "jobId": "job_bg",
                        "sessionId": session_id,
                        "requestId": "req_bg",
                        "command": "npm run dev",
                        "cwd": "C:/work/project",
                        "processId": 4242,
                        "startedAt": "2026-05-15T00:00:00Z",
                        "status": "running",
                        "lastKnownAt": "2026-05-15T00:00:00Z",
                        "detectionSource": "heuristic"
                    }
                }
            })
            .to_string(),
        )
        .expect("command started");

        let command_request_status = db
            .conn
            .query_row(
                "SELECT status FROM command_requests WHERE id = 'req_bg'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("request row");
        assert_eq!(command_request_status, "executing");

        let command_results_count = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM command_results WHERE request_id = 'req_bg'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("result count");
        assert_eq!(command_results_count, 0);

        let background_job = db
            .conn
            .query_row(
                "SELECT status, source_event_type FROM background_jobs WHERE job_id = 'job_bg'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("background job row");
        assert_eq!(background_job.0, "running");
        assert_eq!(background_job.1, EVENT_COMMAND_STARTED);
    }

    #[test]
    fn appends_and_lists_runtime_events_in_session_sequence_order() {
        let db = DatabaseService::new_in_memory().expect("db");

        let first = db
            .append_runtime_event(RuntimeEventInsert {
                id: Some("evt_1"),
                session_id: "session_seq",
                sequence: None,
                event_type: "session.created",
                actor: "system",
                authority: "rust",
                payload_json: "{\"sessionId\":\"session_seq\"}",
                created_at: Some("2026-05-15T00:00:00Z"),
                version: 1,
                correlation_id: None,
                causation_id: None,
            })
            .expect("first event");
        let second = db
            .append_runtime_event(RuntimeEventInsert {
                id: Some("evt_2"),
                session_id: "session_seq",
                sequence: None,
                event_type: "patch.proposed",
                actor: "runtime",
                authority: "runtime_bridge",
                payload_json: "{\"sessionId\":\"session_seq\",\"proposal\":{\"id\":\"patch_1\"}}",
                created_at: Some("2026-05-15T00:00:01Z"),
                version: 1,
                correlation_id: Some("patch_1"),
                causation_id: Some("evt_1"),
            })
            .expect("second event");

        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        assert_eq!(
            db.get_latest_runtime_event_sequence("session_seq")
                .expect("latest sequence"),
            2
        );

        let listed = db
            .list_runtime_events_for_session("session_seq")
            .expect("listed events");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "evt_1");
        assert_eq!(listed[1].id, "evt_2");
    }

    #[test]
    fn rejects_duplicate_runtime_event_id_and_session_sequence() {
        let db = DatabaseService::new_in_memory().expect("db");
        db.append_runtime_event(RuntimeEventInsert {
            id: Some("evt_dup"),
            session_id: "session_dup",
            sequence: Some(1),
            event_type: "session.created",
            actor: "system",
            authority: "rust",
            payload_json: "{\"sessionId\":\"session_dup\"}",
            created_at: Some("2026-05-15T00:00:00Z"),
            version: 1,
            correlation_id: None,
            causation_id: None,
        })
        .expect("seed event");

        let duplicate_id = db.append_runtime_event(RuntimeEventInsert {
            id: Some("evt_dup"),
            session_id: "session_dup",
            sequence: Some(2),
            event_type: "patch.proposed",
            actor: "runtime",
            authority: "runtime_bridge",
            payload_json: "{\"sessionId\":\"session_dup\"}",
            created_at: Some("2026-05-15T00:00:01Z"),
            version: 1,
            correlation_id: None,
            causation_id: None,
        });
        assert!(duplicate_id.is_err());

        let duplicate_sequence = db.append_runtime_event(RuntimeEventInsert {
            id: Some("evt_other"),
            session_id: "session_dup",
            sequence: Some(1),
            event_type: "patch.proposed",
            actor: "runtime",
            authority: "runtime_bridge",
            payload_json: "{\"sessionId\":\"session_dup\"}",
            created_at: Some("2026-05-15T00:00:02Z"),
            version: 1,
            correlation_id: None,
            causation_id: None,
        });
        assert!(duplicate_sequence.is_err());
    }

    #[test]
    fn lists_runtime_events_for_one_session_only() {
        let db = DatabaseService::new_in_memory().expect("db");
        db.append_runtime_event(RuntimeEventInsert {
            id: Some("evt_a"),
            session_id: "session_a",
            sequence: None,
            event_type: "session.created",
            actor: "system",
            authority: "rust",
            payload_json: "{\"sessionId\":\"session_a\"}",
            created_at: Some("2026-05-15T00:00:00Z"),
            version: 1,
            correlation_id: None,
            causation_id: None,
        })
        .expect("event a");
        db.append_runtime_event(RuntimeEventInsert {
            id: Some("evt_b"),
            session_id: "session_b",
            sequence: None,
            event_type: "session.created",
            actor: "system",
            authority: "rust",
            payload_json: "{\"sessionId\":\"session_b\"}",
            created_at: Some("2026-05-15T00:00:01Z"),
            version: 1,
            correlation_id: None,
            causation_id: None,
        })
        .expect("event b");

        let listed = db
            .list_runtime_events_for_session("session_a")
            .expect("list session a");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "session_a");
    }
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    ty: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"), [])?;
    Ok(())
}

fn app_database_path() -> PathBuf {
    let root = dirs_next::data_local_dir().unwrap_or_else(std::env::temp_dir);
    let hivo_path = root.join("HivoStudio").join("state.sqlite");
    let legacy_path = root.join("OrchCodeStudio").join("state.sqlite");
    if !hivo_path.exists() && legacy_path.exists() {
        legacy_path
    } else {
        hivo_path
    }
}

fn provider_type_to_str(provider_type: &ModelProviderType) -> &'static str {
    match provider_type {
        ModelProviderType::Ollama => "ollama",
        ModelProviderType::OpenaiCompatible => "openai_compatible",
    }
}

fn provider_type_from_str(provider_type: &str) -> ModelProviderType {
    match provider_type {
        "openai_compatible" => ModelProviderType::OpenaiCompatible,
        _ => ModelProviderType::Ollama,
    }
}
