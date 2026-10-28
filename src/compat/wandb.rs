//! Deliberately reduced W&B SDK protocol: metrics, config, summary and console only.
//! No file/artifact capability is advertised, and no upload store is created.
use super::{Compat, Metric};
use crate::errors::{ApiError, Result};
use crate::models::{self, NewRun, PatchRun};
use axum::http::StatusCode;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

const RUNS: &str = "wandb.runs";
const PENDING: &str = "wandb.pending";
const PROJECTS: &str = "wandb.projects";
const SCHEMA: &str = "rust-v1";
const STREAMS: [&str; 4] = [
    "wandb-history.jsonl",
    "wandb-events.jsonl",
    "wandb-summary.json",
    "output.log",
];
fn bad() -> ApiError {
    ApiError::bad("Unsupported or invalid W&B GraphQL document")
}
fn conflict(message: &'static str) -> ApiError {
    ApiError(StatusCode::CONFLICT, message)
}
fn unsupported() -> ApiError {
    ApiError::bad("W&B run files and artifacts are not supported")
}
fn digest(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}
fn text(value: &Value) -> Result<&str> {
    value.as_str().ok_or_else(bad)
}
fn segment(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 512
        || value == "."
        || value == ".."
        || value.contains(['/', '\\', '\0'])
    {
        return Err(ApiError::bad("Invalid W&B entity, project, or run name"));
    }
    Ok(value)
}
fn identity(entity: &str, project: &str, run: &str) -> Result<String> {
    Ok(digest(
        json!([segment(entity)?, segment(project)?, segment(run)?]).to_string(),
    ))
}
fn rows_namespace(key: &str, name: &str) -> String {
    format!("wandb.rows.{key}.{}", digest(name))
}
fn metric_namespace(key: &str) -> String {
    format!("wandb.metrics.{key}")
}

#[derive(Clone, Debug)]
struct Field {
    alias: String,
    name: String,
    args: Map<String, Value>,
    children: Vec<Field>,
}
struct Document {
    tokens: Vec<String>,
    at: usize,
    variables: Map<String, Value>,
    expansion_budget: usize,
}
impl Document {
    fn new(source: &str, variables: Map<String, Value>) -> Result<Self> {
        if source.len() > 262144 {
            return Err(bad());
        }
        let b = source.as_bytes();
        let mut i = 0;
        let mut tokens = Vec::new();
        while i < b.len() {
            let start = i;
            match b[i] {
                b' ' | b'\t' | b'\r' | b'\n' | b',' => {
                    i += 1;
                    continue;
                }
                b'#' => {
                    while i < b.len() && b[i] != b'\n' {
                        i += 1;
                    }
                    continue;
                }
                b'"' => {
                    i += 1;
                    while i < b.len() && b[i] != b'"' {
                        if b[i] == b'\\' {
                            i += 1;
                        }
                        i += 1;
                    }
                    if i >= b.len() {
                        return Err(bad());
                    }
                    i += 1;
                    serde_json::from_str::<String>(&source[start..i]).map_err(|_| bad())?;
                }
                b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                    i += 1;
                    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                        i += 1;
                    }
                }
                b'-' | b'0'..=b'9' => {
                    i += 1;
                    while i < b.len()
                        && (b[i].is_ascii_digit()
                            || matches!(b[i], b'.' | b'e' | b'E' | b'+' | b'-'))
                    {
                        i += 1;
                    }
                    serde_json::from_str::<Value>(&source[start..i]).map_err(|_| bad())?;
                }
                b'$' | b'!' | b'(' | b')' | b':' | b'=' | b'@' | b'[' | b']' | b'{' | b'}' => {
                    i += 1;
                }
                _ => return Err(bad()),
            }
            tokens.push(source[start..i].to_owned());
            if tokens.len() > 32768 {
                return Err(bad());
            }
        }
        Ok(Self {
            tokens,
            at: 0,
            variables,
            expansion_budget: crate::config::MAX_BODY,
        })
    }
    fn peek(&self) -> &str {
        self.tokens.get(self.at).map(String::as_str).unwrap_or("")
    }
    fn pop(&mut self) -> Result<String> {
        let t = self.tokens.get(self.at).ok_or_else(bad)?.clone();
        self.at += 1;
        Ok(t)
    }
    fn expect(&mut self, expected: &str) -> Result<()> {
        if self.pop()? == expected {
            Ok(())
        } else {
            Err(bad())
        }
    }
    fn name(&mut self) -> Result<String> {
        let t = self.pop()?;
        if t.bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            Ok(t)
        } else {
            Err(bad())
        }
    }
    fn value(&mut self, depth: usize) -> Result<Value> {
        if depth > 48 {
            return Err(bad());
        }
        let t = self.pop()?;
        Ok(match t.as_str() {
            "$" => {
                let name = self.name()?;
                let value = self.variables.get(&name).unwrap_or(&Value::Null);
                charge_value(value, &mut self.expansion_budget)?;
                value.clone()
            }
            "{" => {
                let mut v = Map::new();
                while self.peek() != "}" {
                    let k = self.name()?;
                    self.expect(":")?;
                    v.insert(k, self.value(depth + 1)?);
                }
                self.expect("}")?;
                Value::Object(v)
            }
            "[" => {
                let mut v = Vec::new();
                while self.peek() != "]" {
                    v.push(self.value(depth + 1)?);
                }
                self.expect("]")?;
                Value::Array(v)
            }
            "true" => json!(true),
            "false" => json!(false),
            "null" => Value::Null,
            _ if t.starts_with('"') || t.starts_with('-') || t.as_bytes()[0].is_ascii_digit() => {
                serde_json::from_str(&t).map_err(|_| bad())?
            }
            _ if t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') => json!(t),
            _ => return Err(bad()),
        })
    }
    fn selection(&mut self, depth: usize) -> Result<Vec<Field>> {
        if depth > 48 {
            return Err(bad());
        }
        self.expect("{")?;
        let mut fields = Vec::new();
        while self.peek() != "}" {
            let alias = self.name()?;
            let name = if self.peek() == ":" {
                self.pop()?;
                self.name()?
            } else {
                alias.clone()
            };
            let mut args = Map::new();
            if self.peek() == "(" {
                self.pop()?;
                while self.peek() != ")" {
                    let k = self.name()?;
                    self.expect(":")?;
                    args.insert(k, self.value(0)?);
                }
                self.pop()?;
            }
            let mut include = true;
            while self.peek() == "@" {
                self.pop()?;
                let directive = self.name()?;
                if directive != "include" && directive != "skip" {
                    return Err(bad());
                }
                self.expect("(")?;
                self.expect("if")?;
                self.expect(":")?;
                let condition = self.value(0)?.as_bool().ok_or_else(bad)?;
                self.expect(")")?;
                include &= if directive == "include" {
                    condition
                } else {
                    !condition
                };
            }
            let children = if self.peek() == "{" {
                self.selection(depth + 1)?
            } else {
                Vec::new()
            };
            if include {
                fields.push(Field {
                    alias,
                    name,
                    args,
                    children,
                });
            }
        }
        self.pop()?;
        Ok(fields)
    }
    fn type_name(&mut self, depth: usize) -> Result<()> {
        if depth > 48 {
            return Err(bad());
        }
        if self.peek() == "[" {
            self.pop()?;
            self.type_name(depth + 1)?;
            self.expect("]")?;
        } else {
            self.name()?;
        }
        if self.peek() == "!" {
            self.pop()?;
        }
        Ok(())
    }
    fn parse(mut self) -> Result<Vec<Field>> {
        if self.peek() != "{" {
            let op = self.pop()?;
            if op != "query" && op != "mutation" {
                return Err(bad());
            }
            if self.peek() != "(" && self.peek() != "{" {
                self.name()?;
            }
            if self.peek() == "(" {
                self.pop()?;
                while self.peek() != ")" {
                    self.expect("$")?;
                    let name = self.name()?;
                    self.expect(":")?;
                    self.type_name(0)?;
                    if self.peek() == "=" {
                        self.pop()?;
                        let v = self.value(0)?;
                        self.variables.entry(name).or_insert(v);
                    }
                }
                self.pop()?;
            }
        }
        let fields = self.selection(0)?;
        if self.at != self.tokens.len() {
            return Err(bad());
        }
        Ok(fields)
    }
}
// Count retained nodes as well as string bytes before materializing repeated
// variable references or aliases. Source/token limits alone do not bound these.
fn charge(budget: &mut usize, amount: usize) -> Result<()> {
    *budget = budget.checked_sub(amount).ok_or_else(bad)?;
    Ok(())
}
fn charge_value(value: &Value, budget: &mut usize) -> Result<()> {
    charge(budget, 64)?;
    match value {
        Value::String(text) => charge(budget, text.len())?,
        Value::Array(values) => {
            for value in values {
                charge_value(value, budget)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                charge(budget, key.len())?;
                charge_value(value, budget)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn select(value: &Value, fields: &[Field]) -> Result<Value> {
    let mut budget = crate::config::MAX_BODY;
    select_bounded(value, fields, &mut budget)
}
fn select_bounded(value: &Value, fields: &[Field], budget: &mut usize) -> Result<Value> {
    if fields.is_empty() || value.is_null() {
        charge_value(value, budget)?;
        return Ok(value.clone());
    }
    charge(budget, 64)?;
    if let Some(array) = value.as_array() {
        return array
            .iter()
            .map(|v| select_bounded(v, fields, budget))
            .collect::<Result<Vec<_>>>()
            .map(Value::Array);
    }
    let object = value.as_object().ok_or_else(bad)?;
    let mut result = Map::new();
    for f in fields {
        charge(budget, f.alias.len() + 64)?;
        result.insert(
            f.alias.clone(),
            select_bounded(object.get(&f.name).ok_or_else(bad)?, &f.children, budget)?,
        );
    }
    Ok(Value::Object(result))
}
fn reject_files(fields: &[Field]) -> Result<()> {
    for f in fields {
        if matches!(
            f.name.as_str(),
            "createRunFiles" | "markRunFilesUploaded" | "files"
        ) || f.name.to_ascii_lowercase().contains("artifact")
        {
            return Err(unsupported());
        }
        reject_files(&f.children)?;
    }
    Ok(())
}
async fn project(ctx: &Compat, entity: &str, name: &str) -> Result<Value> {
    let key = digest(json!([segment(entity)?, segment(name)?]).to_string());
    let _guard = ctx.lock(&format!("wandb.project.{key}")).await;
    if let Some(record) = ctx.get(PROJECTS, &key).await? {
        return Ok(record);
    }
    // Native experiment creation is unique by name and safe to retry after a crash.
    let (experiment, _) = ctx
        .db
        .create_experiment(format!("wandb/{entity}/{name}"))
        .await?;
    let record = json!({"id":experiment.id,"name":name,"entity":{"id":entity,"name":entity}});
    ctx.put(PROJECTS, &key, record.clone()).await?;
    Ok(record)
}
fn check_schema(run: &Value) -> Result<()> {
    if run["schema"] != SCHEMA {
        return Err(conflict("Unsupported W&B storage schema"));
    }
    Ok(())
}
async fn load(ctx: &Compat, key: &str) -> Result<Value> {
    let run = ctx.get(RUNS, key).await?.ok_or_else(ApiError::missing)?;
    check_schema(&run)?;
    Ok(run)
}
fn bucket(run: &Value) -> Value {
    let history = &run["streams"]["wandb-history.jsonl"];
    let events = &run["streams"]["wandb-events.jsonl"];
    let fallback = |v: &Value, d: Value| if v.is_null() { d } else { v.clone() };
    json!({"id":run["native_id"],"name":run["name"],"displayName":fallback(&run["displayName"],run["name"].clone()),
        "description":fallback(&run["description"],json!("")),"notes":fallback(&run["notes"],json!("")),
        "config":fallback(&run["config"],json!("{}")),"summaryMetrics":fallback(&run["summaryMetrics"],json!("{}")),
        "systemMetrics":fallback(&events["tail"][0],json!("{}")),"sweepName":null,"project":run["project_record"],
        "historyLineCount":fallback(&history["count"],json!(0)),"eventsLineCount":fallback(&events["count"],json!(0)),
        "logLineCount":fallback(&run["streams"]["output.log"]["count"],json!(0)),
        "historyTail":fallback(&history["tail"],json!([])).to_string(),"eventsTail":fallback(&events["tail"],json!([])).to_string(),
        "tags":fallback(&run["tags"],json!([])),"wandbConfig":if run["started"] == true {"{\"t\":1}"} else {"{}"},
        "state":fallback(&run["state"],json!("running")),"stopped":false})
}
fn params(run: &Value) -> Result<Map<String, Value>> {
    let config: Value =
        serde_json::from_str(run["config"].as_str().unwrap_or("{}")).map_err(|_| bad())?;
    let mut result = Map::new();
    for (key, value) in config.as_object().ok_or_else(bad)? {
        result.insert(
            key.clone(),
            value
                .as_object()
                .and_then(|v| v.get("value"))
                .unwrap_or(value)
                .clone(),
        );
    }
    models::object_keys(&result)?;
    Ok(result)
}
async fn finish_pending(ctx: &Compat, key: &str) -> Result<()> {
    let Some(pending) = ctx.get(PENDING, key).await? else {
        return Ok(());
    };
    check_schema(&pending)?;
    let run = &pending["run"];
    check_schema(run)?;
    let id = text(&run["native_id"])?;
    for batch in pending["batches"].as_array().ok_or_else(bad)? {
        let metrics: Vec<Metric> =
            serde_json::from_value(batch[1].clone()).map_err(ApiError::internal)?;
        ctx.ingest_metrics(id, text(&batch[0])?, metrics).await?;
    }
    if pending["patch"] == true {
        // Cached protocol state is not an explicit status mutation. Persist the
        // distinction so metadata retries/recovery cannot reopen terminal runs.
        // Legacy pending operations did not distinguish an explicit resume from
        // cached "running"; conservatively do not resume on their replay.
        let patch_status = pending["patch_status"]
            .as_bool()
            .unwrap_or(run["state"].as_str() != Some("running"));
        let status = run["state"]
            .as_str()
            .filter(|_| patch_status)
            .map(str::to_owned);
        ctx.db
            .patch_run(
                id.to_owned(),
                PatchRun {
                    status,
                    params: Some(params(run)?),
                    tags: None,
                },
            )
            .await?;
    }
    for (name, rows) in pending["rows"].as_object().ok_or_else(bad)? {
        ctx.put_many(
            &rows_namespace(key, name),
            rows.as_object()
                .ok_or_else(bad)?
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        )
        .await?;
    }
    ctx.put_many(
        &metric_namespace(key),
        pending["batches"]
            .as_array()
            .ok_or_else(bad)?
            .iter()
            .map(|b| Ok((text(&b[0])?.to_owned(), json!(true))))
            .collect::<Result<Vec<_>>>()?,
    )
    .await?;
    ctx.put(RUNS, key, run.clone()).await?;
    ctx.delete(PENDING, key).await?;
    Ok(())
}
fn merge_fields(run: &mut Value, values: &Map<String, Value>) -> Result<()> {
    for field in [
        "displayName",
        "description",
        "notes",
        "tags",
        "config",
        "summaryMetrics",
        "state",
    ] {
        let Some(value) = values.get(field).filter(|v| !v.is_null()) else {
            continue;
        };
        if field == "config" || field == "summaryMetrics" {
            let new: Value = serde_json::from_str(text(value)?).map_err(|_| bad())?;
            let mut old: Value =
                serde_json::from_str(run[field].as_str().unwrap_or("{}")).map_err(|_| bad())?;
            old.as_object_mut()
                .ok_or_else(bad)?
                .extend(new.as_object().ok_or_else(bad)?.clone());
            run[field] = json!(old.to_string());
        } else if field == "tags" {
            if !value
                .as_array()
                .is_some_and(|a| a.iter().all(Value::is_string))
            {
                return Err(bad());
            }
            run[field] = value.clone();
        } else {
            let s = text(value)?;
            if field == "state" && !["running", "finished", "failed"].contains(&s) {
                return Err(bad());
            }
            run[field] = value.clone();
        }
    }
    params(run)?;
    Ok(())
}
fn default_str<'a>(values: &'a Map<String, Value>, key: &str, default: &'a str) -> Result<&'a str> {
    match values.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => {
            let s = text(v)?;
            Ok(if s.is_empty() { default } else { s })
        }
    }
}
async fn upsert(ctx: &Compat, values: &Map<String, Value>) -> Result<Value> {
    let mut entity = default_str(values, "entityName", "nset")?.to_owned();
    let mut project_name = default_str(values, "modelName", "uncategorized")?.to_owned();
    let mut name = default_str(values, "name", "")?.to_owned();
    if name.is_empty() && values.get("id").is_some_and(Value::is_string) {
        let matches: Vec<_> = ctx
            .items(RUNS)
            .await?
            .into_iter()
            .filter(|(_, r)| r["native_id"] == values["id"])
            .collect();
        if matches.len() == 1 {
            entity = text(&matches[0].1["entity"])?.to_owned();
            project_name = text(&matches[0].1["project"])?.to_owned();
            name = text(&matches[0].1["name"])?.to_owned();
        }
    }
    let key = identity(&entity, &project_name, &name)?;
    let _guard = ctx.lock(&format!("wandb.run.{key}")).await;
    finish_pending(ctx, &key).await?;
    let existing = ctx.get(RUNS, &key).await?;
    let inserted = existing.is_none();
    let mut run = if let Some(run) = existing {
        check_schema(&run)?;
        run
    } else {
        json!({"schema":SCHEMA,"name":name,"entity":entity,"project":project_name,"streams":{},"created_ms":models::now()})
    };
    merge_fields(&mut run, values)?;
    if inserted {
        let project_record = project(ctx, &entity, &project_name).await?;
        run["project_record"] = project_record.clone();
        let input = NewRun { experiment_id: text(&project_record["id"])?.to_owned(), name: run["displayName"].as_str().unwrap_or(&name).to_owned(), params: params(&run)?, tags: json!({"compat":"wandb","wandb.entity":entity,"wandb.project":project_name,"wandb.run_id":name}).as_object().unwrap().clone() };
        run = ctx.create_run(RUNS, &key, input, run).await?;
    }
    run["started"] = json!(true);
    ctx.put(
        PENDING,
        &key,
        json!({"schema":SCHEMA,"run":run,"batches":[],"rows":{},"patch":true,"patch_status":values.get("state").is_some_and(Value::is_string)}),
    )
    .await?;
    finish_pending(ctx, &key).await?;
    Ok(json!({"bucket":bucket(&run),"inserted":inserted}))
}
fn viewer() -> Value {
    json!({"id":"nset","entity":"nset","username":"nset","email":null,"flags":"{}","teams":{"edges":[]}})
}
fn server_info() -> Value {
    json!({"features":[],"cliVersionInfo":{},"latestLocalVersionInfo":null})
}
fn introspect(name: &str) -> Value {
    let fields: Vec<String> = match name {
        "Query" => ["viewer", "serverInfo", "project", "model"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        "Mutation" => ["upsertBucket", "upsertModel", "upsertProject"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        "ServerInfo" => ["features", "cliVersionInfo"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        "Run" => bucket(&json!({}))
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect(),
        _ => return Value::Null,
    };
    json!({"name":name,"kind":"OBJECT","fields":fields.into_iter().map(|name|json!({"name":name})).collect::<Vec<_>>(),"inputFields":[]})
}
async fn graphql(ctx: &Compat, body: Value) -> Result<Value> {
    let variables = match body.get("variables") {
        None | Some(Value::Null) => Map::new(),
        Some(v) => v.as_object().ok_or_else(bad)?.clone(),
    };
    let fields = Document::new(text(&body["query"])?, variables)?.parse()?;
    reject_files(&fields)?;
    // Validate selected fields before a mutation can create a run/project.
    let mut project_shape = json!({"id":"","name":"","entity":{"id":"","name":""}});
    let mut bucket_shape = bucket(&json!({}));
    bucket_shape["project"] = project_shape.clone();
    project_shape["run"] = bucket_shape.clone();
    project_shape["bucket"] = bucket_shape.clone();
    for f in &fields {
        let shape = match f.name.as_str() {
            "viewer" => viewer(),
            "serverInfo" => server_info(),
            "__type" => introspect(f.args.get("name").and_then(Value::as_str).unwrap_or("")),
            "upsertBucket" => json!({"bucket":bucket_shape,"inserted":false}),
            "upsertModel" | "upsertProject" => {
                json!({"project":project_shape,"model":project_shape})
            }
            "model" | "project" => project_shape.clone(),
            _ => return Err(bad()),
        };
        select(&shape, &f.children)?;
    }
    let mut result = Map::new();
    let mut response_budget = crate::config::MAX_BODY;
    for f in fields {
        let value = match f.name.as_str() {
            "viewer" => viewer(),
            "serverInfo" => server_info(),
            "__type" => introspect(default_str(&f.args, "name", "")?),
            "upsertBucket" => {
                upsert(
                    ctx,
                    f.args
                        .get("input")
                        .and_then(Value::as_object)
                        .ok_or_else(bad)?,
                )
                .await?
            }
            "upsertModel" | "upsertProject" => {
                let v = f
                    .args
                    .get("input")
                    .and_then(Value::as_object)
                    .ok_or_else(bad)?;
                let record = project(
                    ctx,
                    default_str(v, "entityName", "nset")?,
                    default_str(v, "name", "uncategorized")?,
                )
                .await?;
                json!({"project":record,"model":record})
            }
            "model" | "project" => {
                let entity = default_str(&f.args, "entityName", "nset")?;
                let name = default_str(&f.args, "name", "uncategorized")?;
                let record = project(ctx, entity, name).await?;
                charge(&mut response_budget, f.alias.len() + 64)?;
                let mut selected = Map::new();
                for child in &f.children {
                    charge(&mut response_budget, child.alias.len() + 64)?;
                    if child.name == "run" || child.name == "bucket" {
                        let key = identity(entity, name, default_str(&child.args, "name", "")?)?;
                        let _guard = ctx.lock(&format!("wandb.run.{key}")).await;
                        finish_pending(ctx, &key).await?;
                        let run = match ctx.get(RUNS, &key).await? {
                            Some(r) => {
                                check_schema(&r)?;
                                bucket(&r)
                            }
                            None => Value::Null,
                        };
                        selected.insert(
                            child.alias.clone(),
                            select_bounded(&run, &child.children, &mut response_budget)?,
                        );
                    } else {
                        selected.insert(
                            child.alias.clone(),
                            select_bounded(
                                record.get(&child.name).ok_or_else(bad)?,
                                &child.children,
                                &mut response_budget,
                            )?,
                        );
                    }
                }
                result.insert(f.alias, Value::Object(selected));
                continue;
            }
            _ => return Err(bad()),
        };
        charge(&mut response_budget, f.alias.len() + 64)?;
        result.insert(
            f.alias,
            select_bounded(&value, &f.children, &mut response_budget)?,
        );
    }
    Ok(json!({"data":result}))
}

/// W&B raw history may contain Python NaN/Infinity or overflowed JSON numbers.
/// Replace only unquoted numeric tokens for projection, never the durable source.
fn history_json(line: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str(line) {
        return Some(value);
    }
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    let mut start = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            i += 1;
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i = (i + 1).min(bytes.len());
            continue;
        }
        if bytes[i].is_ascii_digit() || matches!(bytes[i], b'-' | b'N' | b'I') {
            let from = i;
            while i < bytes.len()
                && !matches!(
                    bytes[i],
                    b',' | b']' | b'}' | b':' | b' ' | b'\n' | b'\r' | b'\t'
                )
            {
                i += 1;
            }
            let token = &line[from..i];
            if matches!(token, "NaN" | "Infinity" | "-Infinity")
                || token.parse::<f64>().is_ok_and(|n| !n.is_finite())
            {
                out.push_str(&line[start..from]);
                out.push_str("null");
                start = i;
            }
        } else {
            i += 1;
        }
    }
    out.push_str(&line[start..]);
    serde_json::from_str(&out).ok()
}
fn projection(key: &str, name: &str, line: &str, offset: u64, run: &Value) -> Vec<(String, Value)> {
    let Some(Value::Object(source)) = history_json(line) else {
        return Vec::new();
    };
    let step = source.get("_step").cloned().unwrap_or(json!(offset));
    let Some(step) = step.as_f64().filter(|s| {
        s.is_finite() && *s >= 0.0 && *s <= models::MAX_SAFE as f64 && s.fract() == 0.0
    }) else {
        return Vec::new();
    };
    let timestamp = source
        .get("_timestamp")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= models::MAX_SAFE as f64 / 1000.0)
        .map(|n| (n * 1000.0) as i64)
        .unwrap_or_else(|| run["created_ms"].as_i64().unwrap_or(0));
    let prefix = if name == "wandb-events.jsonl" {
        "system/"
    } else {
        ""
    };
    let mut metrics = Vec::new();
    let sorted: BTreeMap<_, _> = source.iter().collect();
    for (k, v) in sorted {
        if k.is_empty() || k.starts_with('_') || prefix.len() + k.len() > 512 {
            continue;
        }
        if let Some(value) = v.as_f64().filter(|v| v.is_finite()) {
            metrics.push(json!({"seq":0,"key":format!("{prefix}{k}"),"step":step as i64,"timestamp":timestamp,"value":value}));
        }
    }
    let observation = if source.contains_key("_step") && source.contains_key("_timestamp") {
        // Typed metric values normalize integer/float spellings and key ordering.
        format!(
            "observation:{}",
            digest(
                json!([
                    source["_step"].as_f64(),
                    source["_timestamp"].as_f64(),
                    metrics
                ])
                .to_string()
            )
        )
    } else {
        format!("offset:{offset}")
    };
    metrics
        .chunks(10000)
        .enumerate()
        .map(|(chunk, rows)| {
            (
                format!(
                    "wb1-{}",
                    digest(format!("{key}:{name}:{observation}:{chunk}"))
                ),
                json!(rows),
            )
        })
        .collect()
}
async fn stream(
    ctx: &Compat,
    entity: &str,
    project: &str,
    name: &str,
    payload: Value,
) -> Result<Value> {
    let key = identity(entity, project, name)?;
    let empty = Map::new();
    let files = match payload.get("files") {
        None => &empty,
        Some(v) => v.as_object().ok_or_else(bad)?,
    };
    if files.keys().any(|f| !STREAMS.contains(&f.as_str())) {
        return Err(unsupported());
    }
    match payload.get("uploaded") {
        Some(uploaded) if !uploaded.as_array().ok_or_else(bad)?.is_empty() => {
            return Err(unsupported());
        }
        _ => {}
    }
    let complete = match payload.get("complete") {
        None => false,
        Some(v) => v.as_bool().ok_or_else(bad)?,
    };
    let exitcode = match payload.get("exitcode") {
        None => 0,
        Some(v) => v.as_i64().ok_or_else(bad)?,
    };
    let _guard = ctx.lock(&format!("wandb.run.{key}")).await;
    finish_pending(ctx, &key).await?;
    let mut run = load(ctx, &key).await?;
    let mut candidates = BTreeMap::new();
    let mut changes = Map::new();
    for (filename, content) in files {
        let offset = content["offset"]
            .as_u64()
            .filter(|n| *n <= models::MAX_SAFE as u64)
            .ok_or_else(bad)?;
        let lines = content["content"].as_array().ok_or_else(bad)?;
        if !lines.iter().all(Value::is_string) {
            return Err(bad());
        }
        let end = offset
            .checked_add(lines.len() as u64)
            .filter(|n| *n <= models::MAX_SAFE as u64)
            .ok_or_else(bad)?;
        let mut meta = run["streams"]
            .get(filename)
            .cloned()
            .unwrap_or(json!({"count":0,"bytes":0,"tail":[]}));
        let count = meta["count"].as_u64().ok_or_else(bad)?;
        let mut bytes = meta["bytes"].as_u64().ok_or_else(bad)?;
        if offset > count {
            return Err(conflict("OFFSET_GAP: filestream skips uncommitted records"));
        }
        let mutable = filename == "wandb-summary.json" || filename == "output.log";
        let mut changed = Map::new();
        for (index, line) in lines.iter().enumerate() {
            let index = offset + index as u64;
            if index < count {
                let old = ctx
                    .get(&rows_namespace(&key, filename), &index.to_string())
                    .await?
                    .ok_or_else(|| ApiError::internal("Committed W&B stream row missing"))?;
                if old == *line {
                    continue;
                }
                if !mutable {
                    return Err(conflict(
                        "OFFSET_CONFLICT: filestream already contains different data",
                    ));
                }
                bytes = bytes
                    .checked_sub(text(&old)?.len() as u64 + 1)
                    .ok_or_else(|| ApiError::internal("Corrupt stream byte count"))?;
            }
            bytes += text(line)?.len() as u64 + 1;
            changed.insert(index.to_string(), line.clone());
            if filename == "wandb-history.jsonl" || filename == "wandb-events.jsonl" {
                candidates.extend(projection(&key, filename, text(line)?, index, &run));
            }
        }
        meta["count"] = json!(count.max(end));
        meta["bytes"] = json!(bytes);
        if filename != "output.log" && !lines.is_empty() && end == count.max(end) {
            meta["tail"] = json!([lines.last().unwrap()]);
        }
        if !changed.is_empty() {
            changes.insert(filename.clone(), Value::Object(changed));
        }
        if filename == "wandb-summary.json"
            && meta["tail"][0]
                .as_str()
                .is_some_and(|tail| history_json(tail).is_some_and(|v| v.is_object()))
        {
            run["summaryMetrics"] = meta["tail"][0].clone();
        }
        run["streams"][filename] = meta;
    }
    let mut batches = Vec::new();
    for (batch, metrics) in candidates {
        if ctx.get(&metric_namespace(&key), &batch).await?.is_none() {
            batches.push(json!([batch, metrics]));
        }
    }
    if complete {
        run["state"] = json!(if exitcode == 0 { "finished" } else { "failed" });
        run["exitcode"] = json!(exitcode);
    }
    run["started"] = json!(true);
    ctx.put(
        PENDING,
        &key,
        json!({"schema":SCHEMA,"run":run,"batches":batches,"rows":changes,"patch":complete,"patch_status":complete}),
    )
    .await?;
    finish_pending(ctx, &key).await?;
    Ok(json!({"exitcode":run["exitcode"],"limits":{}}))
}
pub async fn handle(
    ctx: &Compat,
    method: &str,
    path: &str,
    body: Value,
    _query: &HashMap<String, String>,
) -> Result<Value> {
    if path.starts_with("/compat/files/wandb/") {
        return Err(unsupported());
    }
    if method != "POST" {
        return Err(ApiError(
            StatusCode::METHOD_NOT_ALLOWED,
            "W&B protocol requires POST",
        ));
    }
    if !body.is_object() {
        return Err(bad());
    }
    let path = path.trim_end_matches('/');
    if path == "/graphql" {
        return graphql(ctx, body).await;
    }
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() == 6 && parts[1] == "files" && parts[5] == "file_stream" {
        let decoded = parts[2..5]
            .iter()
            .map(|p| {
                percent_encoding::percent_decode_str(p)
                    .decode_utf8()
                    .map(|s| s.into_owned())
                    .map_err(|_| bad())
            })
            .collect::<Result<Vec<_>>>()?;
        return stream(ctx, &decoded[0], &decoded[1], &decoded[2], body).await;
    }
    Err(ApiError::bad("Unsupported W&B route"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_parser_alias_defaults_and_directives() {
        let fields = Document::new("query Q($show:Boolean=true) { me:viewer { id @include(if:$show) email @skip(if:true) } }",Map::new()).unwrap().parse().unwrap();
        assert_eq!(
            select(&viewer(), &fields[0].children).unwrap(),
            json!({"id":"nset"})
        );
        assert!(Document::new("{ viewer { ...F } }", Map::new()).is_err());
        assert!(
            Document::new(
                &format!("{}{}", "{a ".repeat(70), "}".repeat(70)),
                Map::new()
            )
            .unwrap()
            .parse()
            .is_err()
        );
        assert!(
            Document::new("{viewer{id}} {viewer{id}}", Map::new())
                .unwrap()
                .parse()
                .is_err()
        );
    }
    #[test]
    fn nonfinite_source_projection_and_stable_identity() {
        let run = json!({"created_ms":1});
        let a = projection(
            "r",
            "wandb-history.jsonl",
            r#"{"nan":NaN,"huge":1e9999,"yes":true,"loss":2,"_step":0,"_timestamp":12.5}"#,
            0,
            &run,
        );
        let b = projection(
            "r",
            "wandb-history.jsonl",
            r#"{"loss":2.0,"_timestamp":12.5,"_step":0.0}"#,
            8,
            &run,
        );
        assert_eq!(a, b);
        assert_eq!(a[0].1.as_array().unwrap().len(), 1);
        assert_ne!(
            a,
            projection(
                "r",
                "wandb-history.jsonl",
                r#"{"loss":2,"_step":0,"_timestamp":12.5001}"#,
                9,
                &run
            )
        );
    }

    fn reopen(path: &std::path::Path) -> Compat {
        let db = crate::db::Database::open(path).unwrap();
        let ingest = crate::ingest::DurableIngest::open(
            path,
            db.clone(),
            crate::ingest::IngestOptions::default(),
        )
        .unwrap();
        Compat::new(db, ingest)
    }

    #[tokio::test]
    async fn metadata_and_duplicate_history_cannot_reactivate_terminal_native_runs() {
        let directory = tempfile::tempdir().unwrap();
        let ctx = reopen(directory.path());
        upsert(
            &ctx,
            json!({"name":"r","entityName":"e","modelName":"p","state":"running"})
                .as_object()
                .unwrap(),
        )
        .await
        .unwrap();
        let key = identity("e", "p", "r").unwrap();
        let run = load(&ctx, &key).await.unwrap();
        let id = run["native_id"].as_str().unwrap().to_owned();
        let history = json!({"files":{"wandb-history.jsonl":{"offset":0,"content":["{\"loss\":1,\"_step\":0,\"_timestamp\":1}"]}}});
        stream(&ctx, "e", "p", "r", history.clone()).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while ctx.db.catalog().await.unwrap().metric_seq < 1 {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        ctx.db
            .patch_run(
                id.clone(),
                PatchRun {
                    status: Some("canceled".into()),
                    params: None,
                    tags: None,
                },
            )
            .await
            .unwrap();
        upsert(&ctx, json!({"name":"r","entityName":"e","modelName":"p","config":"{\"lr\":{\"value\":0.2}}"}).as_object().unwrap()).await.unwrap();
        assert_eq!(ctx.db.run(id.clone()).await.unwrap().status, "canceled");
        stream(&ctx, "e", "p", "r", history).await.unwrap();
        stream(&ctx, "e", "p", "r", json!({"files":{}}))
            .await
            .unwrap();
        assert_eq!(ctx.db.run(id.clone()).await.unwrap().status, "canceled");
        assert_eq!(ctx.db.catalog().await.unwrap().metric_seq, 1);
        // Recover a pre-upgrade metadata-only pending operation with cached state.
        let cached = load(&ctx, &key).await.unwrap();
        ctx.put(
            PENDING,
            &key,
            json!({"schema":SCHEMA,"run":cached,"batches":[],"rows":{},"patch":true}),
        )
        .await
        .unwrap();
        finish_pending(&ctx, &key).await.unwrap();
        assert_eq!(ctx.db.run(id.clone()).await.unwrap().status, "canceled");
        stream(&ctx, "e", "p", "r", json!({"files":{"wandb-history.jsonl":{"offset":1,"content":["{\"loss\":2,\"_step\":1,\"_timestamp\":2}"]}}})).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while ctx.db.run(id.clone()).await.unwrap().status != "running" {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(ctx.db.catalog().await.unwrap().metric_seq, 2);
    }

    #[tokio::test]
    async fn every_durable_replay_boundary_survives_reopen() {
        for stage in 0..=6 {
            let directory = tempfile::tempdir().unwrap();
            let ctx = reopen(directory.path());
            upsert(&ctx, json!({"name":"r","entityName":"e","modelName":"p","config":"{\"lr\":{\"value\":0.1}}"}).as_object().unwrap()).await.unwrap();
            let key = identity("e", "p", "r").unwrap();
            let mut run = load(&ctx, &key).await.unwrap();
            let id = run["native_id"].as_str().unwrap().to_owned();
            let line = r#"{"loss":1,"_step":5,"_timestamp":12.5}"#;
            let summary = r#"{"loss":1,"note":"finished"}"#;
            let console = "finished \u{e9}";
            let batches: Vec<_> = projection(&key, "wandb-history.jsonl", line, 0, &run)
                .into_iter()
                .map(|(k, v)| json!([k, v]))
                .collect();
            run["config"] =
                json!("{\"lr\":{\"value\":0.2},\"nested\":{\"value\":{\"flag\":true}}}");
            run["summaryMetrics"] = json!(summary);
            run["state"] = json!("finished");
            run["exitcode"] = json!(0);
            let mut rows = Map::new();
            for (name, line) in [
                ("wandb-history.jsonl", line),
                ("wandb-summary.json", summary),
                ("output.log", console),
            ] {
                rows.insert(name.into(), json!({"0":line}));
                run["streams"][name] = json!({"count":1,"bytes":line.len()+1,"tail":if name == "output.log" {vec![]} else {vec![line]}});
            }
            ctx.put(
                PENDING,
                &key,
                json!({"schema":SCHEMA,"run":run,"batches":batches,"rows":rows,"patch":true}),
            )
            .await
            .unwrap();
            // Simulate process death immediately after each durable stage; replay
            // must be valid whether or not its preceding acknowledgement arrived.
            if stage >= 1 {
                for b in &batches {
                    ctx.ingest_metrics(
                        &id,
                        b[0].as_str().unwrap(),
                        serde_json::from_value(b[1].clone()).unwrap(),
                    )
                    .await
                    .unwrap();
                }
            }
            if stage >= 2 {
                ctx.db
                    .patch_run(
                        id.clone(),
                        PatchRun {
                            status: Some("finished".into()),
                            params: Some(params(&run).unwrap()),
                            tags: None,
                        },
                    )
                    .await
                    .unwrap();
            }
            if stage >= 3 {
                for (name, rows) in &rows {
                    ctx.put_many(
                        &rows_namespace(&key, name),
                        rows.as_object()
                            .unwrap()
                            .iter()
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect(),
                    )
                    .await
                    .unwrap();
                }
            }
            if stage >= 4 {
                ctx.put_many(
                    &metric_namespace(&key),
                    batches
                        .iter()
                        .map(|b| (b[0].as_str().unwrap().to_owned(), json!(true)))
                        .collect(),
                )
                .await
                .unwrap();
            }
            if stage >= 5 {
                ctx.put(RUNS, &key, run.clone()).await.unwrap();
            }
            if stage >= 6 {
                ctx.delete(PENDING, &key).await.unwrap();
            }
            drop(ctx);
            let ctx = reopen(directory.path());
            let payload = json!({"files":{
                "wandb-history.jsonl":{"offset":0,"content":[line]},
                "wandb-summary.json":{"offset":0,"content":[summary]},
                "output.log":{"offset":0,"content":[console]}},"complete":true,"exitcode":0});
            stream(&ctx, "e", "p", "r", payload.clone()).await.unwrap();
            stream(&ctx, "e", "p", "r", payload).await.unwrap();
            assert!(
                ctx.get(PENDING, &key).await.unwrap().is_none(),
                "stage {stage}"
            );
            let native = ctx.db.run(id.clone()).await.unwrap();
            assert_eq!(native.status, "finished");
            assert_eq!(native.params["lr"], json!(0.2));
            assert_eq!(native.params["nested"], json!({"flag":true}));
            let points = ctx
                .db
                .metrics(
                    id,
                    models::MetricQuery {
                        policy: Default::default(),
                        key: "loss".into(),
                        after: None,
                        snapshot: None,
                        limit: None,
                    },
                )
                .await
                .unwrap();
            assert_eq!(points.total, 1, "stage {stage}");
            let run = load(&ctx, &key).await.unwrap();
            assert_eq!(bucket(&run)["historyLineCount"], 1);
            assert_eq!(
                bucket(&run)["historyTail"],
                json!(json!([line]).to_string())
            );
            assert_eq!(run["summaryMetrics"], summary);
            assert_eq!(
                ctx.get(&rows_namespace(&key, "output.log"), "0")
                    .await
                    .unwrap(),
                Some(json!(console))
            );
            // Repeat offline sync at a new source offset preserves the raw row,
            // but cannot add a second observation after any replay boundary.
            stream(
                &ctx,
                "e",
                "p",
                "r",
                json!({"files":{"wandb-history.jsonl":{"offset":1,"content":[line]}}}),
            )
            .await
            .unwrap();
            let points = ctx
                .db
                .metrics(
                    native.id,
                    models::MetricQuery {
                        policy: Default::default(),
                        key: "loss".into(),
                        after: None,
                        snapshot: None,
                        limit: None,
                    },
                )
                .await
                .unwrap();
            assert_eq!(points.total, 1);
        }
    }
    #[test]
    fn variable_and_selection_expansion_are_bounded_before_cloning() {
        let mut variables = Map::new();
        variables.insert("v".into(), json!("x".repeat(1024)));
        let mut document = Document::new(
            "{ a:__type(name:$v){name} b:__type(name:$v){name} }",
            variables,
        )
        .unwrap();
        document.expansion_budget = 1500;
        assert!(document.parse().is_err());
        let fields = Document::new("{ a:config b:config }", Map::new())
            .unwrap()
            .parse()
            .unwrap();
        let value = json!({"config":"x".repeat(1024)});
        assert!(select_bounded(&value, &fields, &mut 1500).is_err());
        assert!(select_bounded(&value, &fields, &mut 4096).is_ok());
    }
}
