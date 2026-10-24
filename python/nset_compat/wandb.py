"""W&B SDK run protocol adapter (stdlib only).

Protocol checked against wandb 0.31.0, core/api/graphql and
core/internal/filestream at upstream 15f8cbc581d1c5cfc6e31f68b48bdd13cec2dd2c.
This is deliberately not a general W&B GraphQL server. Unknown fields fail.
Run files (including image bytes) are preserved, not native image charts.
"""
import copy
import hashlib
import json
import math
import re
import time
from urllib.parse import quote, unquote

from .common import ProtocolError, Response

RUNS = "wandb.runs"
PENDING = "wandb.pending"
PROJECTS = "wandb.projects"
MIGRATING = "wandb.migrating"
SCHEMA = 2
ROW_CHUNK = 512
MAX_SAFE = 9007199254740991


def _error(code, message, status=400):
    raise ProtocolError(status, code, message)


def _json(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _segment(value):
    if not isinstance(value, str) or not value or any(c in value for c in "/\\\x00") or value in (".", ".."):
        _error("INVALID_PARAMETER_VALUE", "Invalid W&B entity, project, or run name")
    return value


def _path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value or any(p in ("", ".", "..") for p in value.split("/")):
        _error("INVALID_PARAMETER_VALUE", "Invalid W&B file path")
    return value


def _identity(entity, project, name):
    return _digest(_json([_segment(entity), _segment(project), _segment(name)]))


class _Document:
    """Small strict parser for the SDK's GraphQL subset; never regex-dispatch mutations."""
    token = re.compile(r'\s+|\#[^\n]*|(?:"(?:\\.|[^"\\])*")|\.\.\.|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|[$!():=@\[\]{},]')

    def __init__(self, text, variables):
        if not isinstance(text, str) or len(text) > 262144:
            _error("UNSUPPORTED_GRAPHQL", "Missing or oversized GraphQL document")
        self.tokens = []
        pos = 0
        for m in self.token.finditer(text):
            if m.start() != pos:
                _error("UNSUPPORTED_GRAPHQL", "Unsupported GraphQL syntax")
            pos = m.end()
            if not m[0].isspace() and not m[0].startswith("#") and m[0] != ",":
                self.tokens.append(m[0])
        if pos != len(text):
            _error("UNSUPPORTED_GRAPHQL", "Unsupported GraphQL syntax")
        self.i, self.variables = 0, variables

    def pop(self, expected=None):
        if self.i >= len(self.tokens):
            _error("UNSUPPORTED_GRAPHQL", "Incomplete GraphQL document")
        token = self.tokens[self.i]
        self.i += 1
        if expected is not None and token != expected:
            _error("UNSUPPORTED_GRAPHQL", "Unsupported GraphQL syntax")
        return token

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def value(self):
        t = self.pop()
        if t == "$":
            return self.variables.get(self.pop())
        if t == "{":
            result = {}
            while self.peek() != "}":
                k = self.pop()
                self.pop(":")
                result[k] = self.value()
            self.pop("}")
            return result
        if t == "[":
            result = []
            while self.peek() != "]":
                result.append(self.value())
            self.pop("]")
            return result
        if t.startswith('"') or t in ("true", "false", "null") or re.match(r"^-?\d", t):
            return json.loads(t)
        return t

    def selection(self):
        self.pop("{")
        fields = []
        while self.peek() != "}":
            name = alias = self.pop()
            if name == "...":
                _error("UNSUPPORTED_GRAPHQL", "GraphQL fragments are not supported")
            if self.peek() == ":":
                self.pop(":")
                name = self.pop()
            args = {}
            if self.peek() == "(":
                self.pop("(")
                while self.peek() != ")":
                    key = self.pop()
                    self.pop(":")
                    args[key] = self.value()
                self.pop(")")
            include = True
            while self.peek() == "@":
                self.pop("@")
                directive = self.pop()
                if directive not in ("include", "skip"):
                    _error("UNSUPPORTED_GRAPHQL", "Unsupported GraphQL directive")
                self.pop("(")
                self.pop("if")
                self.pop(":")
                condition = self.value()
                self.pop(")")
                include &= bool(condition) if directive == "include" else not bool(condition)
            sub = self.selection() if self.peek() == "{" else []
            if include:
                fields.append((alias, name, args, sub))
        self.pop("}")
        return fields

    def parse(self):
        if self.peek() != "{":
            if self.pop() not in ("query", "mutation"):
                _error("UNSUPPORTED_GRAPHQL", "Only query and mutation are supported")
            if self.peek() not in ("(", "{"):
                self.pop()  # operation name
            if self.peek() == "(":
                depth = 0
                while True:
                    t = self.pop()
                    depth += (t == "(") - (t == ")")
                    if depth == 0:
                        break
        result = self.selection()
        if self.peek() is not None:
            _error("UNSUPPORTED_GRAPHQL", "Only one GraphQL operation is supported")
        return result


def _select(value, selection):
    if not selection or value is None:
        return value
    if isinstance(value, list):
        return [_select(v, selection) for v in value]
    if not isinstance(value, dict):
        _error("UNSUPPORTED_GRAPHQL", "Selection on scalar field")
    result = {}
    for alias, name, args, sub in selection:
        if name not in value:
            _error("UNSUPPORTED_GRAPHQL", "Unsupported GraphQL field: " + name)
        result[alias] = _select(value[name], sub)
    return result


def _project(ctx, entity, project):
    key = _digest(_json([_segment(entity), _segment(project)]))
    with ctx.lock_for("wandb.project." + key):
        record = ctx.state.get(PROJECTS, key)
        if record is None:
            native = ctx.native.request("POST", "/api/experiments", {"name": "wandb/" + entity + "/" + project})
            record = {"id": native["id"], "name": project, "entity": {"id": entity, "name": entity}}
            ctx.state.put(PROJECTS, key, record)
        return record


def _load(ctx, key):
    run = ctx.state.get(RUNS, key)
    if run is None:
        _error("NOT_FOUND", "W&B run does not exist", 404)
    return _migrate(ctx, key, run)


def _namespace(key):
    return "wandb.files." + key


def _rows_namespace(key, name):
    return "wandb.rows." + key + "." + _digest(name)


def _metric_namespace(key):
    return "wandb.metrics." + key


def _stream_meta(lines, name):
    return {"count": len(lines), "bytes": sum(len(line.encode()) + 1 for line in lines),
            "tail": lines[-1:] if name in ("wandb-history.jsonl", "wandb-events.jsonl", "wandb-summary.json") else []}


def _migrate(ctx, key, run):
    """One-time replayable conversion, always called under the run lock.

    The full legacy document is journaled before index writes. A crash after
    any index or metadata commit simply repeats the same deterministic writes.
    No native metrics are submitted by migration.
    """
    legacy = ctx.state.get(MIGRATING, key)
    if legacy is None:
        if run.get("schema") == SCHEMA:
            return run
        if run.get("schema") not in (None, 1):
            _error("UNSUPPORTED_SCHEMA", "Unsupported W&B run storage schema", 409)
        legacy = run
        ctx.state.put(MIGRATING, key, legacy)
    converted = {k: v for k, v in legacy.items() if k not in ("streams", "metric_seen")}
    converted.update(schema=SCHEMA, streams={})
    for name, lines in legacy.get("streams", {}).items():
        if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
            _error("UNSUPPORTED_SCHEMA", "Invalid legacy W&B stream", 409)
        for start in range(0, len(lines), ROW_CHUNK):
            chunk = lines[start:start + ROW_CHUNK]
            ctx.state.put_many(_rows_namespace(key, name), {str(i): line for i, line in enumerate(chunk, start)})
            identities = {}
            if name in ("wandb-history.jsonl", "wandb-events.jsonl"):
                for i, line in enumerate(chunk, start):
                    identities.update({batch: True for batch, _ in _projection(key, name, line, i, legacy)})
            ctx.state.put_many(_metric_namespace(key), identities)
        converted["streams"][name] = _stream_meta(lines, name)
    ctx.state.put(RUNS, key, converted)
    ctx.state.delete(MIGRATING, key)
    return converted


def _bucket(run):
    streams = run.get("streams", {})
    history = streams.get("wandb-history.jsonl", {})
    events = streams.get("wandb-events.jsonl", {})
    # Go resume.processHistory expects a JSON-encoded array of JSON lines.
    return {"id": run["native_id"], "name": run["name"], "displayName": run.get("displayName") or run["name"],
            "description": run.get("description", ""), "notes": run.get("notes", ""),
            "config": run.get("config", "{}"), "summaryMetrics": run.get("summaryMetrics", "{}"),
            "systemMetrics": next(iter(events.get("tail", [])), "{}"), "sweepName": None,
            "project": run["project_record"], "historyLineCount": history.get("count", 0),
            "eventsLineCount": events.get("count", 0), "logLineCount": streams.get("output.log", {}).get("count", 0),
            "historyTail": _json(history.get("tail", [])), "eventsTail": _json(events.get("tail", [])),
            "tags": run.get("tags", []), "wandbConfig": _json({"t": 1}) if run.get("started") else "{}",
            "state": run.get("state", "running"), "stopped": False}


def _finish_pending(ctx, key):
    pending = ctx.state.get(PENDING, key)
    if not pending:
        return
    if pending.get("schema") not in (None, SCHEMA):
        _error("UNSUPPORTED_SCHEMA", "Unsupported W&B pending schema", 409)
    run = pending["run"]
    # The intent is immutable until cleared. Replay every stage after a crash;
    # native batch IDs and bulk row/identity upserts are idempotent, even when
    # the previous attempt committed but its acknowledgement was lost.
    for batch_id, metrics in pending["batches"]:
        ctx.ingest_metrics(run["native_id"], batch_id, metrics, wait=True)
    if pending.get("complete"):
        ctx.native.request("PATCH", "/api/runs/" + quote(run["native_id"], safe=""), {"status": run["state"]})
    if pending.get("schema") is None:
        # Legacy pending intents already contain their proposed full run.
        _migrate(ctx, key, run)
    elif pending["schema"] == SCHEMA:
        for name, rows in pending["rows"].items():
            ctx.state.put_many(_rows_namespace(key, name), rows)
        ctx.state.put_many(_metric_namespace(key), {batch: True for batch, _ in pending["batches"]})
        ctx.state.put(RUNS, key, run)
    ctx.state.delete(PENDING, key)


def _download_stream(ctx, key, run, name):
    meta = run["streams"][name]
    if meta["bytes"] > getattr(ctx, "max_body_bytes", 32 * 1024 * 1024):
        _error("RESPONSE_TOO_LARGE", "W&B stream exceeds configured download limit", 413)
    chunks = []
    for start in range(0, meta["count"], ROW_CHUNK):
        keys = [str(i) for i in range(start, min(start + ROW_CHUNK, meta["count"]))]
        rows = ctx.state.get_many(_rows_namespace(key, name), keys)
        if any(k not in rows for k in keys):
            _error("CORRUPT_STREAM", "Committed W&B stream row missing", 500)
        chunks.extend((rows[k] + "\n").encode() for k in keys)
    return b"".join(chunks), "application/json" if name.endswith(".json") else "text/plain"


def _upsert(ctx, values):
    entity = values.get("entityName") or "nset"
    project = values.get("modelName") or "uncategorized"
    name = values.get("name")
    if not name and values.get("id"):
        matches = [r for _, r in ctx.state.items(RUNS) if r["native_id"] == values["id"]]
        if len(matches) == 1:
            entity, project, name = matches[0]["entity"], matches[0]["project"], matches[0]["name"]
    key = _identity(entity, project, name)
    with ctx.lock_for("wandb.run." + key):
        _finish_pending(ctx, key)
        run = ctx.state.get(RUNS, key)
        inserted = run is None
        if not inserted:
            run = _migrate(ctx, key, run)
        if inserted:
            project_record = _project(ctx, entity, project)
            tags = {"compat": "wandb", "wandb.entity": entity, "wandb.project": project, "wandb.run_id": name}
            # Native creation has no idempotency key. Recover the committed run
            # by its protocol identity after a lost response/before state commit.
            candidates = ctx.native.request("GET", "/api/runs", query={"experiment_id": project_record["id"]})
            recovered = [r for r in candidates["runs"] if all(r.get("tags", {}).get(k) == v for k, v in tags.items())]
            if len(recovered) > 1:
                _error("RESOURCE_CONFLICT", "Ambiguous native W&B run identity", 409)
            native = recovered[0] if recovered else ctx.native.request("POST", "/api/runs", {
                "experiment_id": project_record["id"], "name": values.get("displayName") or name,
                "params": {}, "tags": tags})
            run = {"native_id": native["id"], "name": name, "entity": entity, "project": project,
                   "project_record": project_record, "schema": SCHEMA, "streams": {}, "created_ms": int(time.time() * 1000)}
        run = copy.deepcopy(run)
        for field in ("displayName", "description", "notes", "tags", "config", "summaryMetrics", "state"):
            if values.get(field) is not None:
                value = values[field]
                if field in ("config", "summaryMetrics"):
                    try:
                        decoded = json.loads(value)
                        previous = json.loads(run.get(field, "{}"))
                        if not isinstance(decoded, dict) or not isinstance(previous, dict):
                            raise ValueError()
                        previous.update(decoded)
                        value = _json(previous)
                    except (TypeError, ValueError):
                        _error("INVALID_PARAMETER_VALUE", "Expected JSON object for " + field)
                run[field] = value
        # Preserve every accepted metadata mutation, not just known native fields.
        ctx.artifacts.put("wandb.requests." + key, "upsert/" + _digest(_json(values)) + ".json", _json(values).encode(), "application/json")
        run["started"] = True
        ctx.state.put(RUNS, key, run)
        return {"bucket": _bucket(run), "inserted": inserted}


def _url(ctx, key, name):
    return ctx.signed_url("/compat/files/wandb/" + key + "/" + quote(_path(name), safe="/"))


def _gql(ctx, request):
    data = request.json()
    variables = data.get("variables") or {}
    if not isinstance(variables, dict):
        _error("INVALID_PARAMETER_VALUE", "GraphQL variables must be an object")
    selection = _Document(data.get("query"), variables).parse()
    allowed = {"viewer", "serverInfo", "__type", "upsertBucket", "upsertModel", "upsertProject", "model", "project", "createRunFiles", "markRunFilesUploaded"}
    if any(name not in allowed for _, name, _, _ in selection):
        _error("UNSUPPORTED_GRAPHQL", "Unsupported GraphQL operation")
    result = {}
    for alias, name, args, sub in selection:
        if name == "viewer":
            value = {"id": "nset", "entity": "nset", "username": "nset", "email": None,
                     "flags": "{}", "teams": {"edges": []}}
        elif name == "serverInfo":
            value = {"features": [], "cliVersionInfo": {}, "latestLocalVersionInfo": None}
        elif name == "__type":
            # Honest minimal schema: no optional capabilities are advertised.
            fields = {"Query": ["viewer", "serverInfo", "project", "model"],
                      "Mutation": ["upsertBucket", "createRunFiles", "upsertModel"],
                      "ServerInfo": ["features", "cliVersionInfo"],
                      "Run": list(_bucket_fields())}.get(args.get("name"))
            value = None if fields is None else {"name": args["name"], "kind": "OBJECT", "fields": [{"name": f} for f in fields], "inputFields": []}
        elif name == "upsertBucket":
            value = _upsert(ctx, args.get("input") or {})
        elif name in ("upsertModel", "upsertProject"):
            v = args.get("input") or {}
            record = _project(ctx, v.get("entityName") or "nset", v.get("name") or "uncategorized")
            value = {"project": record, "model": record}
        elif name in ("project", "model"):
            entity, project = args.get("entityName") or "nset", args.get("name") or "uncategorized"
            record = _project(ctx, entity, project)
            value = dict(record)
            for nested_alias, field, field_args, children in sub:
                if field in ("run", "bucket"):
                    key = _identity(entity, project, field_args.get("name"))
                    with ctx.lock_for("wandb.run." + key):
                        _finish_pending(ctx, key)
                        run = ctx.state.get(RUNS, key)
                        bucket = _bucket(_migrate(ctx, key, run)) if run else None
                        if bucket is not None:
                            for _, child, child_args, _ in children:
                                if child == "files":
                                    names = child_args.get("names") or []
                                    bucket["files"] = {"edges": [{"node": {"name": n, "url": _url(ctx, key, n), "directUrl": _url(ctx, key, n)}} for n in names]}
                        value[field] = bucket
        elif name in ("createRunFiles", "markRunFilesUploaded"):
            v = args.get("input") or {}
            key = _identity(v.get("entityName") or "nset", v.get("projectName"), v.get("runName"))
            with ctx.lock_for("wandb.run." + key):
                run = _load(ctx, key)
                files = v.get("files")
                if not isinstance(files, list):
                    _error("INVALID_PARAMETER_VALUE", "files must be a list")
                for f in files:
                    _path(f)
                if name == "markRunFilesUploaded":
                    for f in files:
                        ctx.artifacts.get(_namespace(key), f)
                    value = {"success": True}
                else:
                    value = {"runID": run["native_id"],
                             # Same-origin upload credentials are supported by
                             # the official SDK. HMAC-only PUT authorization is
                             # not available in every gateway deployment.
                             "uploadHeaders": ["Authorization: Bearer " + ctx.token],
                             "files": [{"name": f, "uploadUrl": _url(ctx, key, f)} for f in files]}
        result[alias] = _select(value, sub)
    return Response(body={"data": result})


def _bucket_fields():
    return ("id", "name", "displayName", "config", "summaryMetrics", "historyLineCount", "eventsLineCount", "logLineCount", "historyTail", "eventsTail", "tags", "notes", "wandbConfig", "state", "stopped")


def _numeric(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _metrics(line, offset, name, run):
    try:
        row = json.loads(line)
    except (ValueError, TypeError):
        return []
    if not isinstance(row, dict):
        return []
    step = row.get("_step", offset)
    if not _numeric(step) or step < 0 or step > MAX_SAFE or int(step) != step:
        return []  # unrepresentable rows are retained verbatim in artifacts
    ts = row.get("_timestamp")
    timestamp = int(ts * 1000) if _numeric(ts) and 0 <= ts <= MAX_SAFE / 1000 else run["created_ms"]
    prefix = "system/" if name == "wandb-events.jsonl" else ""
    return [{"key": prefix + k, "step": int(step), "value": v, "timestamp": timestamp}
            for k, v in sorted(row.items()) if not k.startswith("_") and k and len((prefix + k).encode()) <= 512 and _numeric(v)]


def _projection(key, name, line, offset, run):
    rows = _metrics(line, offset, name, run)
    identity = "offset:" + str(offset)
    if rows:
        source = json.loads(line)
        if "_step" in source and "_timestamp" in source:
            # Preserve full source timestamp, not the rounded native millisecond.
            identity = "observation:" + _digest(_json([source["_step"], source["_timestamp"], rows]))
    return [("wb-" + _digest(key + ":" + name + ":" + identity + ":" + str(chunk)), rows[chunk:chunk + 10000])
            for chunk in range(0, len(rows), 10000)]


def _stream(ctx, request, entity, project, name):
    key = _identity(entity, project, name)
    if len(request.body) > getattr(ctx, "max_body_bytes", 32 * 1024 * 1024):
        _error("REQUEST_TOO_LARGE", "W&B request exceeds configured limit", 413)
    payload = request.json()
    with ctx.lock_for("wandb.run." + key):
        _finish_pending(ctx, key)
        run = copy.deepcopy(_load(ctx, key))
        files = payload.get("files", {})
        if not isinstance(files, dict):
            _error("INVALID_PARAMETER_VALUE", "filestream files must be an object")
        candidates, changes = {}, {}
        for filename, content in files.items():
            _path(filename)
            if not isinstance(content, dict):
                _error("INVALID_PARAMETER_VALUE", "Invalid filestream chunk")
            offset, lines = content.get("offset"), content.get("content")
            if type(offset) is not int or offset < 0 or not isinstance(lines, list) or not all(isinstance(v, str) for v in lines):
                _error("INVALID_PARAMETER_VALUE", "Expected nonnegative offset and string lines")
            meta = run["streams"].setdefault(filename, _stream_meta([], filename))
            count = meta["count"]
            mutable = filename in ("wandb-summary.json", "output.log")
            if offset > count:
                _error("OFFSET_GAP", "Filestream offset skips uncommitted records", 409)
            keys = [str(i) for i in range(offset, min(count, offset + len(lines)))]
            old = ctx.state.get_many(_rows_namespace(key, filename), keys)
            if any(k not in old for k in keys):
                _error("CORRUPT_STREAM", "Committed W&B stream row missing", 500)
            changed = {}
            for i, line in enumerate(lines, offset):
                if i < count:
                    if old[str(i)] != line and not mutable:
                        _error("OFFSET_CONFLICT", "Filestream offset already contains different data", 409)
                    if old[str(i)] == line:
                        continue
                    meta["bytes"] -= len(old[str(i)].encode()) + 1
                changed[str(i)] = line
                meta["bytes"] += len(line.encode()) + 1
                if filename in ("wandb-history.jsonl", "wandb-events.jsonl"):
                    candidates.update(_projection(key, filename, line, i, run))
            meta["count"] = max(count, offset + len(lines))
            if filename in ("wandb-history.jsonl", "wandb-events.jsonl", "wandb-summary.json") and lines and offset + len(lines) == meta["count"]:
                meta["tail"] = lines[-1:]
            if changed:
                changes[filename] = changed
            if filename == "wandb-summary.json" and meta["tail"]:
                try:
                    if isinstance(json.loads(meta["tail"][-1]), dict):
                        run["summaryMetrics"] = meta["tail"][-1]
                except ValueError:
                    pass
        seen = ctx.state.get_many(_metric_namespace(key), list(candidates))
        batches = [(batch, rows) for batch, rows in candidates.items() if batch not in seen]
        # Match Transport encoding; reject deterministic oversize before journaling.
        # The limit is per native request, never cumulative stream size.
        if any(len(json.dumps({"metrics": rows}).encode()) > getattr(ctx, "max_body_bytes", 32 * 1024 * 1024)
               for _, rows in batches):
            _error("REQUEST_TOO_LARGE", "Projected W&B metric request exceeds configured limit", 413)
        uploaded = payload.get("uploaded", [])
        if not isinstance(uploaded, list):
            _error("INVALID_PARAMETER_VALUE", "uploaded must be a list")
        for filename in uploaded:
            ctx.artifacts.get(_namespace(key), _path(filename))
        complete = payload.get("complete", False)
        if type(complete) is not bool or ("exitcode" in payload and type(payload["exitcode"]) is not int):
            _error("INVALID_PARAMETER_VALUE", "Invalid filestream completion")
        if complete:
            run["state"] = "finished" if payload.get("exitcode", 0) == 0 else "failed"
            run["exitcode"] = payload.get("exitcode", 0)
        run["started"] = True
        # Per-request envelopes retain raw data and every mutable offset revision.
        # They are never rebuilt from historical rows.
        ctx.artifacts.put("wandb.requests." + key, "filestream/" + hashlib.sha256(request.body).hexdigest() + ".json", request.body, "application/json")
        ctx.state.put(PENDING, key, {"schema": SCHEMA, "run": run, "batches": batches, "rows": changes, "complete": complete})
        _finish_pending(ctx, key)
        return Response(body={"exitcode": run.get("exitcode"), "limits": {}})


def handle(ctx, request):
    """Route W&B requests; authentication and body bounds belong to gateway."""
    if request.path.rstrip("/") == "/graphql":
        if request.method != "POST":
            return Response(405, {"errors": [{"message": "GraphQL requires POST"}]})
        try:
            return _gql(ctx, request)
        except ProtocolError as exc:
            return Response(exc.status, {"errors": [{"message": exc.message, "extensions": {"code": exc.code}}]})
    match = re.fullmatch(r"/files/([^/]+)/([^/]+)/([^/]+)/file_stream/?", request.path)
    if match:
        if request.method != "POST":
            _error("METHOD_NOT_ALLOWED", "Filestream requires POST", 405)
        return _stream(ctx, request, *(unquote(p) for p in match.groups()))
    prefix = "/compat/files/wandb/"
    if request.path.startswith(prefix):
        parts = request.path[len(prefix):].split("/", 1)
        if len(parts) != 2 or not re.fullmatch(r"[0-9a-f]{64}", parts[0]):
            _error("NOT_FOUND", "Invalid W&B file URL", 404)
        key, filename = parts[0], _path(unquote(parts[1]))
        with ctx.lock_for("wandb.run." + key):
            _finish_pending(ctx, key)
            run = _load(ctx, key)
            if request.method == "PUT":
                if len(request.body) > getattr(ctx, "max_body_bytes", 32 * 1024 * 1024):
                    _error("REQUEST_TOO_LARGE", "W&B upload exceeds configured limit", 413)
                # Preserve overwritten upload revisions too.
                revision = _digest(filename) + "/" + hashlib.sha256(request.body).hexdigest()
                content_type = request.headers.get("content-type", "application/octet-stream")
                ctx.artifacts.put("wandb.revisions." + key, revision, request.body, content_type)
                ctx.artifacts.put(_namespace(key), filename, request.body, content_type)
                return Response(body={})
            if request.method in ("GET", "HEAD"):
                body, content_type = (_download_stream(ctx, key, run, filename) if filename in run["streams"]
                                      else ctx.artifacts.get(_namespace(key), filename))
                return Response(body=body if request.method == "GET" else b"", headers={"Content-Type": content_type})
            _error("METHOD_NOT_ALLOWED", "Run files require PUT or GET", 405)
    return None
