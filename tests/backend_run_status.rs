use nset::{
    db::{Database, SCHEMA_VERSION},
    live::Change,
    models::{ImageQuery, MetricBatch, MetricInput, NewRun, PatchRun},
};
use rusqlite::Connection;
use serde_json::json;

fn patch(status: &str) -> PatchRun {
    serde_json::from_value(json!({"status":status})).unwrap()
}
fn batch() -> MetricBatch {
    MetricBatch {
        metrics: vec![MetricInput {
            key: "loss".into(),
            step: 0,
            timestamp: Some(0), // Measurement time is not acceptance order.
            value: 1.0,
        }],
    }
}
async fn run(db: &Database) -> String {
    let (experiment, _) = db.create_experiment("statuses".into()).await.unwrap();
    db.create_run(NewRun {
        experiment_id: experiment.id,
        name: "run".into(),
        params: Default::default(),
        tags: Default::default(),
    })
    .await
    .unwrap()
    .id
}

#[tokio::test]
async fn terminal_runs_reactivate_only_for_nonempty_committed_observations() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    let id = run(&db).await;
    let live = db.live();
    for terminal in ["finished", "failed", "canceled"] {
        db.patch_run(id.clone(), patch(terminal)).await.unwrap();
        let before = live.cursor();
        db.insert_metrics(id.clone(), MetricBatch { metrics: vec![] })
            .await
            .unwrap();
        db.patch_run(id.clone(), serde_json::from_value(json!({})).unwrap())
            .await
            .unwrap();
        assert_eq!(before, live.cursor());
        db.patch_run(
            id.clone(),
            serde_json::from_value(json!({"params":{"epoch":3},"tags":{"owner":"me"}})).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(db.run(id.clone()).await.unwrap().status, terminal);
        let mut invalid = batch();
        invalid.metrics[0].step = -1;
        assert!(db.insert_metrics(id.clone(), invalid).await.is_err());
        assert_eq!(db.run(id.clone()).await.unwrap().status, terminal);

        let before = live.cursor();
        db.insert_metrics(id.clone(), batch()).await.unwrap();
        let hints = live.poll(before).await.unwrap();
        assert!(
            hints
                .changes
                .iter()
                .any(|hint| matches!(hint, Change::Catalog))
        );
        assert!(
            hints
                .changes
                .iter()
                .any(|hint| matches!(hint, Change::Metric { .. }))
        );
        assert_eq!(db.catalog().await.unwrap().runs[0].status, "running");

        db.patch_run(id.clone(), patch(terminal)).await.unwrap();
        let before = live.cursor();
        db.insert_image(
            id.clone(),
            ImageQuery {
                key: "sample".into(),
                step: 0,
                timestamp: 0,
            },
            "image/png".into(),
            vec![1, 2, 3],
        )
        .await
        .unwrap();
        let hints = live.poll(before).await.unwrap();
        assert!(
            hints
                .changes
                .iter()
                .any(|hint| matches!(hint, Change::Catalog))
        );
        assert!(
            hints
                .changes
                .iter()
                .any(|hint| matches!(hint, Change::Image { .. }))
        );
        assert_eq!(db.run(id.clone()).await.unwrap().status, "running");
    }
}

#[tokio::test]
async fn rejected_observation_transactions_leave_status_and_live_feed_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    let id = run(&db).await;
    db.patch_run(id.clone(), patch("canceled")).await.unwrap();
    let conn = Connection::open(dir.path().join("nset.sqlite3")).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_reactivation BEFORE UPDATE OF status ON runs WHEN NEW.status='running' BEGIN SELECT RAISE(FAIL,'blocked'); END;").unwrap();
    let cursor = db.live().cursor();
    assert!(db.insert_metrics(id.clone(), batch()).await.is_err());
    assert!(
        db.insert_image(
            id.clone(),
            ImageQuery {
                key: "sample".into(),
                step: 0,
                timestamp: 0
            },
            "image/png".into(),
            vec![1]
        )
        .await
        .is_err()
    );
    assert_eq!(db.run(id).await.unwrap().status, "canceled");
    assert_eq!(db.live().cursor(), cursor);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM metrics", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM images", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        std::fs::read_dir(dir.path().join("images"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn canceled_migration_preserves_legacy_data_foreign_keys_indexes_and_extensions() {
    for version in 0..=4 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nset.sqlite3");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE experiments(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
            CREATE TABLE runs(id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL REFERENCES experiments(id),name TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('running','finished','failed')),params TEXT NOT NULL,tags TEXT NOT NULL,
                created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,extension TEXT DEFAULT 'kept');
            CREATE INDEX runs_experiment ON runs(experiment_id,created_at);
            CREATE INDEX custom_run_index ON runs(name) WHERE status='failed';
            CREATE TABLE metrics(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),key TEXT NOT NULL,step INTEGER NOT NULL,timestamp INTEGER NOT NULL,value REAL NOT NULL);
            CREATE INDEX metrics_stream ON metrics(run_id,key,seq);
            CREATE TABLE images(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),key TEXT NOT NULL,step INTEGER NOT NULL,timestamp INTEGER NOT NULL,content_type TEXT NOT NULL,byte_length INTEGER NOT NULL,filename TEXT NOT NULL UNIQUE);
            CREATE INDEX images_stream ON images(run_id,key,step,timestamp,id);
            CREATE TABLE extension_child(run_id TEXT REFERENCES runs(id) ON DELETE CASCADE);
            CREATE TABLE status_audit(value TEXT);
            CREATE TRIGGER custom_run_trigger AFTER UPDATE OF status ON runs BEGIN INSERT INTO status_audit VALUES(NEW.status); END;
            CREATE VIEW extension_view AS SELECT id,status FROM runs;
            INSERT INTO experiments VALUES('exp','legacy',1);
            INSERT INTO runs VALUES('run','exp','legacy','finished','{\"x\":1}','{\"owner\":\"me\"}',1,2,'retained');
            INSERT INTO metrics VALUES(41,'run','loss',0,0,1.0);
            INSERT INTO images VALUES('image','run','sample',0,0,'image/png',3,'image.image');
            INSERT INTO extension_child VALUES('run');").unwrap();
        conn.execute_batch("ALTER TABLE runs ADD COLUMN extension_status TEXT DEFAULT 'finished' CHECK(extension_status IN ('running','finished','failed'));").unwrap();
        if version >= 2 {
            conn.execute_batch("CREATE TABLE ingest_receipts(run_id TEXT NOT NULL REFERENCES runs(id),batch_id TEXT NOT NULL,digest BLOB NOT NULL,accepted INTEGER NOT NULL,accepted_at INTEGER NOT NULL,PRIMARY KEY(run_id,batch_id)); INSERT INTO ingest_receipts VALUES('run','old',x'00',1,0);").unwrap();
        }
        if version >= 3 {
            conn.execute_batch("CREATE TABLE compat_kv(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,key));
                CREATE TABLE compat_sequences(namespace TEXT NOT NULL PRIMARY KEY,value INTEGER NOT NULL);
                CREATE TABLE compat_batches(run_id TEXT NOT NULL REFERENCES runs(id),batch_id TEXT NOT NULL,scheme TEXT NOT NULL,digest BLOB NOT NULL,PRIMARY KEY(run_id,batch_id));
                INSERT INTO compat_kv VALUES('ns','key','{}');
                INSERT INTO compat_batches VALUES('run','batch','test',zeroblob(32));").unwrap();
        }
        if version >= 4 {
            conn.execute_batch("CREATE TABLE views(id TEXT NOT NULL PRIMARY KEY,name TEXT NOT NULL,experiment_id TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,workspace TEXT NOT NULL); INSERT INTO views VALUES('view','view','exp',1,0,'{}');").unwrap();
        }
        conn.pragma_update(None, "user_version", version).unwrap();
        let objects = conn.prepare("SELECT name,sql FROM sqlite_schema WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY name").unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap()
            .collect::<rusqlite::Result<Vec<_>>>().unwrap();
        drop(conn);
        let db = Database::open(dir.path()).unwrap();
        let stored = db.run("run".into()).await.unwrap();
        assert_eq!(stored.status, "finished");
        assert_eq!(
            stored.params,
            serde_json::from_value::<nset::models::Object>(json!({"x":1})).unwrap()
        );
        assert_eq!(stored.created_at, 1);
        assert_eq!(stored.updated_at, 2);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        for (name, sql) in objects {
            assert_eq!(
                conn.query_row("SELECT sql FROM sqlite_schema WHERE name=?", [name], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
                sql
            );
        }
        for table in ["metrics", "images", "extension_child"] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        for table in [
            "metrics",
            "images",
            "extension_child",
            "ingest_receipts",
            "compat_batches",
        ] {
            assert_eq!(
                conn.query_row(
                    &format!("SELECT \"table\" FROM pragma_foreign_key_list('{table}')"),
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                "runs"
            );
        }
        assert_eq!(
            conn.query_row("SELECT extension FROM runs", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "retained"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        assert!(
            conn.execute("INSERT INTO extension_child VALUES('missing')", [])
                .is_err()
        );
        assert!(
            conn.execute("UPDATE runs SET extension_status='canceled'", [])
                .is_err()
        );
        db.patch_run("run".into(), patch("canceled")).await.unwrap();
        assert_eq!(
            conn.query_row("SELECT value FROM status_audit", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "canceled"
        );
        assert_eq!(
            conn.query_row("SELECT status FROM extension_view", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "canceled"
        );
        assert!(
            conn.execute("UPDATE runs SET status='invalid'", [])
                .is_err()
        );
        drop(db);
        let db = Database::open(dir.path()).unwrap();
        assert_eq!(db.run("run".into()).await.unwrap().status, "canceled");
        db.insert_metrics("run".into(), batch()).await.unwrap();
        assert_eq!(
            conn.query_row("SELECT MAX(seq) FROM metrics", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            42
        );
        assert_eq!(db.run("run".into()).await.unwrap().status, "running");
    }
}
