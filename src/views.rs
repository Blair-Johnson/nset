//! Durable, explicitly saved WorkspaceV2 resources. Keep validation in sync with
//! web/src/workspace.ts, config.ts, and records.ts; source IDs need not be native runs.
use crate::{
    AppState,
    errors::{ApiError, Result},
    models::MAX_SAFE,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateView {
    workspace: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpdateView {
    revision: Value,
    workspace: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ViewQuery {
    revision: Option<String>,
}

pub(crate) async fn create(
    State(state): State<AppState>,
    Json(input): Json<CreateView>,
) -> Result<Response> {
    Ok((
        StatusCode::CREATED,
        Json(state.db.create_view(input.workspace).await?),
    )
        .into_response())
}
pub(crate) async fn list(State(state): State<AppState>) -> Result<Json<Value>> {
    Ok(Json(json!({"views": state.db.views().await?})))
}
pub(crate) async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ViewQuery>,
) -> Result<Response> {
    let revision = query
        .revision
        .map(|text| {
            let value = text
                .parse::<i64>()
                .map_err(|_| ApiError::bad("invalid view revision"))?;
            if !(1..=MAX_SAFE).contains(&value) {
                return Err(ApiError::bad("invalid view revision"));
            }
            Ok(value)
        })
        .transpose()?;
    match state.db.view(id, revision).await? {
        Some(view) => Ok(Json(view).into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}
pub(crate) async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateView>,
) -> Result<Json<Value>> {
    let revision = safe_integer(&input.revision, 1)?;
    Ok(Json(
        state.db.update_view(id, revision, input.workspace).await?,
    ))
}

fn invalid() -> ApiError {
    ApiError::bad("invalid saved workspace")
}
fn require(condition: bool) -> Result<()> {
    if condition { Ok(()) } else { Err(invalid()) }
}
fn object<'a>(v: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>> {
    let o = v.as_object().ok_or_else(invalid)?;
    require(o.keys().all(|key| fields.contains(&key.as_str())))?;
    Ok(o)
}
fn array(v: &Value) -> Result<&Vec<Value>> {
    v.as_array().ok_or_else(invalid)
}
fn text(v: &Value) -> Result<&str> {
    let s = v.as_str().ok_or_else(invalid)?;
    require(!s.trim_matches(js_whitespace).is_empty())?;
    Ok(s)
}
// ECMAScript String.trim includes BOM, but excludes Unicode NEL.
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn protected(s: &str) -> bool {
    matches!(s, "__proto__" | "constructor" | "prototype")
}
fn identity(v: &Value) -> Result<&str> {
    let s = text(v)?;
    require(!protected(s))?;
    Ok(s)
}
fn choice(v: &Value, choices: &[&str]) -> Result<()> {
    require(v.as_str().is_some_and(|s| choices.contains(&s)))
}
fn distinct<'a>(values: impl IntoIterator<Item = &'a str>) -> Result<()> {
    let mut seen = HashSet::new();
    require(values.into_iter().all(|s| seen.insert(s)))
}
fn strings(v: &Value, ids: bool) -> Result<()> {
    let values = array(v)?
        .iter()
        .map(|v| if ids { identity(v) } else { text(v) })
        .collect::<Result<Vec<_>>>()?;
    distinct(values)
}
pub(crate) fn safe_integer(v: &Value, min: i64) -> Result<i64> {
    let n = v.as_f64().ok_or_else(invalid)?;
    require(n.is_finite() && n.fract() == 0.0 && n >= min as f64 && n <= MAX_SAFE as f64)?;
    Ok(n as i64)
}
// JSON has no accessors, prototypes, sparse arrays, or cycles. Retain the
// frontend's protected-key and finite-number checks without resource budgets.
fn safe_json(v: &Value) -> Result<()> {
    let mut pending = vec![v];
    while let Some(v) = pending.pop() {
        match v {
            Value::Number(n) => require(n.as_f64().is_some_and(f64::is_finite))?,
            Value::Array(a) => pending.extend(a),
            Value::Object(o) => {
                require(o.keys().all(|key| !protected(key)))?;
                pending.extend(o.values());
            }
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn validate_workspace(v: &Value) -> Result<()> {
    safe_json(v)?;
    object(
        v,
        &[
            "version",
            "id",
            "name",
            "experimentId",
            "selectedRunIds",
            "pendingSelectedRunIds",
            "sections",
            "updatedAt",
        ],
    )?;
    require(v["version"].as_f64() == Some(2.0))?;
    identity(&v["id"])?;
    identity(&v["experimentId"])?;
    text(&v["name"])?;
    safe_integer(&v["updatedAt"], 0)?;
    strings(&v["selectedRunIds"], true)?;
    if let Some(pending) = v.get("pendingSelectedRunIds") {
        strings(pending, true)?;
        let selected: HashSet<_> = array(&v["selectedRunIds"])?
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect();
        require(
            array(pending)?
                .iter()
                .all(|id| !selected.contains(id.as_str().unwrap())),
        )?;
    }
    let sections = array(&v["sections"])?;
    let mut section_ids = HashSet::new();
    let mut card_ids = HashSet::new();
    for section in sections {
        object(section, &["id", "title", "collapsed", "cards"])?;
        require(section_ids.insert(identity(&section["id"])?))?;
        text(&section["title"])?;
        require(section["collapsed"].is_boolean())?;
        for card in array(&section["cards"])? {
            validate_chart(card)?;
            require(card_ids.insert(identity(&card["id"])?))?;
        }
    }
    Ok(())
}
fn series(v: &Value, kind: &str) -> Result<()> {
    object(v, &["runId", "key", "kind"])?;
    identity(&v["runId"])?;
    text(&v["key"])?;
    require(v["kind"].as_str() == Some(kind))
}
fn validate_chart(v: &Value) -> Result<()> {
    let o = object(
        v,
        &[
            "id", "title", "kind", "source", "x", "config", "outliers", "size", "layout", "records",
        ],
    )?;
    identity(&v["id"])?;
    text(&v["title"])?;
    choice(&v["kind"], &["timeseries", "image"])?;
    choice(&v["outliers"], &["all", "robust"])?;
    choice(&v["size"], &["normal", "wide"])?;
    let source = &v["source"];
    match source["mode"].as_str() {
        Some("selected") => {
            object(source, &["mode", "keys"])?;
            strings(&source["keys"], false)?;
        }
        Some("explicit") => {
            object(source, &["mode", "series"])?;
            let mut refs = HashSet::new();
            for s in array(&source["series"])? {
                series(
                    s,
                    if v["kind"] == "image" {
                        "image"
                    } else {
                        "metric"
                    },
                )?;
                require(refs.insert((s["runId"].as_str().unwrap(), s["key"].as_str().unwrap())))?;
            }
        }
        _ => return Err(invalid()),
    }
    if let Some(records) = o.get("records") {
        require(v["kind"] == "timeseries" && !o.contains_key("x"))?;
        validate_records(records)?;
    }
    if let Some(x) = o.get("x") {
        require(v["kind"] == "timeseries")?;
        match x["mode"].as_str() {
            Some("key") => {
                object(x, &["mode", "key"])?;
                text(&x["key"])?;
            }
            Some("series") => {
                object(x, &["mode", "series"])?;
                series(&x["series"], "metric")?;
            }
            _ => return Err(invalid()),
        }
    }
    if let Some(layout) = o.get("layout") {
        object(layout, &["width", "height"])?;
        require(
            (300..=4096).contains(&safe_integer(&layout["width"], 0)?)
                && (240..=2160).contains(&safe_integer(&layout["height"], 0)?),
        )?;
    }
    crate::view_config::validate_config(&v["config"])
}

fn record_path(v: &Value) -> Result<()> {
    let s = v.as_str().ok_or_else(invalid)?;
    require(!s.is_empty() && s.encode_utf16().count() <= 1024)?;
    let b = s.as_bytes();
    let mut i = usize::from(b.first() == Some(&b'$'));
    let mut parts = 0;
    while i < b.len() {
        require(parts < 32)?;
        if b[i] == b'.' {
            i += 1;
            require(i < b.len())?;
        } else if parts != 0 {
            require(b[i] == b'[')?;
        }
        if b[i] == b'[' {
            i += 1;
            if b.get(i) == Some(&b'"') {
                let start = i;
                i += 1;
                let mut escaped = false;
                while i < b.len() {
                    let c = b[i];
                    i += 1;
                    if c == b'"' && !escaped {
                        break;
                    }
                    escaped = c == b'\\' && !escaped;
                }
                serde_json::from_str::<String>(&s[start..i]).map_err(|_| invalid())?;
            } else {
                let start = i;
                while b.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                require(i > start)?;
                let n = s[start..i].parse::<f64>().map_err(|_| invalid())?;
                require(n.is_finite() && n <= MAX_SAFE as f64)?;
            }
            require(b.get(i) == Some(&b']'))?;
            i += 1;
        } else {
            require(
                b.get(i)
                    .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_'),
            )?;
            i += 1;
            while b
                .get(i)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
            {
                i += 1;
            }
        }
        parts += 1;
    }
    require(parts > 0)
}
fn validate_records(v: &Value) -> Result<()> {
    let o = object(v, &["sourceId", "runUids", "x", "ys", "filters", "group"])?;
    let source = v["sourceId"].as_str().ok_or_else(invalid)?;
    require(source.starts_with("rx:") && source.encode_utf16().count() <= 128)?;
    let uids = array(&v["runUids"])?
        .iter()
        .map(|v| {
            let s = v.as_str().ok_or_else(invalid)?;
            require(!s.is_empty() && s.encode_utf16().count() <= 128)?;
            Ok(s)
        })
        .collect::<Result<Vec<_>>>()?;
    distinct(uids)?;
    record_path(&v["x"])?;
    let ys = array(&v["ys"])?;
    require(!ys.is_empty() && ys.len() <= 16)?;
    for y in ys {
        record_path(y)?;
    }
    distinct(ys.iter().map(|y| y.as_str().unwrap()))?;
    if let Some(group) = o.get("group") {
        require(group.is_string())?;
        if group.as_str() != Some("") {
            record_path(group)?;
        }
    }
    let filters = &v["filters"];
    object(filters, &["any", "conditions"])?;
    require(filters["any"].is_boolean())?;
    let conditions = array(&filters["conditions"])?;
    require(conditions.len() <= 16)?;
    for c in conditions {
        let cobj = object(c, &["path", "op", "value"])?;
        record_path(&c["path"])?;
        choice(
            &c["op"],
            &["eq", "ne", "lt", "lte", "gt", "gte", "exists", "missing"],
        )?;
        let value = cobj.get("value").ok_or_else(invalid)?;
        require(value.is_null() || value.is_string() || value.is_number() || value.is_boolean())?;
        if let Some(n) = value.as_f64() {
            require(n.is_finite() && (n.fract() != 0.0 || n.abs() <= MAX_SAFE as f64))?;
        }
        require(
            serde_json::to_string(value)
                .map_err(ApiError::internal)?
                .encode_utf16()
                .count()
                <= 1024,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_json_has_no_size_budgets_but_rejects_protected_keys() {
        let expanded = json!(vec![vec![1e20; 3000]; 4]);
        assert!(serde_json::to_vec(&expanded).unwrap().len() < 262_144);
        assert!(safe_json(&expanded).is_ok());
        assert!(safe_json(&json!([1e20, -1e20, 1e21, 1e-6, 1e-7, 5e-324, 0.0, -0.0])).is_ok());
        assert!(safe_json(&json!(vec![0; 20_001])).is_ok());
        let mut nested = Value::Null;
        for _ in 0..33 {
            nested = json!([nested]);
        }
        assert!(safe_json(&nested).is_ok());
        assert!(safe_json(&json!({"long": "x".repeat(262_145)})).is_ok());
        assert!(safe_json(&json!({"prototype": 1})).is_err());
    }
}
