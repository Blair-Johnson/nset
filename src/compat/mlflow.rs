//! Reduced MLflow tracking protocol. Native scalars/config, durable compatibility
//! metadata, no artifacts, proxy, Python runtime, or legacy-state migration.
use super::Compat;
use crate::{
    errors::{ApiError, Result},
    models::{self, MetricQuery, NewRun, PatchRun},
};
use axum::http::StatusCode;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap},
};
use uuid::Uuid;

const EXP: &str = "mlflow.experiments";
const EXP_INTENT: &str = "mlflow.experiment-create-intents.rust-v1";
const RUN: &str = "mlflow.runs";
const ARTIFACT_URI: &str = "mlflow-artifacts:/unsupported";
fn bad() -> ApiError {
    ApiError::bad("Invalid or unsupported MLflow parameter")
}
fn unsupported() -> ApiError {
    ApiError::bad("NOT_IMPLEMENTED: Unsupported MLflow route or field")
}
fn missing() -> ApiError {
    ApiError::missing()
}
fn conflict() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "RESOURCE_ALREADY_EXISTS: MLflow resource already exists",
    )
}
fn object(v: &Value) -> Result<&Map<String, Value>> {
    v.as_object().ok_or_else(bad)
}
fn text(v: &Value, empty: bool) -> Result<&str> {
    let s = v.as_str().ok_or_else(bad)?;
    if (!empty && s.is_empty()) || s.contains('\0') {
        return Err(bad());
    }
    Ok(s)
}
fn key(v: &Value) -> Result<&str> {
    let s = text(v, false)?;
    if s.len() > 512 {
        return Err(bad());
    }
    Ok(s)
}
fn integer(v: &Value, min: i64, max: i64) -> Result<i64> {
    let n = if let Some(s) = v.as_str() {
        let digits = s.strip_prefix('-').unwrap_or(s);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad());
        }
        s.parse::<i64>().map_err(|_| bad())?
    } else {
        v.as_i64().ok_or_else(bad)?
    };
    if n < min || n > max {
        return Err(bad());
    }
    Ok(n)
}
fn number(v: &Value) -> Result<i64> {
    integer(v, 0, models::MAX_SAFE)
}
fn fields(v: &Value, allowed: &str) -> Result<()> {
    if object(v)?
        .keys()
        .any(|k| !allowed.split_whitespace().any(|a| a == k))
    {
        return Err(unsupported());
    }
    Ok(())
}
fn pairs(v: Option<&Value>) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    if let Some(v) = v {
        for p in v.as_array().ok_or_else(bad)? {
            fields(p, "key value")?;
            let k = key(&p["key"])?;
            let value = json!(text(&p["value"], true)?);
            if out.get(k).is_some_and(|old| old != &value) {
                return Err(bad());
            }
            out.insert(k.to_owned(), value);
        }
    }
    Ok(out)
}
fn wire_pairs(v: &Value) -> Value {
    Value::Array(
        v.as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| json!({"key": k, "value": v}))
            .collect(),
    )
}
fn exp_wire(v: &Value) -> Value {
    let mut v = v.clone();
    for k in ["native_id", "lifecycle_epoch"] {
        v.as_object_mut().unwrap().remove(k);
    }
    v["tags"] = wire_pairs(&v["tags"]);
    v
}
fn run_wire(v: &Value) -> Value {
    json!({"info":v["info"], "data": {"params":wire_pairs(&v["params"]), "tags":wire_pairs(&v["tags"]),
        "metrics":v["latest_metrics"].as_object().unwrap().values().collect::<Vec<_>>()}})
}
fn active(v: &Value) -> Result<()> {
    let stage = v
        .get("lifecycle_stage")
        .unwrap_or(&v["info"]["lifecycle_stage"]);
    if stage != "active" {
        return Err(ApiError::bad(
            "INVALID_STATE: Operation requires an active experiment/run",
        ));
    }
    Ok(())
}
async fn new_experiment(
    ctx: &Compat,
    name: &str,
    eid: &str,
    tags: Map<String, Value>,
    now: i64,
) -> Result<Value> {
    let prefix = format!("mlflow:{eid}:");
    let mut end = name.len().min(512 - prefix.len());
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    let (native, _) = ctx
        .db
        .create_experiment(format!("{prefix}{}", &name[..end]))
        .await?;
    let exp = json!({"experiment_id":eid,"native_id":native.id,"name":name,"tags":tags,
        "artifact_location":ARTIFACT_URI,"lifecycle_stage":"active","creation_time":now,
        "last_update_time":now,"lifecycle_epoch":0});
    ctx.put(EXP, eid, exp.clone()).await?;
    Ok(exp)
}
async fn default_experiment(ctx: &Compat) -> Result<()> {
    // Existing runs never queue behind catalog work merely to initialize Default.
    if ctx.get(EXP, "0").await?.is_none() {
        let _catalog = ctx.lock("mlflow:catalog").await;
        if ctx.get(EXP, "0").await?.is_none() {
            new_experiment(ctx, "Default", "0", Map::new(), models::now()).await?;
        }
    }
    Ok(())
}
// Caller holds catalog. A crash after publishing the mapping but before clearing
// its intent must not reserve the old name forever after a later rename.
async fn experiment_intent(ctx: &Compat, name: &str) -> Result<Option<Value>> {
    let Some(intent) = ctx.get(EXP_INTENT, name).await? else {
        return Ok(None);
    };
    if ctx
        .get(EXP, text(&intent["experiment_id"], false)?)
        .await?
        .is_some()
    {
        ctx.delete(EXP_INTENT, name).await?;
        return Ok(None);
    }
    Ok(Some(intent))
}
async fn experiment(ctx: &Compat, eid: &str) -> Result<Value> {
    ctx.get(EXP, eid).await?.ok_or_else(missing)
}
fn run_id(data: &Value) -> Result<String> {
    let id = data
        .get("run_id")
        .filter(|v| **v != "")
        .or_else(|| data.get("run_uuid"))
        .ok_or_else(bad)?;
    match (data.get("run_id"), data.get("run_uuid")) {
        (Some(a), Some(b)) if a != "" && b != "" && a != b => return Err(bad()),
        _ => {}
    }
    let id = text(id, false)?;
    if id.len() != 32
        || !id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(bad());
    }
    Ok(id.to_owned())
}
fn namespace(rid: &str) -> String {
    format!("mlflow.metric-identities.rust-v1:{rid}")
}
fn identity(m: &Value) -> String {
    json!([
        m["key"],
        m["step"],
        m["timestamp"],
        m["value"].as_f64().unwrap()
    ])
    .to_string()
}
fn metric_cmp(a: &Value, b: &Value) -> Ordering {
    a["key"]
        .as_str()
        .cmp(&b["key"].as_str())
        .then_with(|| a["step"].as_i64().cmp(&b["step"].as_i64()))
        .then_with(|| a["timestamp"].as_i64().cmp(&b["timestamp"].as_i64()))
        .then_with(|| {
            a["value"]
                .as_f64()
                .unwrap()
                .partial_cmp(&b["value"].as_f64().unwrap())
                .unwrap()
        })
}
fn parse_metrics(items: Option<&Value>, rid: &str) -> Result<Vec<Value>> {
    let mut out = BTreeMap::new();
    if let Some(items) = items {
        for m in items.as_array().ok_or_else(bad)? {
            fields(
                m,
                "key value timestamp step dataset_name dataset_digest model_id run_id",
            )?;
            for field in ["dataset_name", "dataset_digest", "model_id"] {
                if m.get(field).is_some_and(|v| !v.is_null() && v != "") {
                    return Err(unsupported());
                }
            }
            if m.get("run_id")
                .is_some_and(|v| !v.is_null() && v != "" && v != rid)
            {
                return Err(bad());
            }
            let value = m["value"].as_f64().ok_or_else(bad)?;
            if !value.is_finite() || (value == 0.0 && value.is_sign_negative()) {
                return Err(bad());
            }
            let m = json!({"key":key(&m["key"])?,"value":value,"timestamp":number(&m["timestamp"])?,
                "step":number(m.get("step").unwrap_or(&json!(0)))?});
            out.insert(identity(&m), m);
        }
    }
    let mut out: Vec<_> = out.into_values().collect();
    out.sort_by(metric_cmp);
    Ok(out)
}
async fn save_run(ctx: &Compat, run: &Value) -> Result<()> {
    ctx.put(RUN, run["info"]["run_id"].as_str().unwrap(), run.clone())
        .await
}
async fn recover(ctx: &Compat, run: &mut Value) -> Result<()> {
    let Some(pending) = run.get("pending").cloned() else {
        return Ok(());
    };
    let metrics = pending["metrics"].as_array().ok_or_else(bad)?;
    let native = run["native_id"].as_str().ok_or_else(bad)?;
    // Always replay the original payload, even if identities were already published.
    // Identical chunks have identical IDs across process deaths and HTTP retries.
    for chunk in metrics.chunks(10000) {
        let digest = Sha256::digest(serde_json::to_vec(chunk).map_err(ApiError::internal)?);
        let batch_id = format!("mlflow-rust-v1-{digest:x}");
        let metrics = chunk
            .iter()
            .map(|m| {
                let input: crate::models::MetricInput =
                    serde_json::from_value(m.clone()).map_err(ApiError::internal)?;
                Ok(crate::models::Metric {
                    seq: 0,
                    key: input.key,
                    value: input.value,
                    step: input.step,
                    timestamp: input.timestamp.ok_or_else(bad)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        ctx.ingest_metrics(native, &batch_id, metrics).await?;
    }
    ctx.put_many(
        &namespace(run["info"]["run_id"].as_str().unwrap()),
        metrics.iter().map(|m| (identity(m), json!(true))).collect(),
    )
    .await?;
    let patch = &pending["patch"];
    if !object(patch)?.is_empty() {
        let patch: PatchRun = serde_json::from_value(patch.clone()).map_err(ApiError::internal)?;
        ctx.db.patch_run(native.to_owned(), patch).await?;
    }
    for m in metrics {
        let k = m["key"].as_str().unwrap();
        if run["latest_metrics"]
            .get(k)
            .is_none_or(|old| metric_cmp(m, old).is_gt())
        {
            run["latest_metrics"][k] = m.clone();
        }
    }
    for (k, v) in object(&pending["params"])? {
        run["params"][k] = v.clone();
    }
    for (k, v) in object(&pending["tags"])? {
        if v.is_null() {
            run["tags"].as_object_mut().unwrap().remove(k);
        } else {
            run["tags"][k] = v.clone();
        }
    }
    for (k, v) in object(&pending["info"])? {
        run["info"][k] = v.clone();
    }
    run.as_object_mut().unwrap().remove("pending");
    let eid = run["info"]["experiment_id"].as_str().unwrap().to_owned();
    let _experiment = ctx.lock(&format!("mlflow:experiment:{eid}")).await;
    sync_lifecycle(run, &experiment(ctx, &eid).await?);
    save_run(ctx, run).await
}
// Every caller owns this run's lock. Experiment locks cover only lifecycle
// checks / metadata publication, never native projection or run-lock waits.
fn sync_lifecycle(run: &mut Value, exp: &Value) -> bool {
    if run["experiment_epoch"] == exp["lifecycle_epoch"] {
        return false;
    }
    run["experiment_epoch"] = exp["lifecycle_epoch"].clone();
    run["info"]["lifecycle_stage"] = exp["lifecycle_stage"].clone();
    true
}
async fn load_run(ctx: &Compat, rid: &str) -> Result<Value> {
    let mut run = ctx.get(RUN, rid).await?.ok_or_else(missing)?;
    recover(ctx, &mut run).await?;
    let eid = run["info"]["experiment_id"].as_str().unwrap().to_owned();
    let _experiment = ctx.lock(&format!("mlflow:experiment:{eid}")).await;
    if sync_lifecycle(&mut run, &experiment(ctx, &eid).await?) {
        save_run(ctx, &run).await?;
    }
    Ok(run)
}
async fn commit(
    ctx: &Compat,
    run: &mut Value,
    metrics: Vec<Value>,
    params: Value,
    tags: Value,
    info: Value,
    patch: Value,
) -> Result<()> {
    {
        let eid = run["info"]["experiment_id"].as_str().unwrap().to_owned();
        let _experiment = ctx.lock(&format!("mlflow:experiment:{eid}")).await;
        let exp = experiment(ctx, &eid).await?;
        sync_lifecycle(run, &exp);
        active(run)?;
        active(&exp)?;
        // Acceptance is ordered against experiment lifecycle transitions. Once
        // durable, the intent must replay even if its experiment is later deleted.
        run["pending"] =
            json!({"metrics":metrics,"params":params,"tags":tags,"info":info,"patch":patch});
        save_run(ctx, run).await?;
    }
    recover(ctx, run).await
}
async fn log(ctx: &Compat, run: &mut Value, data: &Value) -> Result<()> {
    let params = pairs(data.get("params"))?;
    let tags = pairs(data.get("tags"))?;
    let rid = run["info"]["run_id"].as_str().unwrap();
    let metrics = parse_metrics(data.get("metrics"), rid)?;
    for (k, v) in &params {
        if run["params"].get(k).is_some_and(|old| old != v) {
            return Err(ApiError::bad("Changing param values is not allowed"));
        }
    }
    let mut fresh = Vec::new();
    for m in metrics {
        if ctx.get(&namespace(rid), &identity(&m)).await?.is_none() {
            fresh.push(m);
        }
    }
    let mut info = json!({});
    if let Some(name) = tags.get("mlflow.runName") {
        info["run_name"] = name.clone();
    }
    let mut patch = json!({});
    if !params.is_empty() {
        patch["params"] = json!(params);
    }
    if !tags.is_empty() {
        patch["tags"] = json!(tags);
    }
    commit(ctx, run, fresh, json!(params), json!(tags), info, patch).await
}
async fn history(ctx: &Compat, run: &Value, key: &str) -> Result<Vec<Value>> {
    let mut after = None;
    let mut snapshot = None;
    let mut rows = BTreeMap::new();
    loop {
        let page = ctx
            .db
            .metrics(
                run["native_id"].as_str().unwrap().to_owned(),
                MetricQuery {
                    key: key.to_owned(),
                    after,
                    snapshot,
                    limit: Some(10000),
                },
            )
            .await?;
        for m in page.points {
            let m = json!({"key":m.key,"step":m.step,"timestamp":m.timestamp,"value":m.value});
            rows.insert(identity(&m), m);
        }
        after = page.next_after;
        snapshot = Some(page.snapshot);
        if after.is_none() {
            break;
        }
    }
    let mut rows: Vec<_> = rows.into_values().collect();
    rows.sort_by(metric_cmp);
    Ok(rows)
}

// Small non-SQL tokenizer. Every byte must be consumed; OR, IN, and arbitrary
// suffixes are rejected rather than partially interpreted.
#[derive(Clone, Debug)]
enum Token {
    Word(String),
    Quoted(String),
    Op(String),
}
fn tokens(s: &str) -> Result<Vec<Token>> {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let c = chars[i];
        if c == '\'' || c == '"' {
            i += 1;
            let mut value = String::new();
            loop {
                if i >= chars.len() {
                    return Err(bad());
                }
                if chars[i] == c {
                    i += 1;
                    if i < chars.len() && chars[i] == c {
                        value.push(c);
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    value.push(chars[i]);
                    i += 1;
                }
            }
            out.push(Token::Quoted(value));
        } else if "=<>!".contains(c) {
            let mut op = c.to_string();
            i += 1;
            if i < chars.len() && chars[i] == '=' {
                op.push('=');
                i += 1;
            }
            if !["=", "!=", ">", "<", ">=", "<="].contains(&op.as_str()) {
                return Err(bad());
            }
            out.push(Token::Op(op));
        } else {
            let mut word = String::new();
            let mut quoted = false;
            while i < chars.len() {
                let c = chars[i];
                if c == '`' {
                    quoted = !quoted;
                    word.push(c);
                    i += 1;
                    continue;
                }
                if !quoted && (c.is_whitespace() || "=<>!\"'".contains(c)) {
                    break;
                }
                if c == '\0' {
                    return Err(bad());
                }
                word.push(c);
                i += 1;
            }
            if quoted || word.is_empty() {
                return Err(bad());
            }
            out.push(Token::Word(word));
        }
    }
    Ok(out)
}
#[derive(Clone)]
struct Field {
    category: String,
    key: String,
}
fn field(s: &str, exp: bool) -> Result<Field> {
    let (category, k) = match s.split_once('.') {
        Some(("metrics" | "metric", k)) => ("metrics", k),
        Some(("params" | "param", k)) => ("params", k),
        Some(("tags" | "tag", k)) => ("tags", k),
        Some(("attributes" | "attribute", k)) => ("attributes", k),
        _ => ("attributes", s),
    };
    let k = if k.starts_with('`') && k.ends_with('`') && k.len() > 2 {
        let k = &k[1..k.len() - 1];
        if k.contains('`') {
            return Err(bad());
        }
        k
    } else {
        if !k.chars().enumerate().all(|(i, c)| {
            if i == 0 {
                c.is_ascii_alphabetic() || c == '_'
            } else {
                c.is_ascii_alphanumeric() || "_.-/".contains(c)
            }
        }) {
            return Err(bad());
        }
        k
    };
    if k.is_empty() {
        return Err(bad());
    }
    let allowed = if exp {
        "name experiment_id creation_time last_update_time"
    } else {
        "run_id run_name experiment_id user_id status start_time end_time"
    };
    if category == "attributes" && !allowed.split_whitespace().any(|a| a == k) {
        return Err(bad());
    }
    if exp && !["attributes", "tags"].contains(&category) {
        return Err(bad());
    }
    Ok(Field {
        category: category.to_owned(),
        key: k.to_owned(),
    })
}
fn field_value<'a>(row: &'a Value, f: &Field, exp: bool) -> Option<&'a Value> {
    if f.category == "attributes" {
        return if exp {
            row.get(&f.key)
        } else {
            row["info"].get(&f.key)
        };
    }
    let values = if exp {
        &row[&f.category]
    } else {
        &row["data"][&f.category]
    };
    if let Some(values) = values.as_object() {
        values.get(&f.key)
    } else {
        values
            .as_array()?
            .iter()
            .find(|v| v["key"] == f.key)
            .map(|v| &v["value"])
    }
}
struct Clause {
    field: Field,
    op: String,
    value: Value,
}
fn predicate(s: &str, exp: bool) -> Result<Vec<Clause>> {
    let ts = tokens(s)?;
    let mut out = Vec::new();
    let mut i = 0;
    while i < ts.len() {
        let Some(Token::Word(name)) = ts.get(i) else {
            return Err(bad());
        };
        let f = field(name, exp)?;
        let op = match ts.get(i + 1) {
            Some(Token::Op(s)) => s.clone(),
            Some(Token::Word(s)) if ["LIKE", "ILIKE"].contains(&s.to_uppercase().as_str()) => {
                s.to_uppercase()
            }
            _ => return Err(bad()),
        };
        let value = match ts.get(i + 2) {
            Some(Token::Quoted(s)) => json!(s),
            Some(Token::Word(s)) => {
                let n: f64 = s.parse().map_err(|_| bad())?;
                if !n.is_finite() {
                    return Err(bad());
                }
                json!(n)
            }
            _ => return Err(bad()),
        };
        let numeric = f.category == "metrics"
            || (f.category == "attributes"
                && [
                    "start_time",
                    "end_time",
                    "creation_time",
                    "last_update_time",
                ]
                .contains(&f.key.as_str()));
        if numeric != value.is_number()
            || (numeric && ["LIKE", "ILIKE"].contains(&op.as_str()))
            || (!numeric && !["=", "!=", "LIKE", "ILIKE"].contains(&op.as_str()))
        {
            return Err(bad());
        }
        out.push(Clause {
            field: f,
            op,
            value,
        });
        i += 3;
        if i < ts.len() {
            if !matches!(&ts[i], Token::Word(s) if s.eq_ignore_ascii_case("AND")) {
                return Err(bad());
            }
            i += 1;
            if i == ts.len() {
                return Err(bad());
            }
        }
    }
    Ok(out)
}
fn compare(a: &Value, b: &Value) -> Ordering {
    if let (Some(a), Some(b)) = (a.as_f64(), b.as_f64()) {
        a.partial_cmp(&b).unwrap_or(Ordering::Equal)
    } else {
        a.as_str().cmp(&b.as_str())
    }
}
fn like(actual: &str, pattern: &str, insensitive: bool) -> bool {
    let (actual, pattern) = if insensitive {
        (actual.to_lowercase(), pattern.to_lowercase())
    } else {
        (actual.to_owned(), pattern.to_owned())
    };
    let mut state = vec![false; actual.chars().count() + 1];
    state[0] = true;
    let chars: Vec<char> = actual.chars().collect();
    for p in pattern.chars() {
        let mut next = vec![false; state.len()];
        if p == '%' {
            next[0] = state[0];
            for i in 1..state.len() {
                next[i] = state[i] || next[i - 1];
            }
        } else {
            for i in 1..state.len() {
                next[i] = state[i - 1] && (p == '_' || p == chars[i - 1]);
            }
        }
        state = next;
    }
    *state.last().unwrap()
}
fn matches(row: &Value, clauses: &[Clause], exp: bool) -> bool {
    clauses.iter().all(|c| {
        let Some(v) = field_value(row, &c.field, exp).filter(|v| !v.is_null()) else {
            return false;
        };
        let ordering = compare(v, &c.value);
        match c.op.as_str() {
            "=" => ordering.is_eq(),
            "!=" => !ordering.is_eq(),
            ">" => ordering.is_gt(),
            "<" => ordering.is_lt(),
            ">=" => !ordering.is_lt(),
            "<=" => !ordering.is_gt(),
            "LIKE" | "ILIKE" => like(
                v.as_str().unwrap_or(""),
                c.value.as_str().unwrap(),
                c.op == "ILIKE",
            ),
            _ => false,
        }
    })
}
fn view(data: &Value, k: &str) -> Result<&'static str> {
    let v = data.get(k).cloned().unwrap_or(json!("ACTIVE_ONLY"));
    match v
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| v.to_string())
        .as_str()
    {
        "1" | "ACTIVE_ONLY" => Ok("active"),
        "2" | "DELETED_ONLY" => Ok("deleted"),
        "3" | "ALL" => Ok("all"),
        _ => Err(bad()),
    }
}
fn page(rows: Vec<Value>, data: &Value, scope: &str, result_key: &str) -> Result<Value> {
    let size = integer(data.get("max_results").unwrap_or(&json!(1000)), 1, 50000)? as usize;
    let mut query = data.clone();
    query.as_object_mut().unwrap().remove("page_token");
    let digest = Sha256::digest(json!([scope, query]).to_string().as_bytes());
    let fingerprint = format!("{digest:x}");
    let mut start = 0;
    if let Some(token) = data.get("page_token") {
        let token = text(token, true)?;
        if !token.is_empty() {
            let parts: Vec<_> = token.split(':').collect();
            if parts.len() != 3 || parts[0] != "rust-v1" || parts[1] != fingerprint {
                return Err(ApiError::bad("Invalid or mismatched page token"));
            }
            start = parts[2].parse::<usize>().map_err(|_| bad())?;
        }
    }
    let end = start.checked_add(size).ok_or_else(bad)?;
    let mut result = json!({result_key: rows.iter().skip(start).take(size).collect::<Vec<_>>()});
    if end < rows.len() {
        result["next_page_token"] = json!(format!("rust-v1:{fingerprint}:{end}"));
    }
    Ok(result)
}
async fn search(ctx: &Compat, data: &Value, exp: bool) -> Result<Value> {
    let stage = view(data, if exp { "view_type" } else { "run_view_type" })?;
    let clauses = predicate(text(data.get("filter").unwrap_or(&json!("")), true)?, exp)?;
    let mut orders = Vec::new();
    if let Some(values) = data.get("order_by") {
        for order in values.as_array().ok_or_else(bad)? {
            let ts = tokens(text(order, false)?)?;
            let Some(Token::Word(name)) = ts.first() else {
                return Err(bad());
            };
            let desc = match ts.get(1) {
                None => false,
                Some(Token::Word(s)) if s.eq_ignore_ascii_case("ASC") => false,
                Some(Token::Word(s)) if s.eq_ignore_ascii_case("DESC") => true,
                _ => return Err(bad()),
            };
            if ts.len() > 2 {
                return Err(bad());
            }
            orders.push((field(name, exp)?, desc));
        }
    }
    if orders.is_empty() {
        orders.push((
            field(if exp { "creation_time" } else { "start_time" }, exp)?,
            true,
        ));
    }
    let mut rows = Vec::new();
    if exp {
        for (_, e) in ctx.items(EXP).await? {
            if stage == "all" || e["lifecycle_stage"] == stage {
                rows.push(e);
            }
        }
        rows.sort_by_key(|r| {
            r["experiment_id"]
                .as_str()
                .unwrap()
                .parse::<i64>()
                .unwrap_or_default()
        });
    } else {
        let ids = data["experiment_ids"].as_array().ok_or_else(bad)?;
        if ids.is_empty() {
            return Err(bad());
        }
        let ids = ids
            .iter()
            .map(|v| number(v).map(|n| n.to_string()))
            .collect::<Result<Vec<_>>>()?;
        for (rid, stored) in ctx.items(RUN).await? {
            if ids.iter().any(|id| stored["info"]["experiment_id"] == *id) {
                let _guard = ctx.lock(&format!("mlflow:run:{rid}")).await;
                let run = load_run(ctx, &rid).await?;
                if stage == "all" || run["info"]["lifecycle_stage"] == stage {
                    rows.push(run_wire(&run));
                }
            }
        }
        rows.sort_by(|a, b| {
            a["info"]["run_id"]
                .as_str()
                .cmp(&b["info"]["run_id"].as_str())
        });
    }
    rows.retain(|r| matches(r, &clauses, exp));
    for (f, desc) in orders.iter().rev() {
        rows.sort_by(|a, b| {
            match (
                field_value(a, f, exp).filter(|v| !v.is_null()),
                field_value(b, f, exp).filter(|v| !v.is_null()),
            ) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => {
                    if *desc {
                        compare(b, a)
                    } else {
                        compare(a, b)
                    }
                }
            }
        });
    }
    if exp {
        rows = rows.iter().map(exp_wire).collect();
    }
    page(
        rows,
        data,
        if exp { "experiments" } else { "runs" },
        if exp { "experiments" } else { "runs" },
    )
}

pub async fn handle(
    ctx: &Compat,
    method: &str,
    path: &str,
    body: Value,
    query: &HashMap<String, String>,
) -> Result<Value> {
    let route = path
        .strip_prefix("/api/2.0/mlflow/")
        .ok_or_else(unsupported)?;
    let (expected, allowed) = match route {
        "experiments/create" => ("POST", "name artifact_location tags"),
        "experiments/get" => ("GET", "experiment_id"),
        "experiments/get-by-name" => ("GET", "experiment_name"),
        "experiments/search" => ("POST", "max_results page_token filter order_by view_type"),
        "experiments/update" => ("POST", "experiment_id new_name"),
        "experiments/delete" | "experiments/restore" => ("POST", "experiment_id"),
        "experiments/set-experiment-tag" => ("POST", "experiment_id key value"),
        "experiments/delete-experiment-tag" => ("POST", "experiment_id key"),
        "runs/create" => ("POST", "experiment_id user_id run_name start_time tags"),
        "runs/get" => ("GET", "run_id run_uuid"),
        "runs/update" => ("POST", "run_id run_uuid status end_time run_name"),
        "runs/delete" | "runs/restore" => ("POST", "run_id"),
        "runs/search" => (
            "POST",
            "experiment_ids filter run_view_type max_results order_by page_token",
        ),
        "runs/log-metric" => (
            "POST",
            "run_id run_uuid key value timestamp step dataset_name dataset_digest model_id",
        ),
        "runs/log-parameter" | "runs/set-tag" => ("POST", "run_id run_uuid key value"),
        "runs/log-batch" => ("POST", "run_id metrics params tags"),
        "runs/delete-tag" => ("POST", "run_id key"),
        "metrics/get-history" => ("GET", "run_id run_uuid metric_key page_token max_results"),
        _ => return Err(unsupported()),
    };
    if expected != method {
        return Err(ApiError(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed",
        ));
    }
    let data = if method == "GET" { json!(query) } else { body };
    fields(&data, allowed)?;
    // Lock order: catalog -> experiment for names; run -> experiment for run
    // metadata. No path takes a run lock while holding catalog/experiment, and
    // only the run lock survives a native projection wait (including recovery).
    default_experiment(ctx).await?;
    if route == "experiments/search" || route == "runs/search" {
        return search(ctx, &data, route == "experiments/search").await;
    }
    if route == "experiments/create" {
        let name = key(&data["name"])?;
        let tags = pairs(data.get("tags"))?;
        if data
            .get("artifact_location")
            .is_some_and(|v| !v.is_null() && v != "")
        {
            return Err(ApiError::bad(
                "NOT_IMPLEMENTED: MLflow artifact storage is not supported",
            ));
        }
        let _catalog = ctx.lock("mlflow:catalog").await;
        if ctx.items(EXP).await?.iter().any(|(_, e)| e["name"] == name) {
            return Err(conflict());
        }
        let intent = match experiment_intent(ctx, name).await? {
            Some(intent) => intent,
            None => {
                let eid = ctx.next_id("mlflow.experiment_ids", 1).await?.to_string();
                let intent = json!({"experiment_id":eid,"tags":tags,"creation_time":models::now()});
                // Persist the name->ID binding BEFORE native creation. A crash
                // before this write can waste an ID, but cannot orphan a native
                // experiment; after it, retries use the same deterministic name.
                ctx.put(EXP_INTENT, name, intent.clone()).await?;
                intent
            }
        };
        let eid = text(&intent["experiment_id"], false)?;
        new_experiment(
            ctx,
            name,
            eid,
            object(&intent["tags"])?.clone(),
            number(&intent["creation_time"])?,
        )
        .await?;
        ctx.delete(EXP_INTENT, name).await?;
        return Ok(json!({"experiment_id":eid}));
    }
    if route == "experiments/get-by-name" {
        let name = key(&data["experiment_name"])?;
        let exp = ctx
            .items(EXP)
            .await?
            .into_iter()
            .find(|(_, e)| e["name"] == name)
            .map(|(_, e)| e)
            .ok_or_else(missing)?;
        return Ok(json!({"experiment":exp_wire(&exp)}));
    }
    if route.starts_with("experiments/") {
        let eid = number(&data["experiment_id"])?.to_string();
        let _catalog = if route == "experiments/update" {
            Some(ctx.lock("mlflow:catalog").await)
        } else {
            None
        };
        let _experiment = ctx.lock(&format!("mlflow:experiment:{eid}")).await;
        let mut exp = experiment(ctx, &eid).await?;
        match route {
            "experiments/get" => return Ok(json!({"experiment":exp_wire(&exp)})),
            "experiments/update" => {
                active(&exp)?;
                let name = key(&data["new_name"])?;
                if ctx
                    .items(EXP)
                    .await?
                    .iter()
                    .any(|(id, e)| id != &eid && e["name"] == name)
                    || experiment_intent(ctx, name).await?.is_some()
                {
                    return Err(conflict());
                }
                exp["name"] = json!(name);
            }
            "experiments/set-experiment-tag" => {
                active(&exp)?;
                let k = key(&data["key"])?;
                exp["tags"][k] = json!(text(&data["value"], true)?);
            }
            "experiments/delete-experiment-tag" => {
                active(&exp)?;
                let k = key(&data["key"])?;
                if exp["tags"].as_object_mut().unwrap().remove(k).is_none() {
                    return Err(missing());
                }
            }
            _ => {
                let stage = if route.ends_with("/delete") {
                    "deleted"
                } else {
                    "active"
                };
                if exp["lifecycle_stage"] == stage {
                    return Err(ApiError::bad(
                        "INVALID_STATE: Experiment already has requested lifecycle state",
                    ));
                }
                exp["lifecycle_stage"] = json!(stage);
                exp["lifecycle_epoch"] = json!(exp["lifecycle_epoch"].as_u64().unwrap() + 1);
            }
        }
        exp["last_update_time"] = json!(models::now());
        ctx.put(EXP, &eid, exp).await?;
        return Ok(json!({}));
    }
    if route == "runs/create" {
        let eid = number(data.get("experiment_id").unwrap_or(&json!("0")))?.to_string();
        let _experiment = ctx.lock(&format!("mlflow:experiment:{eid}")).await;
        let exp = experiment(ctx, &eid).await?;
        active(&exp)?;
        let mut tags = pairs(data.get("tags"))?;
        let rid = Uuid::new_v4().simple().to_string();
        let explicit = data.get("run_name").filter(|v| **v != "");
        match (explicit, tags.get("mlflow.runName")) {
            (Some(a), Some(b)) if b != "" && a != b => return Err(bad()),
            _ => {}
        }
        let fallback = json!(rid);
        let name = key(explicit
            .or_else(|| tags.get("mlflow.runName").filter(|v| **v != ""))
            .unwrap_or(&fallback))?
        .to_owned();
        tags.insert("mlflow.runName".into(), json!(name));
        let start = number(data.get("start_time").unwrap_or(&json!(models::now())))?;
        let blank = json!("");
        let user = text(
            data.get("user_id")
                .or_else(|| tags.get("mlflow.user"))
                .unwrap_or(&blank),
            true,
        )?
        .to_owned();
        let run = json!({"params":{},"tags":tags,"latest_metrics":{},"metric_index_version":"rust-v1","experiment_epoch":exp["lifecycle_epoch"],
            "info":{"run_id":rid,"run_uuid":rid,"run_name":name,"experiment_id":eid,"user_id":user,"status":"RUNNING",
                "start_time":start,"lifecycle_stage":"active","artifact_uri":ARTIFACT_URI}});
        let run = ctx
            .create_run(
                RUN,
                &rid,
                NewRun {
                    experiment_id: exp["native_id"].as_str().unwrap().to_owned(),
                    name,
                    params: Map::new(),
                    tags,
                },
                run,
            )
            .await?;
        return Ok(json!({"run":run_wire(&run)}));
    }
    let rid = run_id(&data)?;
    let _run_guard = ctx.lock(&format!("mlflow:run:{rid}")).await;
    let mut run = load_run(ctx, &rid).await?;
    match route {
        "runs/get" => return Ok(json!({"run":run_wire(&run)})),
        "metrics/get-history" => {
            let k = key(&data["metric_key"])?;
            return page(
                history(ctx, &run, k).await?,
                &data,
                &format!("history:{rid}"),
                "metrics",
            );
        }
        "runs/delete" | "runs/restore" => {
            let eid = run["info"]["experiment_id"].as_str().unwrap().to_owned();
            let _experiment = ctx.lock(&format!("mlflow:experiment:{eid}")).await;
            let exp = experiment(ctx, &eid).await?;
            sync_lifecycle(&mut run, &exp);
            if route == "runs/restore" {
                active(&exp)?;
            }
            run["info"]["lifecycle_stage"] = json!(if route == "runs/delete" {
                "deleted"
            } else {
                "active"
            });
            save_run(ctx, &run).await?;
            return Ok(json!({}));
        }
        _ => {}
    }
    active(&run)?;
    active(&experiment(ctx, run["info"]["experiment_id"].as_str().unwrap()).await?)?;
    match route {
        "runs/update" => {
            let mut info = json!({});
            let mut patch = json!({});
            let mut tags = json!({});
            if let Some(status) = data.get("status") {
                let native = match text(status, false)? {
                    "RUNNING" | "SCHEDULED" => "running",
                    "FINISHED" => "finished",
                    "FAILED" | "KILLED" => "failed",
                    _ => return Err(bad()),
                };
                info["status"] = status.clone();
                patch["status"] = json!(native);
            }
            if let Some(end) = data.get("end_time") {
                info["end_time"] = json!(number(end)?);
            }
            if let Some(name) = data.get("run_name") {
                let name = key(name)?;
                info["run_name"] = json!(name);
                tags["mlflow.runName"] = json!(name);
                patch["tags"] = tags.clone();
            }
            commit(ctx, &mut run, vec![], json!({}), tags, info, patch).await?;
            return Ok(json!({"run_info":run["info"]}));
        }
        "runs/delete-tag" => {
            let k = key(&data["key"])?;
            if run["tags"].get(k).is_none() {
                return Err(missing());
            }
            commit(
                ctx,
                &mut run,
                vec![],
                json!({}),
                json!({k:null}),
                json!({}),
                json!({"tags":{k:null}}),
            )
            .await?;
        }
        "runs/log-batch" => log(ctx, &mut run, &data).await?,
        "runs/log-metric" => {
            let mut metric = data.clone();
            metric.as_object_mut().unwrap().remove("run_id");
            metric.as_object_mut().unwrap().remove("run_uuid");
            log(ctx, &mut run, &json!({"metrics":[metric]})).await?;
        }
        "runs/log-parameter" => {
            log(
                ctx,
                &mut run,
                &json!({"params":[{"key":data["key"],"value":data["value"]}]}),
            )
            .await?
        }
        "runs/set-tag" => {
            log(
                ctx,
                &mut run,
                &json!({"tags":[{"key":data["key"],"value":data["value"]}]}),
            )
            .await?
        }
        _ => return Err(unsupported()),
    }
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_grammar_is_fully_consumed_and_typed() {
        let row = json!({"info":{"run_name":"A'b", "start_time":4}, "data":{
            "params":[{"key":"optimizer", "value":"adam"}],
            "tags":[{"key":"space key", "value":"X"}],
            "metrics":[{"key":"loss", "value":2.0}]}});
        let clauses = predicate("params.optimizer = 'adam' AND metrics.loss >= 2 AND tags.`space key` ILIKE 'x' AND run_name = 'A''b'", false).unwrap();
        assert!(matches(&row, &clauses, false));
        for s in [
            "run_name = 'x' OR status = 'RUNNING'",
            "run_name = 'x' AND",
            "run_name = 'x' trailing",
            "metrics.loss = '2'",
            "params.optimizer > 'adam'",
            "metrics.loss = NaN",
            "tags.`unterminated = 'x'",
        ] {
            assert!(predicate(s, false).is_err(), "accepted {s}");
        }
        assert!(predicate("metrics.loss = 2", true).is_err());
    }

    #[test]
    fn pagination_binds_scope_and_complete_query() {
        let query = json!({"max_results":1,"filter":""});
        let first = page(vec![json!(1), json!(2)], &query, "runs", "runs").unwrap();
        let mut next = query.clone();
        next["page_token"] = first["next_page_token"].clone();
        assert_eq!(
            page(vec![json!(1), json!(2)], &next, "runs", "runs").unwrap()["runs"],
            json!([2])
        );
        assert!(page(vec![], &next, "experiments", "experiments").is_err());
        next["max_results"] = json!(2);
        assert!(page(vec![], &next, "runs", "runs").is_err());
    }

    #[test]
    fn metric_identity_normalizes_integral_values_and_rejects_negative_zero() {
        let values = json!([
            {"key":"loss","step":"1","timestamp":"2","value":1},
            {"key":"loss","step":1,"timestamp":2,"value":1.0}
        ]);
        let parsed = parse_metrics(Some(&values), "01234567890123456789012345678901").unwrap();
        assert_eq!(parsed.len(), 1);
        let bad_values = json!([{"key":"loss","step":0,"timestamp":0,"value":-0.0}]);
        assert!(parse_metrics(Some(&bad_values), "01234567890123456789012345678901").is_err());
        assert!(number(&json!(true)).is_err());
        assert!(number(&json!(1.5)).is_err());
        assert!(number(&json!("+1")).is_err());
    }
}
