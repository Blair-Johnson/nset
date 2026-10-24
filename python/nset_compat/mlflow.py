"""MLflow scalar tracking REST adapter (no MLflow dependency).

Wire contract: upstream mlflow/protos/service.proto. Scalar storage is native; SQLite
compat state stores identity, lifecycle, metadata and recoverable pending writes.
Unsupported endpoints/fields, non-finite metrics, negative or >2**53-1 steps and
timestamps, artifacts and extended model/dataset metrics fail closed.
Search deliberately supports AND comparisons, not the full MLflow SQL grammar.

Metric identity/latest caches assume all metric writes for mapped runs go through
this adapter. Mixing direct native metric edits is unsupported; read-only native
UI access is unaffected. Explicit history still reads native storage. Legacy runs
backfill once under their run lock; new runs need no native history scan.
"""
import base64
import hashlib
import json
import math
import re
import time
import uuid

from .common import ProtocolError, Response

EXP = "mlflow.experiments"
RUN = "mlflow.runs"
MAX_SAFE = 9007199254740991
API = "/api/2.0/mlflow/"
# Required SDK metadata resolves only to this gateway, where all artifact routes
# reject requests. Empty/file URIs would accidentally enable local SDK writes.
_ARTIFACT_URI = "mlflow-artifacts:/unsupported"
STATUS = {"RUNNING": "running", "SCHEDULED": "running", "FINISHED": "finished",
          "FAILED": "failed", "KILLED": "failed"}


def _bad(message, code="INVALID_PARAMETER_VALUE", status=400):
    raise ProtocolError(status, code, message)


def _unsupported(message):
    _bad(message, "NOT_IMPLEMENTED", 501)


def _now():
    return time.time_ns() // 1000000


def _fields(data, allowed):
    extra = set(data) - set(allowed.split())
    if extra:
        _unsupported("Unsupported MLflow fields: " + ", ".join(sorted(extra)))


def _text(value, label, empty=False):
    if not isinstance(value, str) or (not value and not empty) or "\x00" in value:
        _bad(label + " must be a " + ("nonempty " if not empty else "") + "string without NUL")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        _bad(label + " must be valid UTF-8")
    return value


def _key(value):
    value = _text(value, "key/name")
    if len(value.encode("utf-8")) > 512:
        _bad("Native keys/names are limited to 512 UTF-8 bytes")
    return value


def _integer(value, label, minimum=0, maximum=MAX_SAFE):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        _bad(label + " must be an integer")
    if isinstance(value, str) and not re.fullmatch(r"-?\d+", value):
        _bad(label + " must be an integer")
    value = int(value)
    if not minimum <= value <= maximum:
        _bad(f"{label} must be in [{minimum}, {maximum}]")
    return value


def _pairs(items):
    if not isinstance(items, list):
        _bad("params/tags must be arrays")
    result = {}
    for item in items:
        if not isinstance(item, dict):
            _bad("params/tags entries must be objects")
        _fields(item, "key value")
        key, value = _key(item.get("key")), _text(item.get("value"), "value", empty=True)
        if key in result and result[key] != value:
            _bad("Conflicting duplicate key: " + key)
        result[key] = value
    return result


def _wire_pairs(values):
    return [{"key": k, "value": v} for k, v in sorted(values.items())]


def _save_exp(ctx, exp):
    ctx.state.put(EXP, exp["experiment_id"], exp)


def _save_run(ctx, run):
    ctx.state.put(RUN, run["info"]["run_id"], run)


def _new_exp(ctx, name, eid, tags):
    # Native names remain immutable; preserve the exact, renameable external name
    # in compat metadata. Truncate only the native display suffix on UTF-8 bounds.
    prefix = f"mlflow:{eid}:"
    native_name = prefix + name.encode("utf-8")[:512 - len(prefix)].decode("utf-8", errors="ignore")
    native = ctx.native.request("POST", "/api/experiments", {"name": native_name})
    now = _now()
    exp = {"experiment_id": eid, "native_id": native["id"], "name": name,
           "artifact_location": _ARTIFACT_URI, "lifecycle_stage": "active",
           "creation_time": now, "last_update_time": now, "tags": tags, "lifecycle_epoch": 0}
    _save_exp(ctx, exp)
    return exp


def _default(ctx):
    with ctx.lock_for("mlflow:experiment:0"):
        if ctx.state.get(EXP, "0") is None:
            _new_exp(ctx, "Default", "0", {})


def _experiment(ctx, eid):
    eid = str(_integer(eid, "experiment_id"))
    exp = ctx.state.get(EXP, eid)
    if eid == "0" and exp is None:
        _default(ctx)
        exp = ctx.state.get(EXP, eid)
    if exp is None:
        _bad("Experiment not found: " + eid, "RESOURCE_DOES_NOT_EXIST", 404)
    return exp


def _exp_wire(exp):
    return {**{k: v for k, v in exp.items() if k not in ("native_id", "tags", "lifecycle_epoch")},
            "tags": _wire_pairs(exp["tags"])}


def _active(value):
    stage = value.get("lifecycle_stage", value.get("info", {}).get("lifecycle_stage"))
    if stage != "active":
        _bad("Operation requires an active experiment/run", "INVALID_STATE")


def _run_id(data):
    rid = data.get("run_id") or data.get("run_uuid")
    if data.get("run_id") and data.get("run_uuid") and data["run_id"] != data["run_uuid"]:
        _bad("run_id and run_uuid disagree")
    if not isinstance(rid, str) or not re.fullmatch(r"[0-9a-f]{32}", rid):
        _bad("run_id must be a 32-character lowercase hexadecimal identifier")
    return rid


def _run(ctx, rid):
    run = ctx.state.get(RUN, rid)
    if run is None:
        _bad("Run not found: " + rid, "RESOURCE_DOES_NOT_EXIST", 404)
    _ensure_metric_index(ctx, run)
    _recover(ctx, run)
    exp = _experiment(ctx, run["info"]["experiment_id"])
    epoch = exp.get("lifecycle_epoch", 0)
    if run.get("experiment_epoch", 0) != epoch:
        # Experiment deletion/restoration applies atomically to all its runs;
        # materialize lazily so process death cannot split a lifecycle cascade.
        run["experiment_epoch"] = epoch
        run["info"]["lifecycle_stage"] = exp["lifecycle_stage"]
        _save_run(ctx, run)
    return run


def _metric_tuple(metric):
    return metric["key"], metric["step"], metric["timestamp"], metric["value"]


def _history(ctx, run, key):
    query = {"key": key, "limit": 10000}
    result = {}
    while True:
        page = ctx.native.request("GET", f'/api/runs/{run["native_id"]}/metrics', query=query)
        for point in page["points"]:
            metric = {k: point[k] for k in ("key", "value", "timestamp", "step")}
            result[_metric_tuple(metric)] = metric
        if page.get("next_after") is None:
            break
        query.update(after=page["next_after"], snapshot=page["snapshot"])
    return sorted(result.values(), key=lambda m: (m["step"], m["timestamp"], m["value"]))


def _metric_namespace(run):
    return "mlflow.metric-identities.v1:" + run["info"]["run_id"]


def _metric_identity(metric):
    # Exact, unambiguous identity rather than a digest with collision assumptions.
    # Native JSON may encode integral values as integers; normalize to the same
    # double used by _metrics before serializing both old and new observations.
    return json.dumps([metric["key"], metric["step"], metric["timestamp"], float(metric["value"])],
                      ensure_ascii=True, separators=(",", ":"), allow_nan=False)


def _update_latest(latest, metrics):
    for metric in metrics:
        old = latest.get(metric["key"])
        if old is None or _metric_tuple(metric)[1:] > _metric_tuple(old)[1:]:
            latest[metric["key"]] = metric


def _ensure_metric_index(ctx, run):
    """One-time migration under the run lock; publish marker only after indexing."""
    version = run.get("metric_index_version")
    if version == 1:
        return
    if version is not None:
        _unsupported("Unsupported persisted metric index version")
    latest = {}
    for key in run["metric_keys"]:
        metrics = _history(ctx, run, key)
        ctx.state.put_many(_metric_namespace(run), {_metric_identity(m): True for m in metrics})
        _update_latest(latest, metrics)
    run["latest_metrics"] = latest
    run["metric_index_version"] = 1
    # A crash before this atomic metadata write repeats a safe, idempotent
    # backfill. Pending legacy payloads remain intact for stable native replay.
    _save_run(ctx, run)


def _run_wire(ctx, run):
    latest = [run["latest_metrics"][key] for key in sorted(run["latest_metrics"])]
    return {"info": run["info"], "data": {"metrics": latest,
            "params": _wire_pairs(run["params"]), "tags": _wire_pairs(run["tags"])}}


def _recover(ctx, run):
    """Called under the run lock; pending intent is durable before native I/O."""
    pending = run.get("pending")
    if pending is None:
        return
    metrics = pending["metrics"]
    for offset in range(0, len(metrics), 10000):
        chunk = metrics[offset:offset + 10000]
        canonical = json.dumps(chunk, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        batch_id = "mlflow-" + hashlib.sha256(canonical).hexdigest()
        ctx.ingest_metrics(run["native_id"], batch_id, chunk, wait=True)
    # Never filter a pending payload through the index: an interrupted commit
    # must replay the original chunks/IDs, including after the index persisted.
    ctx.state.put_many(_metric_namespace(run), {_metric_identity(m): True for m in metrics})
    _update_latest(run["latest_metrics"], metrics)
    patch = pending.get("patch", {})
    if patch:
        ctx.native.request("PATCH", f'/api/runs/{run["native_id"]}', patch)
    run["params"].update(pending.get("params", {}))
    for key, value in pending.get("tags", {}).items():
        if value is None:
            run["tags"].pop(key, None)
        else:
            run["tags"][key] = value
    run["info"].update(pending.get("info", {}))
    run["metric_keys"] = sorted(set(run["metric_keys"]) | {m["key"] for m in metrics})
    run.pop("pending")
    # Latest values, params/tags/info and intent removal publish atomically.
    # Until this succeeds, durable pending still drives replay (not index hits).
    _save_run(ctx, run)


def _commit(ctx, run, *, metrics=None, params=None, tags=None, info=None, patch=None):
    run["pending"] = {"metrics": metrics or [], "params": params or {},
                      "tags": tags or {}, "info": info or {}, "patch": patch or {}}
    _save_run(ctx, run)
    _recover(ctx, run)


def _metrics(items, rid):
    if not isinstance(items, list):
        _bad("metrics must be an array")
    result = {}
    for item in items:
        if not isinstance(item, dict):
            _bad("metrics entries must be objects")
        _fields(item, "key value timestamp step dataset_name dataset_digest model_id run_id")
        if any(item.get(k) for k in ("dataset_name", "dataset_digest", "model_id")):
            _unsupported("Dataset/model-associated metrics are not supported")
        if item.get("run_id") not in (None, "", rid):
            _bad("Metric run_id does not match the request")
        value = item.get("value")
        if isinstance(value, bool) or not isinstance(value, (float, int)):
            _bad("Metric values must be finite JSON numbers (NaN/Infinity are unsupported)")
        try:
            value = float(value)
        except (OverflowError, ValueError):
            _bad("Metric values must be finite")
        if not math.isfinite(value):
            _bad("Native storage does not support NaN or Infinity")
        if value == 0.0 and math.copysign(1.0, value) < 0:
            _bad("Native scalar storage cannot preserve negative zero")
        metric = {"key": _key(item.get("key")), "value": value,
                  "timestamp": _integer(item.get("timestamp"), "timestamp"),
                  "step": _integer(item.get("step", 0), "step")}
        result[_metric_tuple(metric)] = metric
    return sorted(result.values(), key=_metric_tuple)


def _log(ctx, run, data):
    params, tags = _pairs(data.get("params", [])), _pairs(data.get("tags", []))
    metrics = _metrics(data.get("metrics", []), run["info"]["run_id"])
    for key, value in params.items():
        if key in run["params"] and run["params"][key] != value:
            _bad("Changing param values is not allowed: " + key)
    # MLflow SQL stores exact duplicate observations once, even across batch boundaries.
    identities = {_metric_identity(m): m for m in metrics}
    existing = ctx.state.get_many(_metric_namespace(run), identities)
    metrics = [m for identity, m in identities.items() if identity not in existing]
    info = {"run_name": tags["mlflow.runName"]} if "mlflow.runName" in tags else {}
    _commit(ctx, run, metrics=metrics, params=params, tags=tags, info=info,
            patch={k: v for k, v in (("params", params), ("tags", tags)) if v})


# A deliberately small, fully consumed grammar. Never eval SQL or ignore a suffix.
_IDENT = r'(?:`[^`]+`|[A-Za-z_][A-Za-z0-9_.\-/]*)'
_FIELD = rf'{_IDENT}(?:\.{_IDENT})?'
_LITERAL = r"(?:'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)"
_CLAUSE = re.compile(rf'\s*({_FIELD})\s*(>=|<=|!=|=|>|<|ILIKE\b|LIKE\b)\s*({_LITERAL})', re.I)


def _field(name, kind):
    parts = name.split(".", 1)
    if len(parts) == 2 and parts[0] in ("metrics", "metric", "params", "param", "tags", "tag", "attributes", "attribute"):
        category, key = parts[0], parts[1].strip("`")
        category = {"metric": "metrics", "param": "params", "tag": "tags", "attribute": "attributes"}.get(category, category)
    else:
        category, key = "attributes", name.strip("`")
    allowed = ({"name", "experiment_id", "creation_time", "last_update_time"} if kind == "experiment" else
               {"run_id", "run_name", "experiment_id", "user_id", "status", "start_time", "end_time"})
    if category == "attributes" and key not in allowed:
        _bad("Unsupported search attribute: " + key)
    if kind == "experiment" and category not in ("attributes", "tags"):
        _bad("Experiment search supports only attributes and tags")
    if not key:
        _bad("Empty search key")
    return category, key


def _value(row, field, kind):
    category, key = field
    if category == "attributes":
        return (row if kind == "experiment" else row["info"]).get(key)
    values = row[category] if kind == "experiment" else row["data"][category]
    if isinstance(values, dict):
        return values.get(key)
    return next((p["value"] for p in values if p["key"] == key), None)


def _predicate(expression, kind):
    expression = _text(expression, "filter", empty=True)
    clauses, position = [], 0
    while expression[position:].strip():
        match = _CLAUSE.match(expression, position)
        if not match:
            _bad("Unsupported filter syntax; use AND-separated comparisons")
        field, op, literal = match.groups()
        field = _field(field, kind)
        if literal[0] in "'\"":
            expected = literal[1:-1].replace(literal[0] * 2, literal[0])
        else:
            expected = float(literal)
            if not math.isfinite(expected):
                _bad("Search numeric literals must be finite")
        numeric = field[0] == "metrics" or field[1] in ("start_time", "end_time", "creation_time", "last_update_time") and field[0] == "attributes"
        op = op.upper()
        if numeric != isinstance(expected, float) or (not numeric and op not in ("=", "!=", "LIKE", "ILIKE")) or (numeric and op in ("LIKE", "ILIKE")):
            _bad("Unsupported comparator/value type for search field")
        clauses.append((field, op, expected))
        position = match.end()
        if not expression[position:].strip():
            break
        separator = re.match(r"\s+AND\s+", expression[position:], re.I)
        if not separator:
            _bad("Unsupported filter syntax; only AND is supported")
        position += separator.end()
        if not expression[position:].strip():
            _bad("Incomplete filter after AND")

    def matches(row):
        for field, op, expected in clauses:
            actual = _value(row, field, kind)
            if actual is None:
                return False
            if op in ("LIKE", "ILIKE"):
                pattern = "".join(".*" if c == "%" else "." if c == "_" else re.escape(c) for c in expected)
                good = re.fullmatch(pattern, str(actual), re.I if op == "ILIKE" else 0) is not None
            elif op == "=":
                good = actual == expected
            elif op == "!=":
                good = actual != expected
            elif op == ">":
                good = actual > expected
            elif op == "<":
                good = actual < expected
            elif op == ">=":
                good = actual >= expected
            else:
                good = actual <= expected
            if not good:
                return False
        return True
    return matches


def _view(data, key):
    value = data.get(key, "ACTIVE_ONLY")
    values = {1: "ACTIVE_ONLY", 2: "DELETED_ONLY", 3: "ALL", "1": "ACTIVE_ONLY", "2": "DELETED_ONLY", "3": "ALL"}
    value = values.get(value, value) if isinstance(value, (str, int)) else None
    if value not in ("ACTIVE_ONLY", "DELETED_ONLY", "ALL"):
        _bad("Invalid lifecycle view")
    return value


def _visible(stage, view):
    return view == "ALL" or stage == ("active" if view == "ACTIVE_ONLY" else "deleted")


def _page(rows, data, scope, default=1000):
    size = _integer(data.get("max_results", default), "max_results", 1, 50000)
    fingerprint = hashlib.sha256(json.dumps([scope, {k: v for k, v in data.items() if k != "page_token"}], sort_keys=True).encode()).hexdigest()
    start = 0
    if data.get("page_token"):
        try:
            token = json.loads(base64.urlsafe_b64decode(data["page_token"].encode()))
            if token["query"] != fingerprint or type(token["offset"]) is not int or token["offset"] < 0:
                raise ValueError()
            start = token["offset"]
        except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
            _bad("Invalid or mismatched page token")
    end = start + size
    extra = {}
    if end < len(rows):
        extra["next_page_token"] = base64.urlsafe_b64encode(json.dumps({"query": fingerprint, "offset": end}).encode()).decode()
    return rows[start:end], extra


def _search(ctx, data, kind):
    view = _view(data, "view_type" if kind == "experiment" else "run_view_type")
    predicate = _predicate(data.get("filter", ""), kind)
    orders = data.get("order_by", [])
    if not isinstance(orders, list) or any(not isinstance(o, str) for o in orders):
        _bad("order_by must be an array of strings")
    parsed_orders = []
    for order in orders:
        match = re.fullmatch(rf'\s*({_FIELD})(?:\s+(ASC|DESC))?\s*', order, re.I)
        if not match:
            _bad("Unsupported order_by syntax")
        parsed_orders.append((_field(match[1], kind), (match[2] or "ASC").upper() == "DESC"))
    _default(ctx)
    rows = []
    if kind == "experiment":
        rows = [e for _, e in ctx.state.items(EXP) if _visible(e["lifecycle_stage"], view)]
        rows.sort(key=lambda e: int(e["experiment_id"]))
        if not orders:
            parsed_orders = [(("attributes", "creation_time"), True)]
    else:
        ids = data.get("experiment_ids", [])
        if not isinstance(ids, list) or not ids:
            _bad("experiment_ids must be a nonempty array")
        ids = {str(_integer(e, "experiment_id")) for e in ids}
        for rid, stored in ctx.state.items(RUN):
            if stored["info"]["experiment_id"] in ids:
                with ctx.lock_for("mlflow:run:" + rid):
                    run = _run(ctx, rid)
                    if _visible(run["info"]["lifecycle_stage"], view):
                        rows.append(_run_wire(ctx, run))
        rows.sort(key=lambda r: r["info"]["run_id"])
        if not orders:
            parsed_orders = [(("attributes", "start_time"), True)]
    rows = [row for row in rows if predicate(row)]
    for field, reverse in reversed(parsed_orders):
        present = [r for r in rows if _value(r, field, kind) is not None]
        missing = [r for r in rows if _value(r, field, kind) is None]
        present.sort(key=lambda r: _value(r, field, kind), reverse=reverse)
        rows = present + missing
    rows, extra = _page(rows, data, kind)
    return {("experiments" if kind == "experiment" else "runs"): [_exp_wire(r) for r in rows] if kind == "experiment" else rows, **extra}


_ROUTES = {
    "experiments/create": ("POST", "name artifact_location tags"),
    "experiments/get": ("GET", "experiment_id"),
    "experiments/get-by-name": ("GET", "experiment_name"),
    "experiments/search": ("POST", "max_results page_token filter order_by view_type"),
    "experiments/update": ("POST", "experiment_id new_name"),
    "experiments/delete": ("POST", "experiment_id"),
    "experiments/restore": ("POST", "experiment_id"),
    "experiments/set-experiment-tag": ("POST", "experiment_id key value"),
    "experiments/delete-experiment-tag": ("POST", "experiment_id key"),
    "runs/create": ("POST", "experiment_id user_id run_name start_time tags"),
    "runs/get": ("GET", "run_id run_uuid"),
    "runs/update": ("POST", "run_id run_uuid status end_time run_name"),
    "runs/delete": ("POST", "run_id"),
    "runs/restore": ("POST", "run_id"),
    "runs/search": ("POST", "experiment_ids filter run_view_type max_results order_by page_token"),
    "runs/log-metric": ("POST", "run_id run_uuid key value timestamp step dataset_name dataset_digest model_id"),
    "runs/log-parameter": ("POST", "run_id run_uuid key value"),
    "runs/log-batch": ("POST", "run_id metrics params tags"),
    "runs/set-tag": ("POST", "run_id run_uuid key value"),
    "runs/delete-tag": ("POST", "run_id key"),
    "metrics/get-history": ("GET", "run_id run_uuid metric_key page_token max_results"),
}


def handle(ctx, request):
    """Return None only for paths outside MLflow's protocol namespaces."""
    if request.path.startswith("/api/2.0/mlflow-artifacts"):
        _bad("MLflow artifact storage is not supported", "NOT_IMPLEMENTED", 400)
    if not request.path.startswith(API):
        return None
    route = request.path[len(API):]
    if route == "artifacts" or route.startswith("artifacts/"):
        _bad("MLflow artifact storage is not supported", "NOT_IMPLEMENTED", 400)
    if route == "logged-models" or route.startswith("logged-models/"):
        _bad("MLflow logged models are not supported", "NOT_IMPLEMENTED", 400)
    if route not in _ROUTES:
        _unsupported("Unsupported MLflow route: " + route)
    method, fields = _ROUTES[route]
    if request.method != method:
        _bad("Method not allowed", "INVALID_PARAMETER_VALUE", 405)
    data = dict(request.query) if method == "GET" else request.json()
    if not isinstance(data, dict):
        _bad("Request must be a JSON object")
    _fields(data, fields)
    if route == "experiments/search":
        return Response(body=_search(ctx, data, "experiment"))
    if route == "runs/search":
        return Response(body=_search(ctx, data, "run"))
    if route == "experiments/create":
        name, tags = _key(data.get("name")), _pairs(data.get("tags", []))
        if data.get("artifact_location"):
            _bad("MLflow artifact storage is not supported", "NOT_IMPLEMENTED", 400)
        _default(ctx)
        with ctx.lock_for("mlflow:experiment-name:" + name):
            if any(e["name"] == name for _, e in ctx.state.items(EXP)):
                _bad("Experiment already exists: " + name, "RESOURCE_ALREADY_EXISTS", 409)
            eid = str(ctx.state.next_id("mlflow.experiment_ids", start=1))
            _new_exp(ctx, name, eid, tags)
        return Response(body={"experiment_id": eid})
    if route == "experiments/get-by-name":
        name = _key(data.get("experiment_name"))
        _default(ctx)
        exp = next((e for _, e in ctx.state.items(EXP) if e["name"] == name), None)
        if exp is None:
            _bad("Experiment not found: " + name, "RESOURCE_DOES_NOT_EXIST", 404)
        return Response(body={"experiment": _exp_wire(exp)})
    if route.startswith("experiments/"):
        eid = str(_integer(data.get("experiment_id"), "experiment_id"))
        with ctx.lock_for("mlflow:experiment:" + eid):
            exp = _experiment(ctx, eid)
            if route == "experiments/get":
                return Response(body={"experiment": _exp_wire(exp)})
            if route == "experiments/update":
                _active(exp)
                name = _key(data.get("new_name"))
                with ctx.lock_for("mlflow:experiment-name:" + name):
                    if any(e["name"] == name and other != eid for other, e in ctx.state.items(EXP)):
                        _bad("Experiment name already exists", "RESOURCE_ALREADY_EXISTS", 409)
                    exp["name"] = name
                    exp["last_update_time"] = _now()
                    _save_exp(ctx, exp)
                return Response(body={})
            if route == "experiments/set-experiment-tag":
                _active(exp)
                exp["tags"].update(_pairs([{"key": data.get("key"), "value": data.get("value")}]))
            elif route == "experiments/delete-experiment-tag":
                _active(exp)
                key = _key(data.get("key"))
                if key not in exp["tags"]:
                    _bad("Experiment tag does not exist", "RESOURCE_DOES_NOT_EXIST", 404)
                del exp["tags"][key]
            else:
                stage = "deleted" if route.endswith("delete") else "active"
                if exp["lifecycle_stage"] == stage:
                    _bad("Experiment is already " + stage, "INVALID_STATE")
                exp["lifecycle_stage"] = stage
                exp["lifecycle_epoch"] = exp.get("lifecycle_epoch", 0) + 1
            exp["last_update_time"] = _now()
            _save_exp(ctx, exp)
        return Response(body={})
    if route == "runs/create":
        eid = str(_integer(data.get("experiment_id", "0"), "experiment_id"))
        tags = _pairs(data.get("tags", []))
        rid = uuid.uuid4().hex
        run_name = data.get("run_name") or tags.get("mlflow.runName") or rid
        run_name = _key(run_name)
        if data.get("run_name") and tags.get("mlflow.runName") and data["run_name"] != tags["mlflow.runName"]:
            _bad("run_name and mlflow.runName disagree")
        tags["mlflow.runName"] = run_name
        start_time = _integer(data.get("start_time", _now()), "start_time")
        user_id = _text(data.get("user_id", tags.get("mlflow.user", "")), "user_id", empty=True)
        with ctx.lock_for("mlflow:experiment:" + eid):
            exp = _experiment(ctx, eid)
            _active(exp)
            native = ctx.native.request("POST", "/api/runs", {"experiment_id": exp["native_id"], "name": run_name, "params": {}, "tags": tags})
            run = {"native_id": native["id"], "params": {}, "tags": tags, "metric_keys": [],
                   "metric_index_version": 1, "latest_metrics": {},
                   "experiment_epoch": exp.get("lifecycle_epoch", 0),
                   "info": {"run_id": rid, "run_uuid": rid, "run_name": run_name,
                            "experiment_id": eid, "user_id": user_id, "status": "RUNNING",
                            "start_time": start_time, "lifecycle_stage": "active",
                            "artifact_uri": _ARTIFACT_URI}}
            _save_run(ctx, run)
        return Response(body={"run": _run_wire(ctx, run)})
    rid = _run_id(data)
    with ctx.lock_for("mlflow:run:" + rid):
        run = _run(ctx, rid)
        if route == "runs/get":
            return Response(body={"run": _run_wire(ctx, run)})
        if route == "metrics/get-history":
            key = _key(data.get("metric_key"))
            rows, extra = _page(_history(ctx, run, key), data, "history:" + rid)
            return Response(body={"metrics": rows, **extra})
        if route == "runs/delete":
            run["info"]["lifecycle_stage"] = "deleted"
            _save_run(ctx, run)
            return Response(body={})
        if route == "runs/restore":
            _active(_experiment(ctx, run["info"]["experiment_id"]))
            run["info"]["lifecycle_stage"] = "active"
            _save_run(ctx, run)
            return Response(body={})
        _active(run)
        _active(_experiment(ctx, run["info"]["experiment_id"]))
        if route == "runs/update":
            info, patch, tags = {}, {}, {}
            if "status" in data:
                status = _text(data["status"], "status")
                if status not in STATUS:
                    _bad("Unsupported run status")
                info["status"], patch["status"] = status, STATUS[status]
            if "end_time" in data:
                info["end_time"] = _integer(data["end_time"], "end_time")
            if "run_name" in data:
                info["run_name"] = tags["mlflow.runName"] = _key(data["run_name"])
                patch["tags"] = tags
            _commit(ctx, run, info=info, patch=patch, tags=tags)
            return Response(body={"run_info": run["info"]})
        if route == "runs/delete-tag":
            key = _key(data.get("key"))
            if key not in run["tags"]:
                _bad("Tag does not exist", "RESOURCE_DOES_NOT_EXIST", 404)
            _commit(ctx, run, tags={key: None}, patch={"tags": {key: None}})
            return Response(body={})
        if route == "runs/log-batch":
            _log(ctx, run, data)
        elif route == "runs/log-metric":
            metric = {k: v for k, v in data.items() if k not in ("run_id", "run_uuid")}
            _log(ctx, run, {"metrics": [metric]})
        elif route == "runs/log-parameter":
            _log(ctx, run, {"params": [{"key": data.get("key"), "value": data.get("value")}]})
        elif route == "runs/set-tag":
            _log(ctx, run, {"tags": [{"key": data.get("key"), "value": data.get("value")}]})
        return Response(body={})
