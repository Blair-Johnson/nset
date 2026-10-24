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
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
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
const MAX_POINTS: usize = 20_000;
const MAX_TRACES: usize = 128;
const MAX_FIELDS: usize = 64;
const MAX_VISITS: usize = 4096;
const UNAVAILABLE: &str = "rx source unavailable: cannot read a live SQLite snapshot. Check permissions and readable WAL/-shm sidecars; nset never repairs or opens the source read-write. Native data remains available.";
fn unavailable(e: impl std::fmt::Display) -> ApiError {
    tracing::warn!(error=%e, "rx read-only source unavailable");
    ApiError(StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE)
}
#[derive(Clone)]
pub struct Source {
    path: PathBuf,
    pub id: String,
    pub name: String,
    slots: Arc<Semaphore>,
}
impl Source {
    pub fn resolve(repo: &Path) -> Result<Self> {
        // Only this startup path is used; Git receives argv, never a shell command.
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
            .env("GIT_OPTIONAL_LOCKS", "0")
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
        })
    }
    fn connection(&self) -> Result<Connection> {
        // Read-only WAL open can create missing sidecars. Refuse that case before
        // opening; never use immutable=1 (which misses committed WAL updates).
        let mut header = [0u8; 100];
        std::fs::File::open(&self.path)
            .and_then(|mut f| f.read_exact(&mut header))
            .map_err(unavailable)?;
        if &header[..16] != b"SQLite format 3\0" {
            return Err(unavailable("not a SQLite database"));
        }
        if header[18] == 2 {
            for suffix in ["-wal", "-shm"] {
                if !PathBuf::from(format!("{}{suffix}", self.path.display())).is_file() {
                    return Err(unavailable("WAL sidecars absent; refusing to create them"));
                }
            }
        }
        crate::rx_vfs::register()
            .map_err(|code| unavailable(format!("read-only VFS registration failed: {code}")))?;
        let encoded = percent_encoding::percent_encode(
            self.path.as_os_str().as_encoded_bytes(),
            percent_encoding::NON_ALPHANUMERIC,
        );
        let uri = format!("file:{encoded}?mode=ro&readonly_shm=1");
        let conn = Connection::open_with_flags_and_vfs(
            uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
            crate::rx_vfs::NAME,
        )
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
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(unavailable)?;
        if version != 8 {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "rx source uses an unsupported schema; this reader supports schema 8 and does not migrate databases",
            ));
        }
        conn.execute_batch("BEGIN DEFERRED").map_err(unavailable)?;
        Ok(conn)
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
    let result = source.execute(move |s| s.runs(q.after)).await;
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
    fn runs(&self, after: i64) -> Result<Value> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare("SELECT id,substr(run_uid,1,129),substr(state,1,64),substr(alias,1,512),substr(config,1,4096),substr(created_at,1,64),substr(started_at,1,64),substr(finished_at,1,64),exit_code,substr(argv,1,4096) FROM runs WHERE id>? ORDER BY id LIMIT 201").map_err(unavailable)?;
        let mut rows = stmt.query([after]).map_err(unavailable)?;
        let mut runs = Vec::new();
        let mut next = None;
        while let Some(r) = rows.next().map_err(unavailable)? {
            if runs.len() == 200 {
                next = runs.last().map(|v: &Value| v["id"].as_i64().unwrap());
                break;
            }
            if r.get::<_, String>(1).map_err(unavailable)?.len() > 128 {
                return Err(unavailable("invalid oversized rx run UID"));
            }
            runs.push(json!({"id":r.get::<_,i64>(0).map_err(unavailable)?,"run_uid":r.get::<_,String>(1).map_err(unavailable)?,"state":r.get::<_,String>(2).map_err(unavailable)?,"alias":r.get::<_,Option<String>>(3).map_err(unavailable)?,"config":r.get::<_,Option<String>>(4).map_err(unavailable)?,"created_at":r.get::<_,String>(5).map_err(unavailable)?,"started_at":r.get::<_,Option<String>>(6).map_err(unavailable)?,"finished_at":r.get::<_,Option<String>>(7).map_err(unavailable)?,"exit_code":r.get::<_,Option<i64>>(8).map_err(unavailable)?,"argv":r.get::<_,String>(9).map_err(unavailable)?}));
        }
        Ok(json!({"runs":runs,"next_after":next,"metadata_truncated":true}))
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
fn scalar_equal(a: &Value, b: &Value) -> bool {
    if !a.is_number() || !b.is_number() {
        return a == b;
    }
    let integer = |v: &Value| {
        v.as_i64()
            .map(i128::from)
            .or_else(|| v.as_u64().map(i128::from))
    };
    match (integer(a), integer(b)) {
        (Some(a), Some(b)) => a == b,
        (Some(i), None) | (None, Some(i)) => {
            let f = if integer(a).is_some() {
                b.as_f64().unwrap()
            } else {
                a.as_f64().unwrap()
            };
            f.fract() == 0.0 && f >= i64::MIN as f64 && f < 18446744073709551616.0 && f as i128 == i
        }
        _ => a.as_f64() == b.as_f64(),
    }
}
fn matches(value: &Value, filters: &[(FieldPath, &Condition)], any: bool) -> bool {
    let test = |(p, c): &(FieldPath, &Condition)| {
        let v = p.get(value);
        match c.op.as_str() {
            "exists" => v.is_some(),
            "missing" => v.is_none(),
            "eq" => v.is_some_and(|v| scalar_equal(v, &c.value)),
            "ne" => v.is_some_and(|v| !scalar_equal(v, &c.value)),
            op => match (v.and_then(Value::as_f64), c.value.as_f64()) {
                (Some(a), Some(b)) => match op {
                    "lt" => a < b,
                    "lte" => a <= b,
                    "gt" => a > b,
                    "gte" => a >= b,
                    _ => false,
                },
                _ => false,
            },
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
    run: usize,
    seq: i64,
    high: Vec<i64>,
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
    cursor: Option<String>,
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
#[derive(Clone, Copy, PartialEq)]
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
    points: Vec<(f64, f64, i64)>,
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
            return Err(ApiError::bad("select 1–32 distinct rx run identities"));
        }
        if q.limit == 0 || q.limit > 100 || q.prefix.len() > 1024 || q.ys.len() > 16 {
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
        // Completion visits only immediate children of the entered parent. Arrays
        // are containers; explicit [index] paths remain queryable without hints.
        let (parent, needle) = if mode == Mode::Fields {
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
            Sha256::digest(serde_json::to_vec(&json!([q.source_id, q.runs, q.filters])).unwrap())
        );
        let conn = self.connection()?;
        let mut ids = Vec::new();
        let mut highs = Vec::new();
        for uid in &q.runs {
            let id: i64 = conn
                .query_row("SELECT id FROM runs WHERE run_uid=?", [uid], |r| r.get(0))
                .map_err(|_| ApiError::bad("an rx run is unavailable"))?;
            let high: i64 = conn
                .query_row(
                    "SELECT coalesce(max(seq),0) FROM events WHERE run_id=?",
                    [id],
                    |r| r.get(0),
                )
                .map_err(unavailable)?;
            ids.push(id);
            highs.push(high);
        }
        let mut cursor = if let Some(encoded) = &q.cursor {
            if encoded.len() > 4096 {
                return Err(ApiError::bad("record cursor exceeds its size limit"));
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| ApiError::bad("invalid record cursor"))?;
            serde_json::from_slice::<Cursor>(&bytes)
                .map_err(|_| ApiError::bad("invalid record cursor"))?
        } else {
            Cursor {
                scope: scope.clone(),
                run: 0,
                seq: 0,
                high: highs.clone(),
            }
        };
        if cursor.scope != scope
            || cursor.run >= ids.len()
            || cursor.seq < 0
            || cursor.high.len() != ids.len()
            || cursor.high.iter().zip(&highs).any(|(a, b)| *a < 0 || a > b)
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
        let mut visits = 0;
        let mut stopped = false;
        while cursor.run < ids.len() {
            let mut stmt=conn.prepare("SELECT seq,substr(received_at,1,64),length(CAST(data AS BLOB)),CASE WHEN length(CAST(data AS BLOB))<=? THEN data ELSE NULL END FROM events WHERE run_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?").map_err(unavailable)?;
            let mut rows = stmt
                .query(params![
                    MAX_RECORD as i64,
                    ids[cursor.run],
                    cursor.seq,
                    cursor.high[cursor.run],
                    MAX_SCAN as i64 + 1
                ])
                .map_err(unavailable)?;
            while let Some(row) = rows.next().map_err(unavailable)? {
                if d.scanned >= MAX_SCAN
                    || d.bytes >= MAX_BYTES
                    || started.elapsed() > Duration::from_millis(500)
                    || (mode == Mode::Fields && d.scanned >= 2000)
                {
                    d.limit("scan budget reached");
                    stopped = true;
                    break;
                }
                let seq: i64 = row.get(0).map_err(unavailable)?;
                let bytes = row.get::<_, i64>(2).map_err(unavailable)? as usize;
                if bytes <= MAX_RECORD && d.bytes + bytes > MAX_BYTES {
                    d.limit("byte budget reached");
                    stopped = true;
                    break;
                }
                cursor.seq = seq;
                d.scanned += 1;
                if bytes > MAX_RECORD {
                    d.oversized += 1;
                    d.limit("oversized records skipped");
                    continue;
                }
                d.bytes += bytes;
                let raw: String = row.get(3).map_err(unavailable)?;
                let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                    d.invalid_json += 1;
                    d.limit("invalid JSON records skipped");
                    continue;
                };
                if !matches(&value, &filters, q.filters.any) {
                    continue;
                }
                d.matched += 1;
                match mode {
                    Mode::Records => {
                        let received_at: String = row.get(1).map_err(unavailable)?;
                        records.push(json!({"run_uid":q.runs[cursor.run],"seq":seq,"received_at":received_at,"data":value}));
                        if records.len() >= q.limit {
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
                                if !hints.contains_key(&path) && hints.len() >= MAX_FIELDS {
                                    d.limit("field suggestion limit reached");
                                    continue;
                                }
                                let hint = hints.entry(path.clone()).or_insert_with(|| Hint {
                                    path,
                                    ..Hint::default()
                                });
                                hint.present += 1;
                                hint.types.insert(value_type(v));
                                if !v.is_array()
                                    && !v.is_object()
                                    && v.to_string().len() <= 256
                                    && hint.values.len() < 8
                                    && !hint.values.contains(v)
                                {
                                    hint.values.push(v.clone());
                                }
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
                                Some(v)
                                    if !v.is_array()
                                        && !v.is_object()
                                        && v.to_string().len() <= 1024 =>
                                {
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
                            if !traces.contains_key(&key) && traces.len() >= MAX_TRACES {
                                d.omitted_traces += 1;
                                d.limit("trace/group limit reached");
                                continue;
                            }
                            if d.points >= MAX_POINTS {
                                d.limit("point budget reached");
                                stopped = true;
                                break;
                            }
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
                                .push((x, y, seq));
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
            cursor.seq = 0;
        }
        let next = if stopped && mode == Mode::Records {
            Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).unwrap()))
        } else {
            None
        };
        Ok(
            json!({"diagnostics":d,"records":records,"next_cursor":next,"fields":hints.into_values().collect::<Vec<_>>(),"traces":traces.into_values().collect::<Vec<_>>(),"coverage":if mode==Mode::Fields {"sampled hints, not a complete schema"} else {"bounded committed snapshot"}}),
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
            assert_eq!(trace["points"][0][2], 5);
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
            json!([[0.1, 1.0, 16], [0.1, 2.0, 17], [0.05, 3.0, 18]])
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
        assert_eq!(first["records"][0]["seq"], 1);
        add(&f, 859, 4, json!({"kind":"epoch","epoch":4}));
        let second = f
            .source
            .query(
                request(json!({"cursor":first["next_cursor"],"limit":2})),
                Mode::Records,
            )
            .unwrap();
        assert_eq!(second["records"].as_array().unwrap().len(), 1);
        assert_eq!(second["records"][0]["seq"], 3);
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
    fn missing_wal_sidecars_fail_without_creation_and_schema_is_never_migrated() {
        let f = fixture(true);
        add(&f, 859, 1, json!({}));
        let source = f.source.clone();
        drop(f.writer);
        assert!(source.connection().is_err());
        assert!(!PathBuf::from(format!("{}-wal", source.path.display())).exists());
        assert!(!PathBuf::from(format!("{}-shm", source.path.display())).exists());
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
    fn typed_numeric_equality_and_group_limits() {
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
        assert_eq!(result["diagnostics"]["omitted_traces"], 2);
        assert_eq!(result["diagnostics"]["partial"], true);
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
}
