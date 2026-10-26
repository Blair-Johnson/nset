//! Read-only, bounded access to one configured rx repository. No rx subprocesses,
//! migrations, producer schema assumptions, or native-store projection.
use crate::{
    AppState,
    errors::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OpenFlags, config::DbConfig, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const MAX_SCAN: usize = 20_000;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_RECORD: usize = 256 * 1024;
// Plots and run predicates need complete events, unlike record/field previews.
// Large diagnostic events are legitimate rx data. Admit at most one bounded
// large row per page; the normal aggregate page budget remains 8 MiB.
const MAX_FILTER_RECORD: usize = 64 * 1024 * 1024;
// Bound tag-object heap amplification before deserializing numeric extensions.
const MAX_FILTER_NONFINITE: usize = 16_384;
const MAX_POINTS: usize = 20_000;
const MAX_TRACES: usize = 128;
const MAX_FIELDS: usize = 64;
const MAX_VISITS: usize = 4096;
const UNAVAILABLE: &str = "rx source unavailable: cannot read a live SQLite snapshot. Check source/directory permissions and SQLite recovery errors in the server log; nset never repairs or opens the database read-write. Native data remains available.";
fn unavailable(e: impl std::fmt::Display) -> ApiError {
    tracing::warn!(error=%e, "rx read-only source unavailable");
    ApiError(StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE)
}
const UNSUPPORTED_FORMAT: &str = "rx source uses an unsupported storage format: expected a canonical SQLite database at <Git common dir>/rx/rx.sqlite (schema 8 or 9). Non-SQLite markers and filesystem stores are not supported; nset never converts or repairs rx storage.";
const INVALID_SCHEMA: &str = "rx source has an incompatible schema: schema 8 or 9 must provide the required runs/events columns, types, and identity constraints; nset does not migrate databases.";
fn source_sql_error(error: rusqlite::Error) -> ApiError {
    tracing::warn!(%error, "rx read-only source validation failed");
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::NotADatabase) => {
            ApiError(StatusCode::SERVICE_UNAVAILABLE, UNSUPPORTED_FORMAT)
        }
        Some(rusqlite::ErrorCode::DatabaseCorrupt) => ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "rx source SQLite database is corrupt; nset never repairs or opens it read-write",
        ),
        _ => unavailable(error),
    }
}
fn invalid_schema(detail: impl std::fmt::Display) -> ApiError {
    tracing::warn!(%detail, "rx incompatible schema");
    ApiError(StatusCode::SERVICE_UNAVAILABLE, INVALID_SCHEMA)
}
// Validate only the reader's contract, not unrelated producer tables or nullable
// declarations: upstream upgrades can add columns without NOT NULL constraints.
fn validate_schema(conn: &Connection) -> Result<()> {
    for (table, required) in [
        (
            "runs",
            &[
                ("id", "INTEGER"),
                ("run_uid", "TEXT"),
                ("state", "TEXT"),
                ("alias", "TEXT"),
                ("config", "TEXT"),
                ("created_at", "TEXT"),
                ("started_at", "TEXT"),
                ("finished_at", "TEXT"),
                ("exit_code", "INTEGER"),
                ("argv", "TEXT"),
            ][..],
        ),
        (
            "events",
            &[
                ("run_id", "INTEGER"),
                ("seq", "INTEGER"),
                ("received_at", "TEXT"),
                ("data", "TEXT"),
            ][..],
        ),
    ] {
        let ordinary: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_list WHERE schema='main' AND name=? AND type='table')",
            [table], |r| r.get(0),
        ).map_err(source_sql_error)?;
        if !ordinary {
            return Err(invalid_schema(format!("missing ordinary table {table}")));
        }
        let mut stmt = conn
            .prepare("SELECT name,type,pk,hidden FROM pragma_table_xinfo(?, 'main')")
            .map_err(source_sql_error)?;
        let columns = stmt
            .query_map([table], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                    ),
                ))
            })
            .map_err(source_sql_error)?
            .collect::<rusqlite::Result<BTreeMap<_, _>>>()
            .map_err(source_sql_error)?;
        for (name, declaration) in required {
            if !columns.get(*name).is_some_and(|(kind, _, hidden)| {
                kind.eq_ignore_ascii_case(declaration) && *hidden == 0
            }) {
                return Err(invalid_schema(format!(
                    "{table}.{name} must be {declaration}"
                )));
            }
        }
        if table == "runs"
            && (columns["id"].1 != 1 || columns.values().filter(|(_, pk, _)| *pk != 0).count() != 1)
        {
            return Err(invalid_schema("runs.id must be the integer primary key"));
        }
    }
    for (table, required) in [("runs", vec!["run_uid"]), ("events", vec!["run_id", "seq"])] {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM pragma_index_list(?, 'main') WHERE \"unique\"=1 AND partial=0",
            )
            .map_err(source_sql_error)?;
        let indexes = stmt
            .query_map([table], |r| r.get::<_, String>(0))
            .map_err(source_sql_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(source_sql_error)?;
        let mut found = false;
        for index in indexes {
            let mut stmt = conn
                .prepare("SELECT name FROM pragma_index_info(?, 'main') ORDER BY seqno")
                .map_err(source_sql_error)?;
            let columns = stmt
                .query_map([index], |r| r.get::<_, Option<String>>(0))
                .map_err(source_sql_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(source_sql_error)?;
            if columns
                .iter()
                .map(|name| name.as_deref())
                .eq(required.iter().map(|name| Some(*name)))
            {
                found = true;
                break;
            }
        }
        if !found {
            return Err(invalid_schema(format!(
                "{table} requires unique {required:?}"
            )));
        }
    }
    Ok(())
}
#[derive(Clone)]
pub struct Source {
    path: PathBuf,
    pub id: String,
    pub name: String,
    slots: Arc<Semaphore>,
    run_filter_key: [u8; 32],
}
impl Source {
    pub fn resolve(repo: &Path) -> Result<Self> {
        // Only this startup path is used; Git receives argv, never a shell command.
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .map_err(|_| {
                ApiError::bad("--rx-repo: could not run git to resolve the common directory")
            })?;
        if !output.status.success() {
            return Err(ApiError::bad(
                "--rx-repo must point to an existing Git repository",
            ));
        }
        let common = PathBuf::from(
            String::from_utf8(output.stdout)
                .map_err(|_| ApiError::bad("--rx-repo has an unsupported path"))?
                .trim(),
        );
        let common = common
            .canonicalize()
            .map_err(|_| ApiError::bad("--rx-repo: Git common directory is unavailable"))?;
        let path = common.join("rx/rx.sqlite");
        if !path.is_file() {
            return Err(ApiError::bad(
                "--rx-repo contains no rx database in its Git common directory",
            ));
        }
        let id = format!(
            "rx:{:x}",
            Sha256::digest(common.as_os_str().as_encoded_bytes())
        );
        Ok(Self {
            path,
            id,
            name: repo
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            slots: Arc::new(Semaphore::new(2)),
            run_filter_key: {
                let mut key = [0; 32];
                key[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
                key[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
                key
            },
        })
    }
    fn connection(&self) -> Result<Connection> {
        let mut header = [0; 16];
        let mut file = std::fs::File::open(&self.path).map_err(unavailable)?;
        if let Err(error) = file.read_exact(&mut header) {
            if error.kind() != std::io::ErrorKind::UnexpectedEof {
                return Err(unavailable(error));
            }
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                UNSUPPORTED_FORMAT,
            ));
        }
        if &header != b"SQLite format 3\0" {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                UNSUPPORTED_FORMAT,
            ));
        }
        // The main database is strictly read-only. Ordinary SQLite WAL/SHM
        // reader coordination (including empty sidecars) is allowed, never a
        // writable database fallback or immutable live read.
        let conn = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(unavailable)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .map_err(unavailable)?;
        conn.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH, 1024 * 1024)
            .map_err(unavailable)?;
        conn.busy_timeout(Duration::from_millis(100))
            .map_err(unavailable)?;
        conn.pragma_update(None, "query_only", true)
            .map_err(unavailable)?;
        let deadline = Instant::now() + Duration::from_millis(750);
        conn.progress_handler(1000, Some(move || Instant::now() > deadline))
            .map_err(unavailable)?;
        conn.execute_batch("BEGIN DEFERRED")
            .map_err(source_sql_error)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(source_sql_error)?;
        if !matches!(version, 8 | 9) {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "rx source uses an unsupported schema; this reader supports SQLite schemas 8 and 9 and does not migrate databases",
            ));
        }
        validate_schema(&conn)?;
        Ok(conn)
    }
    fn generation(&self) -> Result<String> {
        let metadata = std::fs::metadata(&self.path).map_err(unavailable)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(format!(
                "{}:{}:{:?}",
                metadata.dev(),
                metadata.ino(),
                metadata.created().ok()
            ))
        }
        #[cfg(not(unix))]
        {
            // Birth time is the available portable generation marker. Platforms
            // with Unix file identities also include device/inode above.
            Ok(format!("{:?}", metadata.created().map_err(unavailable)?))
        }
    }
    async fn execute<T: Send + 'static>(
        &self,
        f: impl FnOnce(Source) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::busy())?;
        let source = self.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            f(source)
        })
        .await
        .map_err(ApiError::internal)?
    }
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct CatalogQuery {
    #[serde(default)]
    after: i64,
    high_water: Option<i64>,
    source_generation: Option<String>,
}
pub async fn catalog(
    State(state): State<AppState>,
    Query(q): Query<CatalogQuery>,
) -> Result<Json<Value>> {
    let Some(source) = state.rx else {
        return Ok(Json(json!({"source":null,"runs":[],"next_after":null})));
    };
    if q.after < 0 {
        return Err(ApiError::bad("invalid rx run cursor"));
    }
    let metadata = json!({"id":source.id,"name":source.name,"readonly":true});
    let result = source.execute(move |s| s.runs(q)).await;
    match result {
        Ok(mut value) => {
            value["source"] = metadata;
            Ok(Json(value))
        }
        Err(error) if error.0 == StatusCode::SERVICE_UNAVAILABLE => Ok(Json(
            json!({"source":metadata,"runs":[],"next_after":null,"error":error.1}),
        )),
        Err(error) => Err(error),
    }
}
impl Source {
    fn runs(&self, q: CatalogQuery) -> Result<Value> {
        let generation = self.generation()?;
        let source_generation = URL_SAFE_NO_PAD.encode(self.run_filter_mac(generation.as_bytes()));
        let stale = || ApiError::bad("rx catalog snapshot changed; refresh the catalog");
        if q.source_generation
            .as_ref()
            .is_some_and(|pin| pin != &source_generation)
            || (q.high_water.is_some() && q.source_generation.is_none())
        {
            return Err(stale());
        }
        let conn = self.connection()?;
        if self.generation()? != generation {
            return Err(stale());
        }
        let current: i64 = conn
            .query_row("SELECT coalesce(max(id),0) FROM runs", [], |r| r.get(0))
            .map_err(unavailable)?;
        let high = q.high_water.unwrap_or(current);
        if high < 0 || high > current {
            return Err(stale());
        }
        let mut stmt = conn.prepare("SELECT id,substr(run_uid,1,129),substr(state,1,64),substr(alias,1,512),substr(config,1,4096),substr(created_at,1,64),substr(started_at,1,64),substr(finished_at,1,64),exit_code,substr(argv,1,4096) FROM runs WHERE id>? AND id<=? ORDER BY id LIMIT 201").map_err(unavailable)?;
        let mut rows = stmt.query([q.after, high]).map_err(unavailable)?;
        let mut runs = Vec::new();
        let mut next = None;
        while let Some(r) = rows.next().map_err(unavailable)? {
            if runs.len() == 200 {
                next = runs
                    .last()
                    .map(|v: &Value| v["id"].as_str().unwrap().to_owned());
                break;
            }
            if r.get::<_, String>(1).map_err(unavailable)?.len() > 128 {
                return Err(unavailable("invalid oversized rx run UID"));
            }
            runs.push(json!({"id":r.get::<_,i64>(0).map_err(unavailable)?.to_string(),"run_uid":r.get::<_,String>(1).map_err(unavailable)?,"state":r.get::<_,String>(2).map_err(unavailable)?,"alias":r.get::<_,Option<String>>(3).map_err(unavailable)?,"config":r.get::<_,Option<String>>(4).map_err(unavailable)?,"created_at":r.get::<_,String>(5).map_err(unavailable)?,"started_at":r.get::<_,Option<String>>(6).map_err(unavailable)?,"finished_at":r.get::<_,Option<String>>(7).map_err(unavailable)?,"exit_code":r.get::<_,Option<i64>>(8).map_err(unavailable)?,"argv":r.get::<_,String>(9).map_err(unavailable)?}));
        }
        if self.generation()? != generation {
            return Err(stale());
        }
        Ok(
            json!({"runs":runs,"next_after":next,"metadata_truncated":true,"high_water":high.to_string(),"source_generation":source_generation}),
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Segment {
    Key(String),
    Index(usize),
}
#[derive(Clone, Debug)]
struct FieldPath(Vec<Segment>);
impl FieldPath {
    fn parse(text: &str) -> Result<Self> {
        if text.is_empty() || text.len() > 1024 {
            return Err(ApiError::bad("record path must contain 1–1024 bytes"));
        }
        let bytes = text.as_bytes();
        let mut i = usize::from(bytes[0] == b'$');
        let mut parts = Vec::new();
        while i < bytes.len() {
            if parts.len() >= 32 {
                return Err(ApiError::bad("record path exceeds 32 components"));
            }
            if bytes[i] == b'.' {
                i += 1;
                if i == bytes.len() {
                    return Err(ApiError::bad("unfinished record path"));
                }
            } else if !parts.is_empty() && bytes[i] != b'[' {
                return Err(ApiError::bad("invalid record path separator"));
            }
            if bytes[i] == b'[' {
                i += 1;
                if bytes.get(i) == Some(&b'"') {
                    let start = i;
                    i += 1;
                    let mut escaped = false;
                    while i < bytes.len() {
                        let b = bytes[i];
                        i += 1;
                        if b == b'"' && !escaped {
                            break;
                        }
                        if b == b'\\' && !escaped {
                            escaped = true;
                        } else {
                            escaped = false;
                        }
                    }
                    let key: String = serde_json::from_str(&text[start..i])
                        .map_err(|_| ApiError::bad("invalid quoted record key"))?;
                    parts.push(Segment::Key(key));
                } else {
                    let start = i;
                    while bytes.get(i).is_some_and(u8::is_ascii_digit) {
                        i += 1;
                    }
                    let n: usize = text[start..i].parse().map_err(|_| {
                        ApiError::bad("record array index must be a nonnegative integer")
                    })?;
                    parts.push(Segment::Index(n));
                }
                if bytes.get(i) != Some(&b']') {
                    return Err(ApiError::bad("unclosed record path bracket"));
                }
                i += 1;
            } else {
                let start = i;
                while bytes
                    .get(i)
                    .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
                {
                    i += 1;
                }
                if i == start || bytes[start].is_ascii_digit() {
                    return Err(ApiError::bad(
                        "use JSON bracket notation for special record keys",
                    ));
                }
                parts.push(Segment::Key(text[start..i].to_owned()));
            }
        }
        if parts.is_empty() {
            return Err(ApiError::bad("choose a record field, not the root"));
        }
        Ok(Self(parts))
    }
    fn get<'a>(&self, mut value: &'a Value) -> Option<&'a Value> {
        for p in &self.0 {
            value = match p {
                Segment::Key(k) => value.as_object()?.get(k)?,
                Segment::Index(i) => value.as_array()?.get(*i)?,
            };
        }
        Some(value)
    }
}
fn completion_dot(text: &str) -> Option<usize> {
    let mut quote = false;
    let mut escape = false;
    let mut last = None;
    for (i, b) in text.bytes().enumerate() {
        if b == b'"' && !escape {
            quote = !quote;
        }
        if b == b'.' && !quote {
            last = Some(i);
        }
        escape = b == b'\\' && !escape;
    }
    last
}
fn key_path(parent: &str, key: &str) -> String {
    let simple = !key.is_empty()
        && !key.as_bytes()[0].is_ascii_digit()
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    if simple {
        if parent.is_empty() {
            key.into()
        } else {
            format!("{parent}.{key}")
        }
    } else {
        format!(
            "{}[{}]",
            if parent.is_empty() { "$" } else { parent },
            serde_json::to_string(key).unwrap()
        )
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    path: String,
    op: String,
    #[serde(default)]
    value: Value,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    #[serde(default)]
    any: bool,
    #[serde(default)]
    conditions: Vec<Condition>,
}
impl Filters {
    fn compiled(&self) -> Result<Vec<(FieldPath, &Condition)>> {
        if self.conditions.len() > 16 {
            return Err(ApiError::bad("at most 16 record conditions are allowed"));
        }
        self.conditions
            .iter()
            .map(|c| {
                if !["eq", "ne", "lt", "lte", "gt", "gte", "exists", "missing"]
                    .contains(&c.op.as_str())
                    || c.value.is_array()
                    || c.value.is_object()
                    || c.value.to_string().len() > 1024
                {
                    return Err(ApiError::bad(
                        "invalid record condition (use a typed JSON scalar)",
                    ));
                }
                Ok((FieldPath::parse(&c.path)?, c))
            })
            .collect()
    }
}
fn scalar_group(value: &Value) -> Value {
    if value.is_number() && value.as_i64().is_none() && value.as_u64().is_none() {
        let f = value.as_f64().unwrap();
        if f.fract() == 0.0 {
            if f >= 0.0 && f < 18446744073709551616.0 {
                return json!(f as u64);
            }
            if f >= i64::MIN as f64 && f < 0.0 {
                return json!(f as i64);
            }
        }
    }
    value.clone()
}
// Compare represented JSON numbers without rounding integers through f64.
fn numeric_cmp(a: &Value, b: &Value) -> Option<Ordering> {
    let integer = |v: &Value| {
        v.as_i64()
            .map(i128::from)
            .or_else(|| v.as_u64().map(i128::from))
    };
    fn int_float(i: i128, f: f64) -> Ordering {
        if f < i64::MIN as f64 {
            return Ordering::Greater;
        }
        if f >= 18446744073709551616.0 {
            return Ordering::Less;
        }
        match i.cmp(&(f.trunc() as i128)) {
            Ordering::Equal if f.fract() > 0.0 => Ordering::Less,
            Ordering::Equal if f.fract() < 0.0 => Ordering::Greater,
            order => order,
        }
    }
    let (a_float, b_float) = (a.as_f64()?, b.as_f64()?);
    Some(match (integer(a), integer(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(i), None) => int_float(i, b_float),
        (None, Some(i)) => int_float(i, a_float).reverse(),
        (None, None) => a_float.partial_cmp(&b_float)?,
    })
}
fn scalar_equal(a: &Value, b: &Value) -> bool {
    if a.is_number() && b.is_number() {
        numeric_cmp(a, b) == Some(Ordering::Equal)
    } else {
        a == b
    }
}
// Hint values travel through JS JSON.parse; omit unsafe integer suggestions
// instead of presenting a rounded predicate. Their paths remain queryable.
fn safe_hint_value(v: &Value) -> bool {
    v.as_f64()
        .is_none_or(|n| n.fract() != 0.0 || n.abs() <= 9007199254740991.0)
}
fn matches(value: &Value, filters: &[(FieldPath, &Condition)], any: bool) -> bool {
    let test = |(p, c): &(FieldPath, &Condition)| {
        let v = p.get(value);
        match c.op.as_str() {
            "exists" => v.is_some(),
            "missing" => v.is_none(),
            "eq" => v.is_some_and(|v| scalar_equal(v, &c.value)),
            "ne" => v.is_some_and(|v| !scalar_equal(v, &c.value)),
            op => v
                .and_then(|v| numeric_cmp(v, &c.value))
                .is_some_and(|order| match op {
                    "lt" => order.is_lt(),
                    "lte" => !order.is_gt(),
                    "gt" => order.is_gt(),
                    "gte" => !order.is_lt(),
                    _ => false,
                }),
        }
    };
    filters.is_empty()
        || if any {
            filters.iter().any(test)
        } else {
            filters.iter().all(test)
        }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    scope: String,
    generation: String,
    run: usize,
    seq: Option<i64>,
    high: Vec<Option<i64>>,
    ids: Vec<i64>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    source_id: String,
    runs: Vec<String>,
    #[serde(default)]
    filters: Filters,
    #[serde(default)]
    x: String,
    #[serde(default)]
    ys: Vec<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    search: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    source_generation: Option<String>,
    #[serde(default = "page_size")]
    limit: usize,
}
fn page_size() -> usize {
    25
}
#[derive(Default, Serialize)]
struct Diagnostics {
    scanned: usize,
    matched: usize,
    bytes: usize,
    invalid_json: usize,
    oversized: usize,
    skipped_axes: usize,
    skipped_groups: usize,
    omitted_traces: usize,
    points: usize,
    partial: bool,
    reasons: BTreeSet<&'static str>,
}
impl Diagnostics {
    fn limit(&mut self, reason: &'static str) {
        self.partial = true;
        self.reasons.insert(reason);
    }
}
#[derive(Clone, Copy, PartialEq, Serialize)]
enum Mode {
    Fields,
    Records,
    Plot,
}
pub async fn fields(State(state): State<AppState>, Json(q): Json<Request>) -> Result<Json<Value>> {
    query(state, q, Mode::Fields).await
}
pub async fn records(State(state): State<AppState>, Json(q): Json<Request>) -> Result<Json<Value>> {
    query(state, q, Mode::Records).await
}
pub async fn plot(State(state): State<AppState>, Json(q): Json<Request>) -> Result<Json<Value>> {
    query(state, q, Mode::Plot).await
}
async fn query(state: AppState, q: Request, mode: Mode) -> Result<Json<Value>> {
    let source = state
        .rx
        .ok_or_else(|| ApiError::bad("no rx repository is configured"))?;
    source
        .execute(move |source| source.query(q, mode))
        .await
        .map(Json)
}
#[derive(Default, Serialize)]
struct Hint {
    path: String,
    #[serde(skip)]
    rank: u8,
    types: BTreeSet<&'static str>,
    present: usize,
    values: Vec<Value>,
}
#[derive(Serialize)]
struct Trace {
    id: String,
    group_label: Option<String>,
    run_uid: String,
    y: String,
    group: Option<Value>,
    points: Vec<(f64, f64, String)>,
}
fn value_type(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
fn add_hint(
    hints: &mut BTreeMap<String, Hint>,
    diagnostics: &mut Diagnostics,
    path: String,
    value: &Value,
    limit: usize,
) {
    if !hints.contains_key(&path) && hints.len() >= limit {
        diagnostics.limit("field suggestion limit reached");
        return;
    }
    let hint = hints.entry(path.clone()).or_insert_with(|| Hint {
        path,
        ..Hint::default()
    });
    hint.present += 1;
    hint.types.insert(value_type(value));
    if !value.is_array()
        && !value.is_object()
        && safe_hint_value(value)
        && value.to_string().len() <= 256
        && hint.values.len() < 8
        && !hint.values.contains(value)
    {
        hint.values.push(value.clone());
    }
}

// Search retention favors exact identity, then prefixes, then substrings.
// Keep the existing hint cap even when better matches arrive late in a scan.
fn add_search_hint(
    hints: &mut BTreeMap<String, Hint>,
    diagnostics: &mut Diagnostics,
    path: String,
    value: &Value,
    limit: usize,
    needle: &str,
    exact: Option<&str>,
) {
    let root_prefix = path.starts_with("$[") && FieldPath::parse(&path).ok().is_some_and(|p|
        matches!(p.0.as_slice(), [Segment::Key(key)] if key.to_lowercase().starts_with(needle)));
    let rank = if exact == Some(path.as_str()) {
        0
    } else if path.to_lowercase().starts_with(needle) || root_prefix {
        1
    } else {
        2
    };
    if !hints.contains_key(&path) && hints.len() >= limit {
        diagnostics.limit("field suggestion limit reached");
        let worst = hints
            .iter()
            .max_by(|(a, av), (b, bv)| (av.rank, *a).cmp(&(bv.rank, *b)))
            .map(|(key, hint)| (key.clone(), hint.rank))
            .unwrap();
        if (rank, path.as_str()) >= (worst.1, worst.0.as_str()) {
            return;
        }
        hints.remove(&worst.0);
    }
    add_hint(hints, diagnostics, path.clone(), value, limit);
    if let Some(hint) = hints.get_mut(&path) {
        hint.rank = rank;
    }
}

struct FieldSearch<'a> {
    needle: &'a str,
    exact: Option<&'a str>,
    visits: &'a mut usize,
    hints: &'a mut BTreeMap<String, Hint>,
    diagnostics: &'a mut Diagnostics,
    limit: usize,
    started: Instant,
}
impl FieldSearch<'_> {
    // Iterate children lazily: memory and call depth depend on the depth cap,
    // never on an object's width or an array's length. False stops the scan.
    fn walk(&mut self, value: &Value, parent: &str, depth: usize) -> bool {
        if depth >= 32 {
            if value.as_object().is_some_and(|v| !v.is_empty())
                || value.as_array().is_some_and(|v| !v.is_empty())
            {
                self.diagnostics.limit("field depth limit reached");
            }
            return true;
        }
        if let Some(object) = value.as_object() {
            for (key, child) in object {
                if !self.child(child, parent, Some(key), 0, depth + 1) {
                    return false;
                }
            }
        } else if let Some(array) = value.as_array() {
            for (index, child) in array.iter().enumerate() {
                if !self.child(child, parent, None, index, depth + 1) {
                    return false;
                }
            }
        }
        true
    }

    fn child(
        &mut self,
        value: &Value,
        parent: &str,
        key: Option<&str>,
        index: usize,
        depth: usize,
    ) -> bool {
        if *self.visits >= MAX_VISITS {
            self.diagnostics.limit("field visit budget reached");
            return false;
        }
        if self.started.elapsed() > Duration::from_millis(500) {
            self.diagnostics.limit("scan budget reached");
            return false;
        }
        *self.visits += 1;
        // Bound allocation before escaping an arbitrary object key.
        if key.is_some_and(|k| k.len() > 1024) {
            self.diagnostics.limit("oversized field paths skipped");
            return true;
        }
        let path = match key {
            Some(key) => key_path(parent, key),
            None => format!("{}[{index}]", if parent.is_empty() { "$" } else { parent }),
        };
        if path.len() > 1024 {
            self.diagnostics.limit("oversized field paths skipped");
            return true;
        }
        if self.exact != Some(path.as_str())
            && (key.is_some_and(|k| k.to_lowercase().contains(self.needle))
                || path.to_lowercase().contains(self.needle))
        {
            add_search_hint(
                self.hints,
                self.diagnostics,
                path.clone(),
                value,
                self.limit,
                self.needle,
                self.exact,
            );
        }
        self.walk(value, &path, depth)
    }
}

impl Source {
    fn query(&self, q: Request, mode: Mode) -> Result<Value> {
        if q.source_id != self.id {
            return Err(ApiError::bad(
                "saved rx source is unavailable; configure the same repository",
            ));
        }
        if q.runs.is_empty()
            || q.runs.len() > 32
            || q.runs.iter().any(|s| s.len() > 128 || s.is_empty())
            || q.runs.iter().collect::<BTreeSet<_>>().len() != q.runs.len()
        {
            return Err(ApiError::bad(
                "rx request exceeds its internal run batch bounds",
            ));
        }
        if q.limit == 0
            || q.limit > 100
            || q.prefix.len() > 1024
            || q.search.len() > 1024
            || q.ys.len() > 16
            || q.ys.iter().collect::<BTreeSet<_>>().len() != q.ys.len()
        {
            return Err(ApiError::bad("rx request exceeds its field/page bounds"));
        }
        let filters = q.filters.compiled()?;
        let x = if mode == Mode::Plot {
            Some(FieldPath::parse(&q.x)?)
        } else {
            None
        };
        if mode == Mode::Plot && q.ys.is_empty() {
            return Err(ApiError::bad("choose at least one Y field"));
        }
        let ys =
            q.ys.iter()
                .map(|s| FieldPath::parse(s))
                .collect::<Result<Vec<_>>>()?;
        let group = q
            .group
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(FieldPath::parse)
            .transpose()?;
        // Prefix completion visits only immediate children of the entered parent.
        // Arrays are containers there; search also visits their indexed children.
        let search = q.search.to_lowercase();
        let exact = if mode == Mode::Fields && !search.is_empty() {
            FieldPath::parse(&q.search)
                .ok()
                .or_else(|| {
                    (!q.search.contains(['.', '[', ']', '$']))
                        .then(|| FieldPath(vec![Segment::Key(q.search.clone())]))
                })
                .and_then(|p| {
                    let mut name = String::new();
                    for part in &p.0 {
                        name = match part {
                            Segment::Key(key) => key_path(&name, key),
                            Segment::Index(index) => {
                                format!("{}[{index}]", if name.is_empty() { "$" } else { &name })
                            }
                        };
                    }
                    (name.len() <= 1024).then_some((p, name))
                })
        } else {
            None
        };
        let (parent, needle) = if mode == Mode::Fields && search.is_empty() {
            if let Some(i) = completion_dot(&q.prefix) {
                (&q.prefix[..i], &q.prefix[i + 1..])
            } else {
                ("", q.prefix.as_str())
            }
        } else {
            ("", "")
        };
        let parent_path = if parent.is_empty() {
            None
        } else {
            Some(FieldPath::parse(parent)?)
        };
        let scope = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!([
                    q.source_id,
                    q.runs,
                    q.filters,
                    mode,
                    q.prefix,
                    q.search,
                    q.x,
                    q.ys,
                    q.group
                ]))
                .unwrap(),
            )
        );
        // File identity is distinct from the stable repository source ID. Pin
        // before opening and recheck after SQLite has read the file to catch a
        // replacement during open. Later requests compare the cursor generation.
        let generation = self.generation()?;
        let source_generation = URL_SAFE_NO_PAD.encode(self.run_filter_mac(generation.as_bytes()));
        if q.source_generation
            .as_ref()
            .is_some_and(|pin| pin != &source_generation)
        {
            return Err(ApiError::bad("rx source changed; refresh the catalog"));
        }
        let conn = self.connection()?;
        let record_budget = if mode == Mode::Plot {
            MAX_FILTER_RECORD
        } else {
            MAX_RECORD
        };
        if mode == Mode::Plot {
            conn.set_limit(
                rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
                (MAX_FILTER_RECORD + 4096) as i32,
            )
            .map_err(unavailable)?;
        }
        if self.generation()? != generation {
            return Err(ApiError::bad(
                "rx database replaced during open; retry the query",
            ));
        }
        let mut ids = Vec::new();
        let mut highs = Vec::new();
        for uid in &q.runs {
            let id: i64 = conn
                .query_row("SELECT id FROM runs WHERE run_uid=?", [uid], |r| r.get(0))
                .map_err(|_| ApiError::bad("an rx run is unavailable"))?;
            let high: Option<i64> = conn
                .query_row("SELECT max(seq) FROM events WHERE run_id=?", [id], |r| {
                    r.get(0)
                })
                .map_err(unavailable)?;
            ids.push(id);
            highs.push(high);
        }
        let mut cursor = if let Some(encoded) = &q.cursor {
            if encoded.len() > 4096 {
                return Err(ApiError::bad("record cursor exceeds its size limit"));
            }
            let stale = || ApiError::bad("invalid/stale record cursor; restart the query");
            let (payload, signature) = encoded.split_once('.').ok_or_else(stale)?;
            let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| stale())?;
            let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| stale())?;
            use subtle::ConstantTimeEq;
            if !bool::from(self.run_filter_mac(&bytes).ct_eq(&signature)) {
                return Err(stale());
            }
            serde_json::from_slice::<Cursor>(&bytes).map_err(|_| stale())?
        } else {
            Cursor {
                scope: scope.clone(),
                generation: generation.clone(),
                run: 0,
                seq: None,
                high: highs.clone(),
                ids: ids.clone(),
            }
        };
        if cursor.scope != scope
            || cursor.generation != generation
            || cursor.ids != ids
            || cursor.run >= ids.len()
            || cursor.high.len() != ids.len()
            || cursor.high.iter().zip(&highs).any(|(a, b)| a > b)
            || cursor.seq > cursor.high[cursor.run]
        {
            return Err(ApiError::bad(
                "invalid/stale record cursor; restart inspection",
            ));
        }
        let mut d = Diagnostics::default();
        let mut records = Vec::new();
        let mut hints: BTreeMap<String, Hint> = BTreeMap::new();
        let mut traces: BTreeMap<String, Trace> = BTreeMap::new();
        let started = Instant::now();
        let byte_budget = if mode == Mode::Records {
            2 * 1024 * 1024
        } else {
            MAX_BYTES
        };
        let mut visits = 0;
        let mut stopped = false;
        while cursor.run < ids.len() {
            let mut stmt=conn.prepare("SELECT seq,substr(received_at,1,64),octet_length(data),CASE WHEN octet_length(data)<=? THEN data ELSE NULL END FROM events WHERE run_id=? AND seq>=? AND (? IS NULL OR seq>?) AND seq<=? ORDER BY seq LIMIT ?").map_err(unavailable)?;
            let mut rows = stmt
                .query(params![
                    record_budget as i64,
                    ids[cursor.run],
                    cursor.seq.unwrap_or(i64::MIN),
                    cursor.seq,
                    cursor.seq,
                    cursor.high[cursor.run],
                    MAX_SCAN as i64 + 1
                ])
                .map_err(unavailable)?;
            while let Some(row) = rows.next().map_err(unavailable)? {
                // Stop BETWEEN events. Reserve room for all Ys of the next event,
                // including new groups, so continuation can never lose a Y pair.
                if d.scanned > 0
                    && (d.scanned >= MAX_SCAN
                        || d.bytes >= byte_budget
                        || started.elapsed() > Duration::from_millis(500)
                        || (mode == Mode::Plot
                            && (d.points + ys.len() > MAX_POINTS
                                || traces.len() + ys.len() > MAX_TRACES))
                        || (mode == Mode::Fields && d.scanned >= 2000))
                {
                    d.limit("scan budget reached");
                    stopped = true;
                    break;
                }
                let seq: i64 = row.get(0).map_err(unavailable)?;
                let bytes = row.get::<_, i64>(2).map_err(unavailable)? as usize;
                if d.scanned > 0 && bytes <= record_budget && d.bytes + bytes > byte_budget {
                    d.limit("byte budget reached");
                    stopped = true;
                    break;
                }
                cursor.seq = Some(seq);
                d.scanned += 1;
                if bytes > record_budget {
                    if mode == Mode::Plot {
                        return Err(ApiError(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "rx plot cannot complete: an event exceeds the 64 MiB row resource limit",
                        ));
                    }
                    d.oversized += 1;
                    d.limit("oversized records skipped");
                    continue;
                }
                d.bytes += bytes;
                let raw: String = row.get(3).map_err(unavailable)?;
                let value = if mode == Mode::Plot {
                    // rx producers permit NaN/Infinity. These remain nonnumeric
                    // axis values; unrelated finite fields in the event still plot.
                    FilterEvent::parse(&raw).map_err(|error| ApiError(error.0,
                        match error.0 {
                            StatusCode::PAYLOAD_TOO_LARGE => "rx plot cannot complete: event exceeds the 64 MiB normalized row or 16384 non-finite-number resource limit",
                            _ => "rx plot cannot complete: an event is invalid JSON or exceeds JSON parser limits",
                        }))?.value
                } else {
                    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                        d.invalid_json += 1;
                        d.limit("invalid JSON records skipped");
                        continue;
                    };
                    value
                };
                if !matches(&value, &filters, q.filters.any) {
                    continue;
                }
                d.matched += 1;
                match mode {
                    Mode::Records => {
                        let received_at: String = row.get(1).map_err(unavailable)?;
                        records.push(json!({"run_uid":q.runs[cursor.run],"seq":seq.to_string(),"received_at":received_at,"data":value,"raw":raw}));
                        if records.len() >= q.limit {
                            stopped = true;
                            break;
                        }
                    }
                    Mode::Fields if !search.is_empty() => {
                        // Probe explicit identity before unrelated siblings can
                        // exhaust traversal. Charge the bounded path to visits.
                        if let Some((path, name)) = &exact {
                            if visits + path.0.len() > MAX_VISITS {
                                d.limit("field visit budget reached");
                                stopped = true;
                                break;
                            }
                            visits += path.0.len();
                            if let Some(v) = path.get(&value) {
                                add_search_hint(
                                    &mut hints,
                                    &mut d,
                                    name.clone(),
                                    v,
                                    q.limit.min(MAX_FIELDS),
                                    &search,
                                    Some(name),
                                );
                            }
                        }
                        let mut searcher = FieldSearch {
                            needle: &search,
                            exact: exact.as_ref().map(|(_, name)| name.as_str()),
                            visits: &mut visits,
                            hints: &mut hints,
                            diagnostics: &mut d,
                            limit: q.limit.min(MAX_FIELDS),
                            started,
                        };
                        if !searcher.walk(&value, "", 0) {
                            stopped = true;
                            break;
                        }
                        // Do not consume the next event when this one exhausted
                        // the visit budget exactly; scan-more must still see it.
                        if visits >= MAX_VISITS {
                            d.limit("field visit budget reached");
                            stopped = true;
                            break;
                        }
                    }
                    Mode::Fields => {
                        let value = parent_path.as_ref().map_or(Some(&value), |p| p.get(&value));
                        if let Some(object) = value.and_then(Value::as_object) {
                            for (key, v) in object {
                                visits += 1;
                                if visits > MAX_VISITS {
                                    d.limit("field visit budget reached");
                                    break;
                                }
                                let path = key_path(parent, key);
                                if path.len() > 1024 {
                                    d.limit("oversized field paths skipped");
                                    continue;
                                }
                                if !(key.starts_with(needle) || path.starts_with(&q.prefix)) {
                                    continue;
                                }
                                add_hint(&mut hints, &mut d, path, v, MAX_FIELDS);
                            }
                        }
                        if visits > MAX_VISITS {
                            stopped = true;
                            break;
                        }
                    }
                    Mode::Plot => {
                        let Some(x) = x
                            .as_ref()
                            .unwrap()
                            .get(&value)
                            .and_then(Value::as_f64)
                            .filter(|v| v.is_finite())
                        else {
                            d.skipped_axes += ys.len();
                            continue;
                        };
                        let g = if let Some(p) = &group {
                            match p.get(&value) {
                                Some(v) if !v.is_array() && !v.is_object() => {
                                    if v.to_string().len() > 1024 {
                                        return Err(ApiError(
                                            StatusCode::PAYLOAD_TOO_LARGE,
                                            "rx plot cannot complete: a group label exceeds the 1024-byte resource limit",
                                        ));
                                    }
                                    Some(scalar_group(v))
                                }
                                _ => {
                                    d.skipped_groups += 1;
                                    continue;
                                }
                            }
                        } else {
                            None
                        };
                        for (index, path) in ys.iter().enumerate() {
                            let Some(y) = path
                                .get(&value)
                                .and_then(Value::as_f64)
                                .filter(|v| v.is_finite())
                            else {
                                d.skipped_axes += 1;
                                continue;
                            };
                            let key = serde_json::to_string(&(cursor.run, index, &g)).unwrap();
                            traces
                                .entry(key)
                                .or_insert_with(|| Trace {
                                    id: serde_json::to_string(&(
                                        &self.id,
                                        &q.runs[cursor.run],
                                        &q.ys[index],
                                        &q.group,
                                        &g,
                                    ))
                                    .unwrap(),
                                    group_label: g.as_ref().map(Value::to_string),
                                    run_uid: q.runs[cursor.run].clone(),
                                    y: q.ys[index].clone(),
                                    group: g.clone(),
                                    points: Vec::new(),
                                })
                                .points
                                .push((x, y, seq.to_string()));
                            d.points += 1;
                        }
                    }
                }
                if stopped {
                    break;
                }
            }
            if stopped {
                break;
            }
            cursor.run += 1;
            cursor.seq = None;
        }
        // Fields cursors continue at the next event, not within a truncated event.
        let next = if stopped {
            let payload = serde_json::to_vec(&cursor).unwrap();
            Some(format!(
                "{}.{}",
                URL_SAFE_NO_PAD.encode(&payload),
                URL_SAFE_NO_PAD.encode(self.run_filter_mac(&payload))
            ))
        } else {
            None
        };
        if self.generation()? != generation {
            return Err(ApiError::bad(
                "rx database replaced during query; refresh the catalog",
            ));
        }
        Ok(
            json!({"source_generation":source_generation,"diagnostics":d,"records":records,"next_cursor":next,"fields":hints.into_values().collect::<Vec<_>>(),"traces":traces.into_values().collect::<Vec<_>>(),"coverage":if mode==Mode::Fields {"sampled hints, not a complete schema"} else if mode==Mode::Records {"bounded page; append-only sequence pagination (in-place edits/lower-sequence inserts are not frozen)"} else {"bounded page of captured per-run high-water marks; continue next_cursor to completion; numeric axes use finite double precision"}}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        _dir: tempfile::TempDir,
        source: Source,
        writer: Connection,
    }
    fn fixture(wal: bool) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rx.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA user_version=8; CREATE TABLE runs(id INTEGER PRIMARY KEY,run_uid TEXT UNIQUE,state TEXT,alias TEXT,config TEXT,created_at TEXT,started_at TEXT,finished_at TEXT,exit_code INTEGER,argv TEXT); CREATE TABLE events(run_id INTEGER,seq INTEGER,received_at TEXT,data TEXT,UNIQUE(run_id,seq)); INSERT INTO runs VALUES(859,'uid859','succeeded',NULL,'summary','2026-10-12T00:00:00Z',NULL,NULL,0,'[]'); INSERT INTO runs VALUES(241,'uid241','succeeded',NULL,NULL,'2026-08-11T00:00:00Z',NULL,NULL,0,'[]');").unwrap();
        if wal {
            writer
                .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
                .unwrap();
        }
        let source = Source {
            path,
            id: "rx:test".into(),
            name: "fixture".into(),
            slots: Arc::new(Semaphore::new(2)),
            run_filter_key: [7; 32],
        };
        Fixture {
            _dir: dir,
            source,
            writer,
        }
    }
    fn add(f: &Fixture, run: i64, seq: i64, v: Value) {
        f.writer
            .execute(
                "INSERT INTO events VALUES(?,?,?,?)",
                params![run, seq, "2026-10-12T00:00:00Z", v.to_string()],
            )
            .unwrap();
    }
    fn request(v: Value) -> Request {
        let mut base = json!({"source_id":"rx:test","runs":["uid859"],"x":"epoch","ys":["train_loss","val_loss"],"filters":{"conditions":[{"path":"kind","op":"eq","value":"epoch"}]}});
        for (k, v) in v.as_object().unwrap() {
            base[k] = v.clone();
        }
        serde_json::from_value(base).unwrap()
    }
    #[test]
    fn epoch_fixture_two_six_point_traces_without_schema_or_data_mutation() {
        let f = fixture(false);
        add(&f, 859, 1, json!({"kind":"config","epoch":999}));
        for epoch in 1..=6 {
            add(
                &f,
                859,
                epoch + 4,
                json!({"kind":"epoch","phase":"validation","epoch":epoch,"train_loss":0.2/epoch as f64,"val_loss":0.3/epoch as f64}),
            );
        }
        let before = std::fs::read(&f.source.path).unwrap();
        let result = f.source.query(request(json!({})), Mode::Plot).unwrap();
        assert_eq!(result["traces"].as_array().unwrap().len(), 2);
        for trace in result["traces"].as_array().unwrap() {
            assert_eq!(trace["points"].as_array().unwrap().len(), 6);
            assert_eq!(trace["points"][0][0], 1.0);
            assert_eq!(trace["points"][0][2], "5");
        }
        assert_eq!(result["diagnostics"]["matched"], 6);
        assert_eq!(before, std::fs::read(&f.source.path).unwrap());
        assert!(
            f.source
                .connection()
                .unwrap()
                .execute("CREATE TABLE forbidden(x)", [])
                .is_err()
        );
    }
    #[test]
    fn nested_literal_indices_fractional_repeated_and_nonmonotonic_x() {
        let f = fixture(false);
        for (i, x) in [0.1, 0.1, 0.05].into_iter().enumerate() {
            add(
                &f,
                241,
                i as i64 + 16,
                json!({"kind":"metric","phase":"train","step":i,"epochs_seen":x,"metrics":{"loss":i+1},"metrics.loss":90,"arr":[{"loss":4}]}),
            );
        }
        add(
            &f,
            241,
            30,
            json!({"kind":"metric","phase":"eval","epochs_seen":1,"metrics":{"loss":999}}),
        );
        let q = json!({"runs":["uid241"],"x":"epochs_seen","ys":["metrics.loss","$[\"metrics.loss\"]","arr[0].loss"],"filters":{"conditions":[{"path":"kind","op":"eq","value":"metric"},{"path":"phase","op":"eq","value":"train"}]}});
        let result = f.source.query(request(q.clone()), Mode::Plot).unwrap();
        assert_eq!(
            result["traces"][0]["points"],
            json!([[0.1, 1.0, "16"], [0.1, 2.0, "17"], [0.05, 3.0, "18"]])
        );
        assert_eq!(result["traces"][1]["points"][0][1], 90.0);
        let mut fields = q;
        fields["prefix"] = json!("metrics.");
        let result = f.source.query(request(fields), Mode::Fields).unwrap();
        assert_eq!(result["fields"][0]["path"], "metrics.loss");
        assert_eq!(result["diagnostics"]["matched"], 3);
        for bad in ["", "metrics.", "a..b", "a[-1]", "$", "a[", "a b"] {
            assert!(FieldPath::parse(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn typed_groups_filters_and_sparse_values() {
        let f = fixture(false);
        for (i, g) in [json!(1), json!("1"), json!(true), Value::Null, json!({})]
            .into_iter()
            .enumerate()
        {
            add(
                &f,
                859,
                i as i64 + 1,
                json!({"kind":"epoch","epoch":0.5,"train_loss":i,"group":g}),
            );
        }
        add(
            &f,
            859,
            6,
            json!({"kind":"epoch","epoch":true,"train_loss":9,"group":1}),
        );
        add(
            &f,
            859,
            7,
            json!({"kind":"epoch","epoch":2,"train_loss":"9","group":1}),
        );
        let result = f
            .source
            .query(request(json!({"group":"group"})), Mode::Plot)
            .unwrap();
        assert_eq!(result["traces"].as_array().unwrap().len(), 4);
        assert_eq!(result["diagnostics"]["skipped_groups"], 1);
        assert_eq!(result["diagnostics"]["points"], 4);
        let result = f
            .source
            .query(
                request(json!({"filters":{"conditions":[{"path":"group","op":"eq","value":"1"}]}})),
                Mode::Plot,
            )
            .unwrap();
        assert_eq!(result["diagnostics"]["matched"], 1);
        let result = f
            .source
            .query(
                request(
                    json!({"filters":{"conditions":[{"path":"absent","op":"ne","value":null}]}}),
                ),
                Mode::Plot,
            )
            .unwrap();
        assert_eq!(result["diagnostics"]["matched"], 0);
    }
    #[test]
    fn inspection_cursor_is_scoped_and_snapshot_bounded() {
        let f = fixture(false);
        for i in 1..=3 {
            add(&f, 859, i, json!({"kind":"epoch","epoch":i,"train_loss":i}));
        }
        let first = f
            .source
            .query(request(json!({"limit":2})), Mode::Records)
            .unwrap();
        assert_eq!(first["records"][0]["data"]["epoch"], 1);
        assert_eq!(first["records"][0]["seq"], "1");
        add(&f, 859, 4, json!({"kind":"epoch","epoch":4}));
        let second = f
            .source
            .query(
                request(json!({"cursor":first["next_cursor"],"limit":2})),
                Mode::Records,
            )
            .unwrap();
        assert_eq!(second["records"].as_array().unwrap().len(), 1);
        assert_eq!(second["records"][0]["seq"], "3");
        assert!(
            f.source
                .query(
                    request(json!({"cursor":first["next_cursor"],"filters":{"conditions":[]}})),
                    Mode::Records
                )
                .is_err()
        );
    }
    #[test]
    fn live_committed_wal_updates_with_concurrent_writer() {
        let f = fixture(true);
        add(&f, 859, 1, json!({"kind":"epoch","epoch":1,"train_loss":1}));
        let read = f.source.connection().unwrap();
        let count: i64 = read
            .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        f.writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        add(&f, 859, 2, json!({"kind":"epoch","epoch":2,"train_loss":2}));
        let before = f.source.query(request(json!({})), Mode::Plot).unwrap();
        assert_eq!(before["diagnostics"]["matched"], 1);
        f.writer.execute_batch("COMMIT").unwrap();
        let after = f.source.query(request(json!({})), Mode::Plot).unwrap();
        assert_eq!(after["diagnostics"]["matched"], 2);
        let count: i64 = read
            .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        drop(read);
        let path = f.source.path.clone();
        let source = f.source.clone();
        let worker = std::thread::spawn(move || {
            let writer = Connection::open(path).unwrap();
            for seq in 3..103 {
                writer
                    .execute(
                        "INSERT INTO events VALUES(?,?,?,?)",
                        params![
                            859,
                            seq,
                            "now",
                            format!("{{\"kind\":\"epoch\",\"epoch\":{seq},\"train_loss\":1}}")
                        ],
                    )
                    .unwrap();
            }
        });
        for _ in 0..10 {
            source.query(request(json!({})), Mode::Plot).unwrap();
        }
        worker.join().unwrap();
        assert_eq!(
            source.query(request(json!({})), Mode::Plot).unwrap()["diagnostics"]["matched"],
            102
        );
    }
    #[test]
    fn stopped_wal_without_sidecars_is_readable_and_schema_is_never_migrated() {
        let f = fixture(true);
        add(&f, 859, 1, json!({}));
        let source = f.source.clone();
        drop(f.writer);
        let wal = PathBuf::from(format!("{}-wal", source.path.display()));
        let shm = PathBuf::from(format!("{}-shm", source.path.display()));
        assert!(!wal.exists() && !shm.exists());
        let before = std::fs::read(&source.path).unwrap();
        for _ in 0..2 {
            let conn = source.connection().unwrap();
            assert!(
                conn.db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE)
                    .unwrap()
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            conn.pragma_update(None, "query_only", false).unwrap();
            assert!(
                conn.execute("DELETE FROM events", []).is_err(),
                "database itself must be read-only"
            );
            drop(conn);
            assert_eq!(before, std::fs::read(&source.path).unwrap());
            assert!(
                std::fs::metadata(&wal).map_or(true, |m| m.len() <= 32),
                "reader must not append WAL frames"
            );
        }
        let f = fixture(false);
        f.writer.pragma_update(None, "user_version", 7).unwrap();
        assert!(f.source.connection().is_err());
        assert_eq!(
            f.writer
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            7
        );
    }
    #[test]
    fn oversized_records_and_field_budget_are_reported() {
        let f = fixture(false);
        add(&f, 859, 1, json!({"huge":"x".repeat(MAX_RECORD)}));
        let fields = (0..100)
            .map(|i| (format!("key{i}"), json!(i)))
            .collect::<serde_json::Map<_, _>>();
        add(&f, 859, 2, Value::Object(fields));
        let result = f
            .source
            .query(request(json!({"filters":{"conditions":[]}})), Mode::Fields)
            .unwrap();
        assert_eq!(result["fields"].as_array().unwrap().len(), 64);
        assert_eq!(result["diagnostics"]["oversized"], 1);
        assert_eq!(result["diagnostics"]["partial"], true);
    }
    #[test]
    fn plot_sequence_zero_and_negative_positions_are_not_start_sentinels() {
        let f = fixture(false);
        for seq in [-1, 0, 1] {
            add(
                &f,
                859,
                seq,
                json!({"kind":"epoch","epoch":0.25,"train_loss":seq}),
            );
        }
        let result = f
            .source
            .query(request(json!({"ys":["train_loss"]})), Mode::Plot)
            .unwrap();
        assert_eq!(
            result["traces"][0]["points"],
            json!([[0.25, -1.0, "-1"], [0.25, 0.0, "0"], [0.25, 1.0, "1"]])
        );
        assert!(result["next_cursor"].is_null());
    }
    #[test]
    fn oversized_plot_group_is_an_explicit_resource_error_not_a_dropped_trace() {
        let f = fixture(false);
        add(
            &f,
            859,
            1,
            json!({"kind":"epoch","epoch":1,"train_loss":1,"group":"x".repeat(1025)}),
        );
        let error = f
            .source
            .query(request(json!({"group":"group"})), Mode::Plot)
            .unwrap_err();
        assert_eq!(error.0, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(error.1.contains("group label"));
    }
    #[test]
    fn typed_numeric_equality_and_group_pagination() {
        assert!(scalar_equal(&json!(1), &json!(1.0)));
        assert!(!scalar_equal(&json!(1), &json!(true)));
        assert!(!scalar_equal(&json!(1), &json!("1")));
        assert!(!scalar_equal(
            &json!(9007199254740993u64),
            &json!(9007199254740992.0)
        ));
        let f = fixture(false);
        for i in 1..=130 {
            add(
                &f,
                859,
                i,
                json!({"kind":"epoch","epoch":i,"train_loss":i,"g":i}),
            );
        }
        let result = f
            .source
            .query(
                request(json!({"group":"g","ys":["train_loss"]})),
                Mode::Plot,
            )
            .unwrap();
        assert_eq!(result["traces"].as_array().unwrap().len(), 128);
        assert_eq!(result["diagnostics"]["omitted_traces"], 0);
        assert_eq!(result["diagnostics"]["partial"], true);
        let last = f
            .source
            .query(
                request(json!({"group":"g","ys":["train_loss"],"cursor":result["next_cursor"]})),
                Mode::Plot,
            )
            .unwrap();
        assert_eq!(last["traces"].as_array().unwrap().len(), 2);
        assert_eq!(last["diagnostics"]["omitted_traces"], 0);
        assert!(last["next_cursor"].is_null());
    }
    #[test]
    fn groups_normalize_numbers_but_retain_large_integer_identity() {
        let f = fixture(false);
        for (i, g) in [
            json!(1),
            json!(1.0),
            json!("1"),
            json!(9007199254740992u64),
            json!(9007199254740993u64),
        ]
        .into_iter()
        .enumerate()
        {
            add(
                &f,
                859,
                i as i64 + 1,
                json!({"kind":"epoch","epoch":i,"train_loss":i,"g":g}),
            );
        }
        let result = f
            .source
            .query(
                request(json!({"group":"g","ys":["train_loss"]})),
                Mode::Plot,
            )
            .unwrap();
        let traces = result["traces"].as_array().unwrap();
        assert_eq!(traces.len(), 4);
        assert_eq!(
            traces
                .iter()
                .map(|v| v["id"].as_str().unwrap())
                .collect::<BTreeSet<_>>()
                .len(),
            4
        );
        assert!(
            traces
                .iter()
                .any(|v| v["group_label"] == "9007199254740993")
        );
        assert!(
            traces
                .iter()
                .any(|v| v["points"].as_array().unwrap().len() == 2)
        );
    }
    #[test]
    fn inspection_keeps_original_json_text_and_large_integer_identity() {
        let f = fixture(false);
        let raw = "{ \"kind\": \"epoch\", \"id\": 9007199254740993, \"loss\": 1.00 }";
        f.writer
            .execute("INSERT INTO events VALUES(859,1,'now',?)", [raw])
            .unwrap();
        let result = f.source.query(request(json!({})), Mode::Records).unwrap();
        assert_eq!(result["records"][0]["raw"], raw);
        assert_eq!(result["records"][0]["data"]["id"], 9007199254740993u64);
    }
    #[test]
    fn huge_utf8_rows_use_metadata_only_size_guard_and_advance_all_modes() {
        let f = fixture(false);
        add(&f, 859, 1, json!({"huge":"\u{1f680}".repeat(1024 * 1024)}));
        for seq in 2..=3 {
            add(
                &f,
                859,
                seq,
                json!({"kind":"epoch","epoch":seq,"train_loss":0.5}),
            );
        }
        let conn = f.source.connection().unwrap();
        let mut plan = conn
            .prepare("EXPLAIN SELECT octet_length(data) FROM events")
            .unwrap();
        let metadata_flags = plan
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(6)?,
                ))
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            metadata_flags
                .iter()
                .any(|(op, col, flags)| op == "Column" && *col == 3 && flags & 0xc0 != 0),
            "{metadata_flags:?}"
        );
        for mode in [Mode::Records, Mode::Fields, Mode::Plot] {
            let result = f.source.query(request(json!({"limit":1})), mode).unwrap();
            if mode == Mode::Plot {
                assert_eq!(result["diagnostics"]["oversized"], 0);
                assert_eq!(result["diagnostics"]["partial"], false);
                assert!(result["diagnostics"]["bytes"].as_u64().unwrap() > 1024 * 1024);
            } else {
                assert_eq!(result["diagnostics"]["oversized"], 1);
                assert_eq!(result["diagnostics"]["partial"], true);
                assert!(result["diagnostics"]["bytes"].as_u64().unwrap() < 1024);
            }
            if mode == Mode::Records {
                assert_eq!(result["records"][0]["seq"], "2");
                let next = f
                    .source
                    .query(
                        request(json!({"limit":1,"cursor":result["next_cursor"]})),
                        mode,
                    )
                    .unwrap();
                assert_eq!(next["records"][0]["seq"], "3");
            } else {
                assert_eq!(result["diagnostics"]["matched"], 2);
            }
        }
    }
    #[test]
    fn object_keys_and_array_indices_are_distinct() {
        let value = json!({"obj":{"0":7},"arr":[7,null],"nil":null});
        for (path, expected) in [
            ("obj[0]", None),
            ("obj[\"0\"]", Some(json!(7))),
            ("arr[0]", Some(json!(7))),
            ("arr[\"0\"]", None),
            ("arr.length", None),
            ("arr[1]", Some(Value::Null)),
            ("nil", Some(Value::Null)),
            ("missing", None),
        ] {
            assert_eq!(
                FieldPath::parse(path).unwrap().get(&value),
                expected.as_ref(),
                "{path}"
            );
        }
    }
    #[test]
    fn integer_aware_ordering_including_float_boundary_and_negative_values() {
        for (a, b) in [
            (json!(9007199254740993u64), json!(9007199254740992u64)),
            (json!(9007199254740993u64), json!(9007199254740992.0)),
            (json!(-9007199254740992i64), json!(-9007199254740993i64)),
            (json!(u64::MAX), json!(i64::MAX)),
            (json!(0), json!(-0.5)),
            (json!(1.5), json!(1)),
            (json!(1e30), json!(u64::MAX)),
            (json!(i64::MIN), json!(-1e30)),
        ] {
            assert_eq!(numeric_cmp(&a, &b), Some(Ordering::Greater), "{a} > {b}");
            assert_eq!(numeric_cmp(&b, &a), Some(Ordering::Less));
        }
        assert_eq!(numeric_cmp(&json!(true), &json!(1)), None);
        assert_eq!(numeric_cmp(&json!(1), &json!(1.0)), Some(Ordering::Equal));
        assert!(!safe_hint_value(&json!(9007199254740993u64)));
    }
    #[test]
    fn atomic_replacement_invalidates_cursor_without_changing_source_identity() {
        let f = fixture(false);
        let replacement = fixture(false);
        for seq in 1..=3 {
            add(&f, 859, seq, json!({"kind":"epoch","epoch":seq}));
            add(
                &replacement,
                859,
                seq,
                json!({"kind":"epoch","epoch":100+seq}),
            );
        }
        let first = f
            .source
            .query(request(json!({"limit":1})), Mode::Records)
            .unwrap();
        let id = f.source.id.clone();
        drop(replacement.writer);
        std::fs::rename(&replacement.source.path, &f.source.path).unwrap();
        assert_eq!(f.source.id, id);
        let stale = f
            .source
            .query(
                request(json!({"limit":1,"cursor":first["next_cursor"]})),
                Mode::Records,
            )
            .unwrap_err();
        assert!(stale.1.contains("stale record cursor"));
        let fresh = f
            .source
            .query(request(json!({"limit":1})), Mode::Records)
            .unwrap();
        assert_eq!(fresh["records"][0]["data"]["epoch"], 101);
    }
    #[cfg(unix)]
    #[test]
    fn unreadable_source_is_reported_without_permission_or_database_changes() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture(false);
        drop(f.writer);
        let before = std::fs::read(&f.source.path).unwrap();
        let permissions = std::fs::metadata(&f.source.path).unwrap().permissions();
        std::fs::set_permissions(&f.source.path, std::fs::Permissions::from_mode(0)).unwrap();
        let privileged = std::fs::File::open(&f.source.path).is_ok();
        let result = f.source.connection();
        let mode = std::fs::metadata(&f.source.path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        std::fs::set_permissions(&f.source.path, permissions).unwrap();
        assert_eq!(mode, 0);
        if !privileged {
            assert_eq!(result.unwrap_err().0, StatusCode::SERVICE_UNAVAILABLE);
        } else {
            eprintln!("permission denial assertion skipped for privileged user");
        }
        assert_eq!(before, std::fs::read(&f.source.path).unwrap());
    }
}

// RUN clauses are independent existential queries, not a conjunction on one event.
// Python's json.dumps (used by rx producers) emits NaN/Infinity by default.
// Keep these distinct from JSON null and strings. The ordinary JSON fast path
// remains unchanged; the fallback only rewrites unquoted numeric extensions.
struct FilterEvent {
    value: Value,
    marker: Option<String>,
}
impl FilterEvent {
    fn parse(raw: &str) -> Result<Self> {
        let unreadable = || {
            ApiError(
                StatusCode::UNPROCESSABLE_ENTITY,
                "rx run filter cannot complete: an event is not valid JSON text or exceeds JSON parser limits",
            )
        };
        if let Ok(value) = serde_json::from_str(raw) {
            return Ok(Self {
                value,
                marker: None,
            });
        }
        let marker = format!("rx-nonfinite-{}", uuid::Uuid::new_v4());
        let bytes = raw.as_bytes();
        let mut normalized = Vec::with_capacity(bytes.len());
        let (mut i, mut start, mut count) = (0, 0, 0);
        let mut quoted = false;
        let mut quote_start = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'\\' if quoted => {
                    i += 2;
                    continue;
                }
                b'"' => {
                    if quoted {
                        let text = &bytes[quote_start..=i];
                        // An ASCII marker can only decode from 1–6 bytes per
                        // character. Check original strings, not surviving map
                        // values: duplicate object keys legitimately overwrite.
                        if (marker.len() + 2..=marker.len() * 6 + 2).contains(&text.len())
                            && serde_json::from_slice::<String>(text).ok().as_deref()
                                == Some(marker.as_str())
                        {
                            return Err(unreadable());
                        }
                    } else {
                        quote_start = i;
                    }
                    quoted = !quoted;
                }
                _ => {}
            }
            if !quoted {
                let token = [
                    (b"NaN".as_slice(), 0),
                    (b"Infinity".as_slice(), 1),
                    (b"-Infinity".as_slice(), 2),
                ]
                .into_iter()
                .find(|(token, _)| bytes[i..].starts_with(token));
                if let Some((token, kind)) = token {
                    if count >= MAX_FILTER_NONFINITE {
                        return Err(ApiError(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "rx run filter cannot complete: an event exceeds the 16384 non-finite-number resource limit",
                        ));
                    }
                    let replacement = format!("{{\"{marker}\":{kind}}}");
                    if normalized.len() + i - start + replacement.len() > MAX_FILTER_RECORD {
                        return Err(ApiError(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            "rx run filter cannot complete: normalized event exceeds the 64 MiB row resource limit",
                        ));
                    }
                    normalized.extend_from_slice(&bytes[start..i]);
                    normalized.extend_from_slice(replacement.as_bytes());
                    count += 1;
                    i += token.len();
                    start = i;
                    continue;
                }
            }
            i += 1;
        }
        if count == 0 {
            return Err(unreadable());
        }
        if normalized.len() + bytes.len() - start > MAX_FILTER_RECORD {
            return Err(ApiError(
                StatusCode::PAYLOAD_TOO_LARGE,
                "rx run filter cannot complete: normalized event exceeds the 64 MiB row resource limit",
            ));
        }
        normalized.extend_from_slice(&bytes[start..]);
        let value = serde_json::from_slice(&normalized).map_err(|_| unreadable())?;
        Ok(Self {
            value,
            marker: Some(marker),
        })
    }
    fn nonfinite(&self, value: &Value) -> Option<f64> {
        let marker = self.marker.as_ref()?;
        let map = value.as_object()?;
        if map.len() != 1 {
            return None;
        }
        match map.get(marker)?.as_u64()? {
            0 => Some(f64::NAN),
            1 => Some(f64::INFINITY),
            2 => Some(f64::NEG_INFINITY),
            _ => None,
        }
    }
    fn get(&self, path: &FieldPath) -> Option<&Value> {
        let mut value = &self.value;
        for segment in &path.0 {
            if self.nonfinite(value).is_some() {
                return None;
            }
            value = match segment {
                Segment::Key(key) => value.as_object()?.get(key)?,
                Segment::Index(index) => value.as_array()?.get(*index)?,
            };
        }
        Some(value)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunFilterRequest {
    source_id: String,
    runs: Vec<String>,
    conditions: Vec<Condition>,
    #[serde(default)]
    cursor: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RunProof {
    // A witnessed match (or witnessed presence for `missing`). Never undone.
    found: Vec<bool>,
    after: Option<i64>,
    complete: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RunFilterCursor {
    scope: String,
    generation: String,
    ids: Vec<i64>,
    high: Vec<Option<i64>>,
    run: usize,
    proofs: Vec<RunProof>,
}

pub async fn run_filter(
    State(state): State<AppState>,
    Json(q): Json<RunFilterRequest>,
) -> Result<Json<Value>> {
    let source = state
        .rx
        .ok_or_else(|| ApiError::bad("no rx repository is configured"))?;
    source.execute(move |s| s.filter_runs(q)).await.map(Json)
}

impl Source {
    // HMAC-SHA256 over the cursor bytes. A process-local source key means restart
    // invalidates cursors; clients cannot manufacture proof state or high waters.
    fn run_filter_mac(&self, payload: &[u8]) -> Vec<u8> {
        let mut inner_pad = [0x36; 64];
        let mut outer_pad = [0x5c; 64];
        for (i, b) in self.run_filter_key.iter().enumerate() {
            inner_pad[i] ^= b;
            outer_pad[i] ^= b;
        }
        let mut inner = Sha256::new();
        inner.update(inner_pad);
        inner.update(payload);
        let mut outer = Sha256::new();
        outer.update(outer_pad);
        outer.update(inner.finalize());
        outer.finalize().to_vec()
    }

    fn filter_runs(&self, q: RunFilterRequest) -> Result<Value> {
        if q.source_id != self.id {
            return Err(ApiError::bad(
                "saved rx source is unavailable; configure the same repository",
            ));
        }
        if q.runs.is_empty()
            || q.runs.len() > 32
            || q.runs.iter().any(|s| s.is_empty() || s.len() > 128)
            || q.runs.iter().collect::<BTreeSet<_>>().len() != q.runs.len()
        {
            return Err(ApiError::bad("select 1-32 distinct rx run identities"));
        }
        if q.conditions.len() > 16 {
            return Err(ApiError::bad("at most 16 run conditions are allowed"));
        }
        let paths = q.conditions.iter().map(|c| {
            if !["eq", "ne", "lt", "lte", "gt", "gte", "contains", "exists", "missing"].contains(&c.op.as_str())
                || c.value.is_array() || c.value.is_object() || c.value.to_string().len() > 1024
                || (c.op == "contains" && !c.value.is_string())
                || (["lt", "lte", "gt", "gte"].contains(&c.op.as_str()) && !c.value.is_number())
            {
                return Err(ApiError::bad("invalid run condition (use a typed JSON scalar; contains requires a string and ordering requires a number)"));
            }
            FieldPath::parse(&c.path)
        }).collect::<Result<Vec<_>>>()?;
        let scope = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!(["run-filter-v2", q.source_id, q.runs, q.conditions]))
                    .unwrap()
            )
        );
        let generation = self.generation()?;
        let conn = self.connection()?;
        // The shared preview reader caps SQLite values at 1 MiB. Complete-record
        // queries may materialize larger events; allow bounded row overhead
        // while the SELECT's CASE still enforces MAX_FILTER_RECORD on data.
        conn.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            (MAX_FILTER_RECORD + 4096) as i32,
        )
        .map_err(unavailable)?;
        if self.generation()? != generation {
            return Err(ApiError::bad(
                "rx database replaced during open; retry the query",
            ));
        }
        let mut ids = Vec::new();
        let mut high = Vec::new();
        for uid in &q.runs {
            let id: i64 = conn
                .query_row("SELECT id FROM runs WHERE run_uid=?", [uid], |r| r.get(0))
                .map_err(|_| ApiError::bad("an rx run is unavailable"))?;
            let last: Option<i64> = conn
                .query_row("SELECT max(seq) FROM events WHERE run_id=?", [id], |r| {
                    r.get(0)
                })
                .map_err(unavailable)?;
            ids.push(id);
            high.push(last);
        }
        let stale = || ApiError::bad("invalid/stale run filter cursor; restart filtering");
        let mut cursor = if let Some(encoded) = &q.cursor {
            if encoded.len() > 16 * 1024 {
                return Err(stale());
            }
            let (payload, signature) = encoded.split_once('.').ok_or_else(stale)?;
            let payload = URL_SAFE_NO_PAD.decode(payload).map_err(|_| stale())?;
            let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| stale())?;
            use subtle::ConstantTimeEq;
            if !bool::from(self.run_filter_mac(&payload).ct_eq(&signature)) {
                return Err(stale());
            }
            serde_json::from_slice::<RunFilterCursor>(&payload).map_err(|_| stale())?
        } else {
            RunFilterCursor {
                scope: scope.clone(),
                generation: generation.clone(),
                ids: ids.clone(),
                high: high.clone(),
                run: 0,
                proofs: high
                    .iter()
                    .map(|h| RunProof {
                        found: vec![false; paths.len()],
                        after: None,
                        complete: h.is_none(),
                    })
                    .collect(),
            }
        };
        if cursor.scope != scope
            || cursor.generation != generation
            || cursor.ids != ids
            || cursor.run >= ids.len()
            || cursor.high.len() != ids.len()
            || cursor.proofs.len() != ids.len()
            || cursor.high.iter().zip(&high).any(|(old, now)| old > now)
            || cursor
                .proofs
                .iter()
                .zip(&cursor.high)
                .any(|(p, h)| p.found.len() != paths.len() || p.after > *h)
        {
            return Err(stale());
        }

        let mut d = Diagnostics::default();
        let started = Instant::now();
        // The producer's UNIQUE(run_id, seq) index serves both high waters and
        // keyset pages. Separate initial/resume predicates also cover signed seq.
        while cursor.run < ids.len() {
            let index = cursor.run;
            let proof = &mut cursor.proofs[index];
            if proof.complete || paths.is_empty() {
                proof.complete = true;
                cursor.run += 1;
                continue;
            }
            let sql = if proof.after.is_some() {
                "SELECT seq,octet_length(data),CASE WHEN octet_length(data)<=? THEN data ELSE NULL END FROM events WHERE run_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?"
            } else {
                "SELECT seq,octet_length(data),CASE WHEN octet_length(data)<=? THEN data ELSE NULL END FROM events WHERE run_id=? AND seq>=? AND seq<=? ORDER BY seq LIMIT ?"
            };
            let mut stmt = conn.prepare(sql).map_err(unavailable)?;
            let mut rows = stmt
                .query(params![
                    MAX_FILTER_RECORD as i64,
                    ids[index],
                    proof.after.unwrap_or(i64::MIN),
                    cursor.high[index],
                    MAX_SCAN as i64 + 1
                ])
                .map_err(unavailable)?;
            let mut stopped = false;
            while let Some(row) = rows.next().map_err(unavailable)? {
                // Always consume at least one row per request, even if preparing
                // the snapshot/query used the time allowance. This prevents a
                // valid large row from producing the same cursor forever.
                if d.scanned > 0
                    && (d.scanned >= MAX_SCAN
                        || d.bytes >= MAX_BYTES
                        || started.elapsed() > Duration::from_millis(500))
                {
                    d.limit("scan budget reached");
                    stopped = true;
                    break;
                }
                let seq: i64 = row.get(0).map_err(unavailable)?;
                let bytes = row
                    .get::<_, Option<i64>>(1)
                    .map_err(unavailable)?
                    .unwrap_or(0)
                    .max(0) as usize;
                if bytes > MAX_FILTER_RECORD {
                    return Err(ApiError(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "rx run filter cannot complete: an event exceeds the 64 MiB row resource limit",
                    ));
                }
                if d.scanned > 0 && d.bytes + bytes > MAX_BYTES {
                    d.limit("byte budget reached");
                    stopped = true;
                    break;
                }
                proof.after = Some(seq);
                d.scanned += 1;
                d.bytes += bytes;
                // Blob/NULL, malformed JSON, and JSON beyond parser limits
                // cannot establish absence. Fail visibly, never finish unknown.
                let unreadable = || {
                    ApiError(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "rx run filter cannot complete: an event is not valid JSON text or exceeds JSON parser limits",
                    )
                };
                let raw = row.get::<_, String>(2).map_err(|_| unreadable())?;
                let value = FilterEvent::parse(&raw)?;
                for ((path, c), found) in paths.iter().zip(&q.conditions).zip(&mut proof.found) {
                    if *found {
                        continue;
                    }
                    let v = value.get(path);
                    let nonfinite = v.and_then(|v| value.nonfinite(v));
                    *found = match c.op.as_str() {
                        "exists" | "missing" => v.is_some(),
                        "eq" => nonfinite.is_none() && v.is_some_and(|v| scalar_equal(v, &c.value)),
                        "ne" => v.is_some_and(|v| !scalar_equal(v, &c.value)),
                        "contains" => v
                            .and_then(Value::as_str)
                            .is_some_and(|v| v.contains(c.value.as_str().unwrap())),
                        op => nonfinite
                            .map_or_else(
                                || v.and_then(|v| numeric_cmp(v, &c.value)),
                                |number| {
                                    c.value
                                        .as_f64()
                                        .and_then(|other| number.partial_cmp(&other))
                                },
                            )
                            .is_some_and(|order| match op {
                                "lt" => order.is_lt(),
                                "lte" => !order.is_gt(),
                                "gt" => order.is_gt(),
                                "gte" => !order.is_lt(),
                                _ => false,
                            }),
                    };
                }
                // All existential witnesses (including presence disproving
                // `missing`) are immutable; no later row can change them.
                if proof.found.iter().all(|found| *found) {
                    break;
                }
            }
            if stopped {
                break;
            }
            proof.complete = true;
            cursor.run += 1;
        }
        let runs = q
            .runs
            .iter()
            .zip(&cursor.proofs)
            .map(|(uid, proof)| {
                let conditions: Vec<Option<bool>> = q
                    .conditions
                    .iter()
                    .zip(&proof.found)
                    .map(|(c, found)| {
                        if c.op == "missing" {
                            if *found {
                                Some(false)
                            } else if proof.complete {
                                Some(true)
                            } else {
                                None
                            }
                        } else if *found {
                            Some(true)
                        } else if proof.complete {
                            Some(false)
                        } else {
                            None
                        }
                    })
                    .collect();
                if conditions.iter().any(Option::is_none) {
                    d.limit("unproved run conditions");
                }
                json!({"uid":uid,"conditions":conditions})
            })
            .collect::<Vec<_>>();
        let next = if cursor.run < ids.len() {
            d.limit("scan incomplete");
            let payload = serde_json::to_vec(&cursor).unwrap();
            Some(format!(
                "{}.{}",
                URL_SAFE_NO_PAD.encode(&payload),
                URL_SAFE_NO_PAD.encode(self.run_filter_mac(&payload))
            ))
        } else {
            None
        };
        // Every page (including a completed, cursorless batch) identifies the
        // physical source generation. Keep filesystem identity opaque, and bind
        // it to this process so a restarted reader also requires fresh proofs.
        if self.generation()? != generation {
            return Err(stale());
        }
        let source_generation = URL_SAFE_NO_PAD.encode(self.run_filter_mac(generation.as_bytes()));
        Ok(json!({"runs":runs,"cursor":next,"diagnostics":d,"source_generation":source_generation}))
    }
}
