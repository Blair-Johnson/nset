use crate::errors::{ApiError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
pub const MAX_SAFE: i64 = 9_007_199_254_740_991;
pub type Object = Map<String, Value>;
/// Optional means omitted, not an explicitly null value of the wrong type.
fn optional_non_null<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
pub fn object_keys(object: &Object) -> Result<()> {
    for (key, value) in object {
        name(key)?;
        validate_nested_keys(value)?;
    }
    Ok(())
}
fn validate_nested_keys(value: &Value) -> Result<()> {
    match value {
        Value::Object(object) => object_keys(object)?,
        Value::Array(values) => {
            for value in values {
                validate_nested_keys(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn name(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 {
        Err(ApiError::bad("names and keys must be 1..512 UTF-8 bytes"))
    } else {
        Ok(())
    }
}
pub fn safe(value: i64) -> Result<()> {
    if !(0..=MAX_SAFE).contains(&value) {
        Err(ApiError::bad(
            "step/timestamp/cursor must be a nonnegative JS-safe integer",
        ))
    } else {
        Ok(())
    }
}
#[derive(Serialize, Deserialize, Debug)]
pub struct Experiment {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewExperiment {
    pub name: String,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct Run {
    pub id: String,
    pub experiment_id: String,
    pub name: String,
    pub status: String,
    pub params: Object,
    pub tags: Object,
    pub created_at: i64,
    pub updated_at: i64,
}
/// Compact discovery metadata; observations and image contents stay on their own routes.
#[derive(Serialize, Debug)]
pub struct Catalog {
    pub experiments: Vec<Experiment>,
    pub runs: Vec<Run>,
    pub series: Vec<CatalogSeries>,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SeriesKind {
    Metric,
    Image,
}
#[derive(Serialize, Debug)]
pub struct CatalogSeries {
    pub run_id: String,
    pub key: String,
    pub kind: SeriesKind,
    pub count: i64,
    pub last_step: i64,
    pub last_timestamp: i64,
    pub last_value: Option<f64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewRun {
    pub experiment_id: String,
    pub name: String,
    #[serde(default)]
    pub params: Object,
    #[serde(default)]
    pub tags: Object,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchRun {
    #[serde(default, deserialize_with = "optional_non_null")]
    pub status: Option<String>,
    #[serde(default, deserialize_with = "optional_non_null")]
    pub params: Option<Object>,
    #[serde(default, deserialize_with = "optional_non_null")]
    pub tags: Option<Object>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetricInput {
    pub key: String,
    pub step: i64,
    pub value: f64,
    #[serde(default, deserialize_with = "optional_non_null")]
    pub timestamp: Option<i64>,
}
impl MetricInput {
    pub fn validate(&self) -> Result<()> {
        name(&self.key)?;
        safe(self.step)?;
        if let Some(t) = self.timestamp {
            safe(t)?;
        }
        if !self.value.is_finite() {
            return Err(ApiError::bad("metric values must be finite"));
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetricBatch {
    pub metrics: Vec<MetricInput>,
}
#[derive(Serialize, Deserialize)]
pub struct Metric {
    pub seq: i64,
    pub key: String,
    pub step: i64,
    pub timestamp: i64,
    pub value: f64,
}
#[derive(Deserialize)]
pub struct MetricQuery {
    pub key: String,
    pub after: Option<i64>,
    pub snapshot: Option<i64>,
    pub limit: Option<usize>,
}
#[derive(Serialize)]
pub struct MetricPage {
    pub points: Vec<Metric>,
    pub next_after: Option<i64>,
    pub snapshot: i64,
    pub total: i64,
}
#[derive(Serialize, Deserialize, Debug)]
pub struct Image {
    pub id: String,
    pub run_id: String,
    pub key: String,
    pub step: i64,
    pub timestamp: i64,
    pub content_type: String,
    pub byte_length: i64,
}
#[derive(Deserialize)]
pub struct ImageQuery {
    pub key: String,
    pub step: i64,
    #[serde(default = "now")]
    pub timestamp: i64,
}
