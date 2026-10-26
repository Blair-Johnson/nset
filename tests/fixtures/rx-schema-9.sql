-- rx src/rx/store.py SCHEMA at cc5f08ee69892bcc1b1430fbf6beadfbe0cf556f (schema 9).
-- Verbatim upstream DDL; synthetic data is inserted by backend_rx.rs.

CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    argv TEXT NOT NULL UNIQUE,
    alias TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spec TEXT NOT NULL UNIQUE,
    alias TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_uid TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('queued','active','succeeded','failed','canceled','lost')),
    command_id INTEGER NOT NULL REFERENCES commands(id),
    query_id INTEGER REFERENCES queries(id),
    parent_run_id INTEGER REFERENCES runs(id),
    parent_run_uid TEXT,
    definition_hash TEXT,
    result_hash TEXT,
    argv TEXT NOT NULL,
    cwd_rel TEXT NOT NULL,
    snapshot_sha TEXT,
    worktree_path TEXT,
    worktree_removed_at TEXT,
    storage_policy TEXT,
    config TEXT,
    alias TEXT UNIQUE,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    wall_time REAL,
    exit_code INTEGER,
    host TEXT,
    host_boot_id TEXT,
    worker_id TEXT,
    worker_pid INTEGER,
    supervisor_pid INTEGER,
    supervisor_start_token TEXT,
    process_group_id INTEGER,
    process_start_token TEXT,
    heartbeat TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    abandoned_at TEXT,
    abandon_reason TEXT
);
CREATE TABLE IF NOT EXISTS in_place_sessions (
    checkout_path TEXT PRIMARY KEY,
    home_head_sha TEXT NOT NULL,
    home_head_ref TEXT,
    home_snapshot_sha TEXT NOT NULL,
    home_ref TEXT NOT NULL,
    index_backup_path TEXT NOT NULL,
    cursor_run_id INTEGER NOT NULL REFERENCES runs(id),
    cursor_sha TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('entering','active','returning')),
    home_untracked TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    tag TEXT NOT NULL,
    PRIMARY KEY (run_id, tag)
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_uid TEXT NOT NULL UNIQUE,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    created_at TEXT NOT NULL,
    text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    seq INTEGER NOT NULL,
    received_at TEXT NOT NULL,
    data TEXT NOT NULL,
    UNIQUE (run_id, seq)
);
CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_uid TEXT NOT NULL UNIQUE,
    alias TEXT UNIQUE,
    summary TEXT NOT NULL,
    body TEXT,
    evidence_query_id INTEGER REFERENCES queries(id),
    supersedes_id INTEGER REFERENCES findings(id),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finding_runs (
    finding_id INTEGER NOT NULL REFERENCES findings(id),
    run_id INTEGER NOT NULL REFERENCES runs(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (finding_id, run_id),
    UNIQUE (finding_id, position)
);
CREATE TABLE IF NOT EXISTS finding_tags (
    finding_id INTEGER NOT NULL REFERENCES findings(id),
    tag TEXT NOT NULL,
    PRIMARY KEY (finding_id, tag)
);
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS active_project (
    checkout_path TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS table_defs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    definition TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_uid TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    spec TEXT NOT NULL,
    alias TEXT UNIQUE,
    created_at TEXT NOT NULL,
    UNIQUE (kind, spec)
);
CREATE INDEX IF NOT EXISTS runs_state_id ON runs(state, id);
CREATE INDEX IF NOT EXISTS tags_tag_run ON tags(tag, run_id);
CREATE INDEX IF NOT EXISTS finding_runs_run ON finding_runs(run_id, finding_id);
CREATE INDEX IF NOT EXISTS finding_tags_tag ON finding_tags(tag, finding_id);
CREATE INDEX IF NOT EXISTS findings_supersedes ON findings(supersedes_id, id);
CREATE INDEX IF NOT EXISTS table_defs_project ON table_defs(project_id, name);
CREATE INDEX IF NOT EXISTS recipes_kind_id ON recipes(kind, id);

PRAGMA user_version = 9;
