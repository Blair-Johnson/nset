//! Validation of the closed, literal-only view configuration in web/src/config.ts.
//!
//! The caller must first enforce safe-JSON finite-number/protected-key checks.
//! Missing fields are valid client-default patches; validation never inserts defaults.
//! Colors match the frontend's Node fallback (hex, named, numeric rgb/hsl).
//! Browser-only CSS color formats are conservatively rejected.

use crate::errors::{ApiError, Result};
use serde_json::{Map, Value};
use std::collections::HashSet;

const INF: f64 = f64::INFINITY;
// JavaScript Number.MIN_VALUE is the smallest subnormal, not MIN_POSITIVE.
const POSITIVE: f64 = f64::from_bits(1);
const CAPS: &[&str] = &["butt", "round", "square"];
const FORMATS: &[&str] = &["number", "fixed-2", "scientific", "iso-time"];

#[derive(Clone, Copy)]
enum Check {
    Bool,
    String,
    Number(f64, f64),
    Strings(&'static [&'static str]),
    Numbers(&'static [f64]),
    Color,
    PxAlign,
    Dash,
    Custom(fn(&Value) -> Result<()>),
}

fn bad(message: &'static str) -> ApiError {
    ApiError::bad(message)
}

fn object(v: &Value) -> Result<&Map<String, Value>> {
    v.as_object()
        .ok_or_else(|| bad("view option: expected object"))
}

fn array(v: &Value) -> Result<&Vec<Value>> {
    v.as_array()
        .ok_or_else(|| bad("view option: expected array"))
}

fn number(v: &Value, min: f64, max: f64) -> Result<()> {
    match v.as_f64() {
        Some(n) if n.is_finite() && n >= min && n <= max => Ok(()),
        _ => Err(bad(
            "view option: finite number outside allowed range or wrong type",
        )),
    }
}

fn check(v: &Value, rule: Check) -> Result<()> {
    match rule {
        Check::Bool if v.is_boolean() => Ok(()),
        Check::String if v.is_string() => Ok(()),
        Check::Number(min, max) => number(v, min, max),
        Check::Strings(values) if v.as_str().is_some_and(|s| values.contains(&s)) => Ok(()),
        Check::Numbers(values) if v.as_f64().is_some_and(|n| values.contains(&n)) => Ok(()),
        Check::Color if v.as_str().is_some_and(safe_color) => Ok(()),
        Check::PxAlign if v.is_boolean() => Ok(()),
        Check::PxAlign => number(v, 0.0, 10.0),
        Check::Dash => numeric_array(v, 0.0, 100.0),
        Check::Custom(f) => f(v),
        _ => Err(bad(
            "view option: invalid type or unsupported literal value",
        )),
    }
}

fn fields(v: &Value, schema: &[(&str, Check)]) -> Result<()> {
    for (key, value) in object(v)? {
        let rule = schema
            .iter()
            .find(|(name, _)| *name == key)
            .ok_or_else(|| bad("view option: protected or unsupported field/callback"))?;
        check(value, rule.1)?;
    }
    Ok(())
}

fn numeric_array(v: &Value, min: f64, max: f64) -> Result<()> {
    for n in array(v)? {
        number(n, min, max)?;
    }
    Ok(())
}

fn nullable_number(v: &Value, min: f64, max: f64) -> Result<()> {
    if v.is_null() {
        Ok(())
    } else {
        number(v, min, max)
    }
}

fn increasing(v: &Value, positive: bool, empty: bool) -> Result<()> {
    numeric_array(v, if positive { POSITIVE } else { -INF }, INF)?;
    let a = array(v)?;
    if (!empty && a.is_empty()) || a.windows(2).any(|w| w[0].as_f64() >= w[1].as_f64()) {
        return Err(bad(
            "axis values must be strictly increasing (increments must be positive and nonempty)",
        ));
    }
    Ok(())
}

fn markers(v: &Value) -> Result<()> {
    use Check::*;
    fields(
        v,
        &[
            (
                "show",
                Custom(|v| {
                    if v.as_str() == Some("auto") {
                        Ok(())
                    } else {
                        check(v, Bool)
                    }
                }),
            ),
            ("size", Number(0.0, 100.0)),
            ("space", Number(0.0, 1000.0)),
            ("width", Number(0.0, 20.0)),
            ("stroke", Color),
            ("fill", Color),
            ("dash", Dash),
            ("cap", Strings(CAPS)),
        ],
    )
}

fn path_options(v: &Value) -> Result<()> {
    use Check::*;
    fields(
        v,
        &[
            ("alignGaps", Numbers(&[-1.0, 0.0, 1.0])),
            ("align", Numbers(&[-1.0, 1.0])),
            ("ascDesc", Bool),
            ("extend", Bool),
        ],
    )
}

fn validate_style(v: &Value) -> Result<()> {
    use Check::*;
    fields(
        v,
        &[
            ("color", Color),
            ("width", Number(0.0, 20.0)),
            ("pointSize", Number(1.0, 100.0)),
            ("fill", Number(0.0, 1.0)),
            ("dash", Dash),
            ("points", Bool),
            ("visible", Bool),
            (
                "path",
                Strings(&[
                    "matched",
                    "linear",
                    "stepped-before",
                    "stepped-after",
                    "spline",
                ]),
            ),
            ("cap", Strings(CAPS)),
            ("alpha", Number(0.0, 1.0)),
            ("pxAlign", PxAlign),
            ("fillColor", Color),
            ("fillTo", Number(-INF, INF)),
            ("auto", Bool),
            ("markers", Custom(markers)),
            ("pathOptions", Custom(path_options)),
        ],
    )
}

fn range_limit(v: &Value) -> Result<()> {
    use Check::*;
    fields(
        v,
        &[
            ("pad", Number(0.0, 10.0)),
            ("soft", Number(-INF, INF)),
            ("mode", Numbers(&[0.0, 1.0, 2.0, 3.0])),
            ("hard", Number(-INF, INF)),
        ],
    )
}

fn optional_number(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn validate_range(v: &Value) -> Result<()> {
    if let Some(a) = v.as_array() {
        if a.len() != 2 {
            return Err(bad("range must contain exactly [min,max]"));
        }
        for n in a {
            nullable_number(n, -INF, INF)?;
        }
        if let (Some(lo), Some(hi)) = (a[0].as_f64(), a[1].as_f64()) {
            if lo >= hi {
                return Err(bad("range minimum must be less than maximum"));
            }
        }
        return Ok(());
    }
    fields(
        v,
        &[
            ("min", Check::Custom(range_limit)),
            ("max", Check::Custom(range_limit)),
        ],
    )?;
    let (Some(lo), Some(hi)) = (v.get("min"), v.get("max")) else {
        return Err(bad("range requires min and max objects"));
    };
    let (lh, hh) = (optional_number(lo, "hard"), optional_number(hi, "hard"));
    let (ls, hs) = (optional_number(lo, "soft"), optional_number(hi, "soft"));
    if matches!((lh, hh), (Some(a), Some(b)) if a >= b)
        || matches!((ls, hs), (Some(a), Some(b)) if a > b)
        || matches!((ls, hh), (Some(a), Some(b)) if a >= b)
        || matches!((hs, lh), (Some(a), Some(b)) if a <= b)
    {
        return Err(bad("range hard/soft limits are inconsistent"));
    }
    Ok(())
}

// Called only after validate_range has checked the shape.
fn explicit_bounds(v: &Value) -> (Option<f64>, Option<f64>) {
    if let Some(a) = v.as_array() {
        (a[0].as_f64(), a[1].as_f64())
    } else {
        (
            v.get("min").and_then(|v| optional_number(v, "hard")),
            v.get("max").and_then(|v| optional_number(v, "hard")),
        )
    }
}

fn scale(v: &Value) -> Result<()> {
    use Check::*;
    fields(
        v,
        &[
            ("dir", Numbers(&[-1.0, 1.0])),
            ("log", Numbers(&[2.0, 10.0])),
            ("asinh", Number(POSITIVE, INF)),
            ("auto", Bool),
            ("range", Custom(validate_range)),
        ],
    )?;
    if v.get("auto").and_then(Value::as_bool) == Some(false) {
        if let Some(range) = v.get("range") {
            let (lo, hi) = explicit_bounds(range);
            if lo.is_none() || hi.is_none() {
                return Err(bad("auto:false requires both explicit range bounds"));
            }
        }
    }
    Ok(())
}

fn line(v: &Value, ticks: bool) -> Result<()> {
    use Check::*;
    // size is permitted on ticks, but never grid or border.
    let schema = [
        ("show", Bool),
        ("stroke", Color),
        ("width", Number(0.0, 10.0)),
        ("dash", Dash),
        ("cap", Strings(CAPS)),
        ("size", Number(0.0, 100.0)),
    ];
    fields(v, if ticks { &schema[..] } else { &schema[..5] })
}

fn legend(v: &Value) -> Result<()> {
    use Check::*;
    fields(
        v,
        &[
            ("show", Bool),
            ("live", Bool),
            ("isolate", Bool),
            (
                "markers",
                Custom(|v| {
                    fields(
                        v,
                        &[
                            ("show", Bool),
                            ("width", Number(0.0, 20.0)),
                            ("stroke", Color),
                            ("fill", Color),
                            (
                                "dash",
                                Strings(&[
                                    "none", "hidden", "dotted", "dashed", "solid", "double",
                                    "groove", "ridge", "inset", "outset",
                                ]),
                            ),
                        ],
                    )
                }),
            ),
        ],
    )
}

fn cursor(v: &Value) -> Result<()> {
    use Check::*;
    fields(
        v,
        &[
            ("show", Bool),
            ("x", Bool),
            ("y", Bool),
            ("lock", Bool),
            (
                "points",
                Custom(|v| {
                    fields(
                        v,
                        &[
                            ("show", Bool),
                            ("one", Bool),
                            ("size", Number(0.0, 100.0)),
                            ("width", Number(0.0, 20.0)),
                            ("stroke", Color),
                            ("fill", Color),
                        ],
                    )
                }),
            ),
            (
                "drag",
                Custom(|v| {
                    fields(
                        v,
                        &[
                            ("x", Bool),
                            ("y", Bool),
                            ("setScale", Bool),
                            ("dist", Number(0.0, 1000.0)),
                            ("uni", Custom(|v| nullable_number(v, 0.0, 1000.0))),
                        ],
                    )
                }),
            ),
            (
                "focus",
                Custom(|v| {
                    fields(
                        v,
                        &[
                            ("prox", Number(-1.0, 1e6)),
                            ("bias", Numbers(&[-1.0, 0.0, 1.0])),
                        ],
                    )
                }),
            ),
            (
                "hover",
                Custom(|v| {
                    fields(
                        v,
                        &[
                            ("prox", Custom(|v| nullable_number(v, 0.0, 1e6))),
                            ("bias", Numbers(&[-1.0, 0.0, 1.0])),
                            (
                                "skip",
                                Custom(|v| {
                                    for n in array(v)? {
                                        nullable_number(n, -INF, INF)?;
                                    }
                                    Ok(())
                                }),
                            ),
                        ],
                    )
                }),
            ),
        ],
    )
}

fn axis_values(v: &Value) -> Result<()> {
    if let Some(a) = v.as_array() {
        for n in a {
            if !n.is_null() && !n.is_string() {
                number(n, -INF, INF)?;
            }
        }
        Ok(())
    } else {
        check(v, Check::Strings(FORMATS))
    }
}

fn axes(v: &Value) -> Result<()> {
    use Check::*;
    let a = array(v)?;
    if a.len() > 2 {
        return Err(bad("axes accepts at most two positional patches"));
    }
    for (i, axis) in a.iter().enumerate() {
        fields(
            axis,
            &[
                ("show", Bool),
                ("label", String),
                ("font", String),
                ("labelFont", String),
                ("stroke", Color),
                ("size", Number(0.0, 200.0)),
                ("gap", Number(0.0, 200.0)),
                ("labelSize", Number(0.0, 200.0)),
                ("labelGap", Number(0.0, 200.0)),
                ("rotate", Number(-90.0, 90.0)),
                (
                    "side",
                    Numbers(if i == 0 { &[0.0, 2.0] } else { &[1.0, 3.0] }),
                ),
                ("align", Numbers(&[1.0, 2.0])),
                ("alignTo", Numbers(&[1.0, 2.0])),
                ("lineGap", Number(0.0, 10.0)),
                ("space", Number(POSITIVE, 1000.0)),
                ("incrs", Custom(|v| increasing(v, true, false))),
                ("splits", Custom(|v| increasing(v, false, true))),
                ("grid", Custom(|v| line(v, false))),
                ("border", Custom(|v| line(v, false))),
                ("ticks", Custom(|v| line(v, true))),
                ("values", Custom(axis_values)),
            ],
        )?;
        if let Some(values) = axis.get("values").and_then(Value::as_array) {
            if axis.get("splits").and_then(Value::as_array).map(Vec::len) != Some(values.len()) {
                return Err(bad(
                    "static axis values require static splits of matching length",
                ));
            }
        }
        if optional_number(axis, "rotate").is_some_and(|n| n != 0.0)
            && (i != 0 || optional_number(axis, "side").unwrap_or(2.0) != 2.0)
        {
            return Err(bad(
                "nonzero rotation is supported only on the bottom x axis",
            ));
        }
    }
    Ok(())
}

fn validate_advanced(v: &Value) -> Result<()> {
    use Check::*;
    fields(
        v,
        &[
            ("title", String),
            (
                "padding",
                Custom(|v| {
                    let a = array(v)?;
                    if a.len() != 4 {
                        return Err(bad("padding requires four entries"));
                    }
                    for n in a {
                        nullable_number(n, 0.0, 160.0)?;
                    }
                    Ok(())
                }),
            ),
            ("pxAlign", PxAlign),
            (
                "drawOrder",
                Custom(|v| {
                    let a = array(v)?;
                    if a.len() != 2
                        || !a.iter().any(|v| v.as_str() == Some("axes"))
                        || !a.iter().any(|v| v.as_str() == Some("series"))
                    {
                        return Err(bad("drawOrder requires axes and series exactly once each"));
                    }
                    Ok(())
                }),
            ),
            (
                "select",
                Custom(|v| fields(v, &[("show", Bool), ("over", Bool)])),
            ),
            (
                "focus",
                Custom(|v| fields(v, &[("alpha", Number(0.0, 1.0))])),
            ),
            (
                "scales",
                Custom(|v| fields(v, &[("x", Custom(scale)), ("y", Custom(scale))])),
            ),
            ("legend", Custom(legend)),
            ("cursor", Custom(cursor)),
            ("axes", Custom(axes)),
        ],
    )
}

fn annotation_text(v: &Value) -> Result<&str> {
    v.as_str()
        .filter(|s| !trim(s).is_empty())
        .ok_or_else(|| bad("chart details: expected nonempty text"))
}

fn annotation_identity(s: &str) -> bool {
    !trim(s).is_empty() && !matches!(s, "__proto__" | "constructor" | "prototype")
}

/// View-wide semantic names. Unavailable/unselected run IDs remain portable.
pub(crate) fn validate_run_labels(v: &Value) -> Result<()> {
    for (run_id, label) in object(v)? {
        if !annotation_identity(run_id) {
            return Err(bad("run labels: unsafe or empty run identity"));
        }
        annotation_text(label)?;
    }
    Ok(())
}

fn config_fields(v: &Value) -> Result<()> {
    let mut paths = HashSet::new();
    for field in array(v)? {
        fields(
            field,
            &[
                ("path", Check::Custom(|v| array(v).map(|_| ()))),
                ("label", Check::Custom(|v| annotation_text(v).map(|_| ()))),
            ],
        )?;
        let path = array(&field["path"])?;
        let segments = path
            .iter()
            .map(annotation_text)
            .collect::<Result<Vec<_>>>()?;
        if segments.is_empty() || segments.iter().any(|s| !annotation_identity(s)) {
            return Err(bad("chart details: unsafe or empty configuration path"));
        }
        // Segment arrays, not dot-joined strings: literal dotted keys stay distinct.
        if !paths.insert(segments) {
            return Err(bad("chart details: duplicate configuration path"));
        }
    }
    Ok(())
}

fn measurements(v: &Value) -> Result<()> {
    for (name, measurement) in object(v)? {
        if !annotation_identity(name)
            || !name
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
        {
            return Err(bad("chart details: invalid measurement identity"));
        }
        fields(
            measurement,
            &[
                ("axis", Check::Strings(&["x", "y"])),
                ("a", Check::Number(-INF, INF)),
                ("b", Check::Custom(|v| nullable_number(v, -INF, INF))),
            ],
        )?;
        // axis and a are required; b may be missing or null for a single cursor.
        check(&measurement["axis"], Check::Strings(&["x", "y"]))?;
        number(&measurement["a"], -INF, INF)?;
    }
    Ok(())
}

/// Validate optional authored metadata, after the caller's global safe-JSON checks.
/// Image charts can carry narrative/configuration fields and an empty measurement map.
pub(crate) fn validate_chart_details(v: &Value, image: bool) -> Result<()> {
    fields(
        v,
        &[
            ("markdown", Check::String),
            ("configFields", Check::Custom(config_fields)),
            ("measurements", Check::Custom(measurements)),
        ],
    )?;
    if image
        && v.get("measurements")
            .is_some_and(|v| v.as_object().is_some_and(|o| !o.is_empty()))
    {
        return Err(bad("image charts do not support measurements"));
    }
    Ok(())
}

/// Validate a partial view config after the caller's global safe-JSON checks.
pub(crate) fn validate_config(v: &Value) -> Result<()> {
    use Check::*;
    fields(
        v,
        &[
            ("version", Numbers(&[1.0])),
            ("axis", Strings(&["step", "timestamp", "relative"])),
            ("interpolation", Strings(&["linear", "pchip"])),
            ("smoothing", Bool),
            ("alpha", Number(POSITIVE, 1.0)),
            ("xScale", Strings(&["linear", "log", "asinh"])),
            ("yScale", Strings(&["linear", "log", "asinh"])),
            ("xMin", Custom(|v| nullable_number(v, -INF, INF))),
            ("xMax", Custom(|v| nullable_number(v, -INF, INF))),
            ("yMin", Custom(|v| nullable_number(v, -INF, INF))),
            ("yMax", Custom(|v| nullable_number(v, -INF, INF))),
            ("xLabel", String),
            ("yLabel", String),
            ("xFormat", Strings(FORMATS)),
            ("yFormat", Strings(FORMATS)),
            ("height", Number(240.0, 1800.0)),
            ("width", Custom(|v| nullable_number(v, 320.0, 8000.0))),
            ("grid", Bool),
            ("ticks", Bool),
            ("legend", Bool),
            ("cursor", Bool),
            ("zoom", Bool),
            ("palette", Bool),
            ("style", Custom(validate_style)),
            (
                "runs",
                Custom(|v| {
                    for style in object(v)?.values() {
                        validate_style(style)?;
                    }
                    Ok(())
                }),
            ),
            ("advanced", Custom(validate_advanced)),
        ],
    )?;
    for (i, axis) in ["x", "y"].iter().enumerate() {
        let advanced = v.get("advanced");
        let scale = advanced
            .and_then(|a| a.get("scales"))
            .and_then(|s| s.get(*axis));
        let built_in = Value::Array(vec![
            v.get(format!("{axis}Min")).cloned().unwrap_or(Value::Null),
            v.get(format!("{axis}Max")).cloned().unwrap_or(Value::Null),
        ]);
        // An advanced range replaces the complete built-in range, including null bounds.
        let range = scale.and_then(|s| s.get("range")).unwrap_or(&built_in);
        validate_range(range)?;
        let (lo, hi) = explicit_bounds(range);
        if scale.and_then(|s| s.get("auto")).and_then(Value::as_bool) == Some(false)
            && (lo.is_none() || hi.is_none())
        {
            return Err(bad("auto:false requires both explicit range bounds"));
        }
        if v.get(format!("{axis}Scale")).and_then(Value::as_str) == Some("log") {
            let nonpositive = if let Some(a) = range.as_array() {
                a.iter().any(|n| n.as_f64().is_some_and(|n| n <= 0.0))
            } else {
                ["min", "max"].iter().any(|side| {
                    ["hard", "soft"].iter().any(|key| {
                        range
                            .get(*side)
                            .and_then(|r| optional_number(r, key))
                            .is_some_and(|n| n <= 0.0)
                    })
                })
            };
            if nonpositive {
                return Err(bad("log range bounds must be positive"));
            }
            if let Some(splits) = advanced
                .and_then(|a| a.get("axes"))
                .and_then(|a| a.get(i))
                .and_then(|a| a.get("splits"))
                .and_then(Value::as_array)
            {
                if splits.iter().any(|n| n.as_f64().is_some_and(|n| n <= 0.0)) {
                    return Err(bad("log axis splits must be positive"));
                }
            }
        }
    }
    if v.get("yScale").and_then(Value::as_str) == Some("log") {
        let base = v.get("style").and_then(|s| optional_number(s, "fillTo"));
        if base.is_some_and(|n| n <= 0.0) {
            return Err(bad("log fillTo must be positive"));
        }
        if let Some(runs) = v.get("runs").and_then(Value::as_object) {
            for style in runs.values() {
                if optional_number(style, "fillTo")
                    .or(base)
                    .is_some_and(|n| n <= 0.0)
                {
                    return Err(bad("log fillTo must be positive"));
                }
            }
        }
    }
    Ok(())
}

// ECMAScript trim / \s differs from Rust whitespace (notably U+0085 and U+FEFF).
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn trim(s: &str) -> &str {
    s.trim_matches(js_whitespace)
}

fn numeric_color_part(s: &str) -> bool {
    let s = s.strip_suffix('%').unwrap_or(s);
    let b = s.as_bytes();
    let mut i = 0;
    if matches!(b.first(), Some(b'+') | Some(b'-')) {
        i += 1;
    }
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i - start;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if start == i {
            return false;
        } // CSS requires digits after a decimal point.
        digits += i - start;
    }
    if digits == 0 {
        return false;
    }
    if matches!(b.get(i), Some(b'e') | Some(b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+') | Some(b'-')) {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if start == i {
            return false;
        }
    }
    i == b.len() && s.parse::<f64>().is_ok_and(|n| n.is_finite())
}

fn safe_color(s: &str) -> bool {
    if s.encode_utf16().count() > 256 {
        return false;
    }
    let lower = trim(s).to_lowercase();
    let s = lower.as_str();
    if s.is_empty()
        || s.chars().any(|c| {
            c <= '\u{001f}' || matches!(c, ';' | '{' | '}' | '<' | '>' | '\\' | '\'' | '"')
        })
    {
        return false;
    }
    if let Some(hex) = s.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit());
    }
    if NAMED_COLORS.split_ascii_whitespace().any(|name| name == s) {
        return true;
    }
    let Some((name, body)) = s.split_once('(') else {
        return false;
    };
    let classic = matches!(name, "rgb" | "rgba" | "hsl" | "hsla");
    if !classic && !matches!(name, "hwb" | "lab" | "lch" | "oklab" | "oklch" | "color") {
        return false;
    }
    let Some(body) = body.strip_suffix(')') else {
        return false;
    };
    if !body.is_ascii() {
        return false;
    }
    let body = trim(body);
    // Numeric CSS Color 4 literals, not a complete CSS parser. Missing channels
    // (`none`), comments, escapes, math and relative/dynamic colors are rejected.
    // Browser support for individual spaces can vary; out-of-gamut numbers are
    // allowed and left to the browser's normal clipping/gamut mapping.
    let mut parts: Vec<&str>;
    if body.contains(',') {
        if !classic || body.contains('/') {
            return false;
        }
        parts = body.split(',').map(trim).collect();
    } else {
        let mut halves = body.split('/');
        let channels = halves.next().unwrap_or("");
        parts = trim(channels).split_ascii_whitespace().collect();
        if name == "color" {
            if parts.len() != 4
                || !matches!(
                    parts[0],
                    "srgb"
                        | "srgb-linear"
                        | "display-p3"
                        | "a98-rgb"
                        | "prophoto-rgb"
                        | "rec2020"
                        | "xyz"
                        | "xyz-d50"
                        | "xyz-d65"
                )
            {
                return false;
            }
            parts.remove(0);
        }
        if parts.len() != 3 {
            return false;
        }
        if let Some(alpha) = halves.next() {
            parts.push(trim(alpha));
        }
        if halves.next().is_some() {
            return false;
        }
    }
    if !matches!(parts.len(), 3 | 4) {
        return false;
    }
    let hue_index = match name {
        "hsl" | "hsla" | "hwb" => {
            if !parts[1].ends_with('%') || !parts[2].ends_with('%') {
                return false;
            }
            Some(0)
        }
        "lch" | "oklch" => Some(2),
        _ => None,
    };
    if let Some(i) = hue_index {
        for unit in ["deg", "grad", "rad", "turn"] {
            if let Some(hue) = parts[i].strip_suffix(unit) {
                parts[i] = hue;
                break;
            }
        }
        if parts[i].ends_with('%') {
            return false;
        }
    } else if matches!(name, "rgb" | "rgba")
        && body.contains(',')
        && parts[..3]
            .iter()
            .any(|p| p.ends_with('%') != parts[0].ends_with('%'))
    {
        return false;
    }
    parts.iter().all(|s| numeric_color_part(s))
}

const NAMED_COLORS: &str = "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chart_details_and_run_labels_match_frontend_schema_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/chart_details_schema.json"))
                .unwrap();
        for details in fixture["validDetails"].as_array().unwrap() {
            assert!(validate_chart_details(details, false).is_ok(), "{details}");
        }
        for details in fixture["invalidDetails"].as_array().unwrap() {
            assert!(validate_chart_details(details, false).is_err(), "{details}");
        }
        for labels in fixture["validRunLabels"].as_array().unwrap() {
            assert!(validate_run_labels(labels).is_ok(), "{labels}");
        }
        for labels in fixture["invalidRunLabels"].as_array().unwrap() {
            assert!(validate_run_labels(labels).is_err(), "{labels}");
        }
        assert!(validate_chart_details(&json!({"markdown":"", "configFields":[{"path":["optimizer", "lr"]}], "measurements":{}}), true).is_ok());
        assert!(
            validate_chart_details(&json!({"measurements":{"sample":{"axis":"x","a":0}}}), true)
                .is_err()
        );
    }

    #[test]
    fn partial_configs_and_complete_literal_subset() {
        assert!(validate_config(&json!({})).is_ok());
        assert!(
            validate_config(&json!({"version": 1.0, "style": {}, "runs": {"run": {}}})).is_ok()
        );
        let v = json!({
            "version": 1, "axis": "timestamp", "interpolation": "pchip",
            "smoothing": true, "alpha": 0.2, "xScale": "linear", "yScale": "asinh",
            "xMin": null, "xMax": 12, "yMin": -2, "yMax": 2,
            "xLabel": "time", "yLabel": "value", "xFormat": "iso-time", "yFormat": "fixed-2",
            "height": 440, "width": null, "grid": true, "ticks": false, "legend": true,
            "cursor": true, "zoom": false, "palette": false,
            "style": {
                "color": "#abcd", "width": 2, "dash": [0, 4], "points": false,
                "pointSize": 5, "fill": 0.2, "visible": true, "path": "spline", "cap": "round",
                "alpha": 0, "pxAlign": false, "fillColor": "rgb(1 2 3 / 50%)", "fillTo": -1,
                "auto": false,
                "markers": {"show": "auto", "size": 0, "space": 1000, "width": 20,
                    "stroke": "red", "fill": "transparent", "dash": [], "cap": "square"},
                "pathOptions": {"alignGaps": 0, "align": -1, "ascDesc": true, "extend": false}
            },
            "runs": {"run": {"path": "matched", "pxAlign": 10}},
            "advanced": {
                "title": "title", "padding": [null, 0, 160, null], "pxAlign": true,
                "drawOrder": ["series", "axes"], "select": {"show": true, "over": false},
                "focus": {"alpha": 1},
                "scales": {
                    "x": {"dir": -1, "log": 2, "asinh": 0.1, "auto": true, "range": [null, 10]},
                    "y": {"range": {"min": {"pad": 1, "soft": -1, "mode": 3, "hard": -2},
                        "max": {"pad": 0, "soft": 1, "mode": 0, "hard": 2}}}
                },
                "legend": {"show": true, "live": false, "isolate": true,
                    "markers": {"show": true, "width": 20, "stroke": "blue", "fill": "white", "dash": "dotted"}},
                "cursor": {"show": true, "x": true, "y": false, "lock": true,
                    "points": {"show": true, "one": false, "size": 100, "width": 20, "stroke": "red", "fill": "red"},
                    "drag": {"x": true, "y": false, "setScale": true, "dist": 1000, "uni": null},
                    "focus": {"prox": -1, "bias": 0},
                    "hover": {"prox": null, "bias": -1, "skip": [null, 0, -1]}},
                "axes": [{"show": true, "label": "x", "font": "12px sans-serif", "labelFont": "bold 12px serif",
                    "stroke": "black", "size": 200, "gap": 0, "labelSize": 200, "labelGap": 0,
                    "rotate": 90, "side": 2, "align": 1, "alignTo": 2, "lineGap": 10,
                    "space": 1, "incrs": [0.1, 1], "splits": [-1, 0, 1], "values": [null, "zero", 1],
                    "grid": {"show": false, "stroke": "gray", "width": 10, "dash": [1, 2], "cap": "butt"},
                    "border": {}, "ticks": {"size": 100}}, {"side": 3, "values": "scientific"}]
            }
        });
        assert!(validate_config(&v).is_ok());
    }

    #[test]
    fn rejects_unknown_fields_and_wrong_types_at_every_level() {
        for pointer in [
            "",
            "/style",
            "/style/markers",
            "/style/pathOptions",
            "/runs/run",
            "/advanced",
            "/advanced/select",
            "/advanced/focus",
            "/advanced/scales",
            "/advanced/scales/x",
            "/advanced/scales/x/range",
            "/advanced/scales/x/range/min",
            "/advanced/legend",
            "/advanced/legend/markers",
            "/advanced/cursor",
            "/advanced/cursor/points",
            "/advanced/cursor/drag",
            "/advanced/cursor/focus",
            "/advanced/cursor/hover",
            "/advanced/axes/0",
            "/advanced/axes/0/grid",
            "/advanced/axes/0/border",
            "/advanced/axes/0/ticks",
        ] {
            let mut v = json!({
                "style": {"markers": {}, "pathOptions": {}}, "runs": {"run": {}},
                "advanced": {"select": {}, "focus": {},
                    "scales": {"x": {"range": {"min": {}, "max": {}}}},
                    "legend": {"markers": {}},
                    "cursor": {"points": {}, "drag": {}, "focus": {}, "hover": {}},
                    "axes": [{"grid": {}, "border": {}, "ticks": {}}]}
            });
            assert!(validate_config(&v).is_ok());
            v.pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unsupported".into(), json!(true));
            assert!(validate_config(&v).is_err(), "{pointer}");
        }
        for v in [
            json!(null),
            json!([]),
            json!({"version": true}),
            json!({"alpha": 0}),
            json!({"style": null}),
            json!({"runs": []}),
            json!({"height": 239}),
            json!({"style": {"width": 21}}),
            json!({"style": {"dash": [-1]}}),
            json!({"style": {"pointSize": 0}}),
            json!({"style": {"markers": {"show": "yes"}}}),
            json!({"advanced": {"series": []}}),
            json!({"advanced": {"padding": [0, 0, 0]}}),
            json!({"advanced": {"drawOrder": ["axes", "axes"]}}),
            json!({"advanced": {"legend": {"markers": {"dash": []}}}}),
            json!({"advanced": {"axes": [null]}}),
            json!({"advanced": {"axes": [{"side": 1}]}}),
            json!({"advanced": {"axes": [{"grid": {"size": 2}}]}}),
            json!({"advanced": {"axes": [{"incrs": []}]}}),
            json!({"advanced": {"axes": [{"incrs": [0]}]}}),
            json!({"advanced": {"axes": [{"splits": [1, 1]}]}}),
            json!({"advanced": {"axes": [{"values": []}]}}),
            json!({"advanced": {"axes": [{"splits": [], "values": [0]}]}}),
            json!({"advanced": {"axes": [{"rotate": 1, "side": 0}]}}),
            json!({"advanced": {"axes": [{}, {"rotate": 1}]}}),
        ] {
            assert!(validate_config(&v).is_err(), "{v}");
        }
        assert!(validate_config(&json!({"alpha": POSITIVE,
            "advanced": {"scales": {"x": {"asinh": POSITIVE}}, "axes": [{"space": POSITIVE, "splits": [], "values": []}]}
        })).is_ok());
    }

    #[test]
    fn effective_ranges_and_log_constraints() {
        for v in [
            json!({"xMin": 2, "xMax": 1, "advanced": {"scales": {"x": {"range": [null, null]}}}}),
            json!({"xMin": 1, "xMax": 2, "advanced": {"scales": {"x": {"auto": false}}}}),
            json!({"xScale": "log", "xMin": -1, "advanced": {"scales": {"x": {"range": [1, 2]}}}}),
            json!({"advanced": {"scales": {"y": {"range": {"min": {"soft": 1}, "max": {"soft": 1}}}}}}),
            json!({"yScale": "log", "style": {"fillTo": 1}, "runs": {"run": {}}}),
        ] {
            assert!(validate_config(&v).is_ok(), "{v}");
        }
        for v in [
            json!({"xMin": 2, "xMax": 1}),
            json!({"advanced": {"scales": {"x": {"auto": false}}}}),
            json!({"xMin": 1, "xMax": 2, "advanced": {"scales": {"x": {"auto": false, "range": [null, 3]}}}}),
            json!({"advanced": {"scales": {"x": {"range": {"min": {}}}}}}),
            json!({"advanced": {"scales": {"x": {"range": {"min": {"hard": 1}, "max": {"hard": 1}}}}}}),
            json!({"advanced": {"scales": {"x": {"range": {"min": {"soft": 2}, "max": {"soft": 1}}}}}}),
            json!({"advanced": {"scales": {"x": {"range": {"min": {"soft": 2}, "max": {"hard": 2}}}}}}),
            json!({"advanced": {"scales": {"x": {"range": {"min": {"hard": 2}, "max": {"soft": 2}}}}}}),
            json!({"xScale": "log", "xMin": 0}),
            json!({"xScale": "log", "advanced": {"scales": {"x": {"range": {"min": {"soft": 0}, "max": {}}}}}}),
            json!({"xScale": "log", "advanced": {"axes": [{"splits": [-1, 1]}]}}),
            json!({"yScale": "log", "advanced": {"axes": [{}, {"splits": [0]}]}}),
            json!({"yScale": "log", "style": {"fillTo": 0}}),
            json!({"yScale": "log", "runs": {"run": {"fillTo": -1}}}),
        ] {
            assert!(validate_config(&v).is_err(), "{v}");
        }
    }

    #[test]
    fn color_four_numeric_literals_and_predefined_spaces() {
        for s in [
            "hwb(120 10% 20%)",
            "hwb(-.5turn 0% 0% / 50%)",
            "hwb(1e2deg 20% 30% / .2)",
            "lab(50% 0 0)",
            "lab(50 -20% +30% / 75%)",
            "lch(50% 30 270deg)",
            "lch(60 50% -1.2rad / .5)",
            "oklab(.6 .1 -.1)",
            "oklab(60% 20% -20% / 1e-1)",
            "oklch(60% .2 30)",
            "OKLCH(.6 20% 100grad / 80%)",
            "color(display-p3 1 0 .5 / .8)",
            "color(xyz-d50 25% 40% 50%)",
            "color(srgb -1 2 1e-2)",
        ] {
            assert!(safe_color(s), "{s}");
            assert!(
                validate_config(&json!({"style":{"color":s}})).is_ok(),
                "{s}"
            );
        }
        for space in [
            "srgb",
            "srgb-linear",
            "display-p3",
            "a98-rgb",
            "prophoto-rgb",
            "rec2020",
            "xyz",
            "xyz-d50",
            "xyz-d65",
        ] {
            assert!(
                safe_color(&format!("color({space} .1 20% 3e-1 / 50%)")),
                "{space}"
            );
        }
        for s in [
            "hwb(120, 10%, 20%)",
            "hwb(120 10 20%)",
            "hwb(0%deg 10% 20%)",
            "hwb(10% 20% 30%)",
            "lab(50%, 0, 0)",
            "lab(50% 0 0 .5)",
            "lab(50% 0 0 /)",
            "lab(50% 0 0 / .5 / .5)",
            "lab(50% 0)",
            "lch(50% 30 20%)",
            "oklch(60% .2 0%turn)",
            "oklch(60% .2 30px)",
            "oklab(.6 .1 1e999)",
            "oklab(.6 .1 NaN)",
            "lab(50% 0. 0)",
            "color(srgb 1 0)",
            "color(srgb 1 0 0 .5)",
            "color(srgb, 1, 0, 0)",
            "color(srgb 1deg 0 0)",
            "color(xyz-d60 1 0 0)",
            "color(--custom 1 0 0)",
            "color(srgb 1 0 0 / 50%deg)",
            "color(srgb 1 0 0))",
            "color(from red srgb r g b)",
            "lab(from red l a b)",
            "oklch(60% var(--c) 30)",
            "lab(calc(50) 0 0)",
            "lab(env(x) 0 0)",
            "color(srgb url(x) 0 0)",
            "hwb(10 20% 30% /*comment*/)",
            "lab(50% none 0)",
            "lab(\u{00a0}50% 0 0)",
            "rgb(1 2 3\u{00a0})",
        ] {
            assert!(!safe_color(s), "{s}");
            assert!(
                validate_config(&json!({"style":{"color":s}})).is_err(),
                "{s}"
            );
        }
    }
    #[test]
    fn classic_colors_keep_strict_numeric_grammar() {
        for s in [
            "#abc",
            "#abcd",
            "#123456",
            "#12345678",
            " ReBeccAPurple ",
            "transparent",
            "rgb(1, 2, 3)",
            "rgba(1 2 3)",
            "rgb(1e2 -2 +.3 / 50%)",
            "hsl(1turn 20% 30% / .5)",
            "hsl(10grad,20%,30%)",
            "\u{feff}red\u{feff}",
            "\tred\n",
        ] {
            assert!(safe_color(s), "{s}");
        }
        for s in [
            "",
            "#ab",
            "#12345",
            "#ggg",
            "currentColor",
            "inherit",
            "url(x)",
            "var(--x)",
            "rgb(from red r g b)",
            "rgb(1,2,3 / .5)",
            "rgb(1 2 3 / .5 / .5)",
            "rgb(1 2)",
            "rgb(1e999 2 3)",
            "rgb(1\t2 3)",
            "rgb(1\u{0085}2 3)",
            "red;",
            "hsl(1 2 3)",
            "hsl(1% 2% 3%)",
            "hsl(0%deg 20% 30%)",
            "rgb(1.,2,3)",
            "rgb(1%,2,3)",
            "rgb(1\u{00a0}2 3)",
            "hsl(1foo 2% 3%)",
            "rgba(1 2 3 .5)",
            "hsla(1, 2%, 3%, .5, 1)",
        ] {
            assert!(!safe_color(s), "{s}");
        }
        assert!(!safe_color(&format!("{}red", " ".repeat(254))));
    }
}
