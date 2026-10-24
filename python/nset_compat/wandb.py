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
    return run


def _namespace(key):
    return "wandb.files." + key


def _bucket(run):
    streams = run.get("streams", {})
    history = streams.get("wandb-history.jsonl", [])
    events = streams.get("wandb-events.jsonl", [])
    # Go resume.processHistory expects a JSON-encoded array of JSON lines.
    return {"id": run["native_id"], "name": run["name"], "displayName": run.get("displayName") or run["name"],
            "description": run.get("description", ""), "notes": run.get("notes", ""),
            "config": run.get("config", "{}"), "summaryMetrics": run.get("summaryMetrics", "{}"),
            "systemMetrics": events[-1] if events else "{}", "sweepName": None,
            "project": run["project_record"], "historyLineCount": len(history),
            "eventsLineCount": len(events), "logLineCount": len(streams.get("output.log", [])),
            "historyTail": _json(history[-1:]), "eventsTail": _json(events[-1:]),
            "tags": run.get("tags", []), "wandbConfig": _json({"t": 1}) if run.get("started") else "{}",
            "state": run.get("state", "running"), "stopped": False}


def _finish_pending(ctx, key):
    pending = ctx.state.get(PENDING, key)
    if not pending:
        return
    run = pending["run"]
    for batch_id, metrics in pending["batches"]:
        ctx.ingest_metrics(run["native_id"], batch_id, metrics, wait=True)
    for name in pending["files"]:
        ctx.artifacts.put(_namespace(key), name, ("\n".join(run["streams"][name]) + "\n").encode(),
                          "application/json" if name.endswith(".json") else "text/plain")
    if pending.get("complete"):
        ctx.native.request("PATCH", "/api/runs/" + quote(run["native_id"], safe=""), {"status": run["state"]})
    ctx.state.put(RUNS, key, run)
    ctx.state.delete(PENDING, key)


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
                   "project_record": project_record, "streams": {}, "created_ms": int(time.time() * 1000)}
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
                        bucket = _bucket(run) if run else None
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


def _stream(ctx, request, entity, project, name):
    key = _identity(entity, project, name)
    payload = request.json()
    with ctx.lock_for("wandb.run." + key):
        _finish_pending(ctx, key)
        run = copy.deepcopy(_load(ctx, key))
        files = payload.get("files", {})
        if not isinstance(files, dict):
            _error("INVALID_PARAMETER_VALUE", "filestream files must be an object")
        batches = []
        for filename, content in files.items():
            _path(filename)
            if not isinstance(content, dict):
                _error("INVALID_PARAMETER_VALUE", "Invalid filestream chunk")
            offset, lines = content.get("offset"), content.get("content")
            if type(offset) is not int or offset < 0 or not isinstance(lines, list) or not all(isinstance(v, str) for v in lines):
                _error("INVALID_PARAMETER_VALUE", "Expected nonnegative offset and string lines")
            old = run["streams"].setdefault(filename, [])
            mutable = filename in ("wandb-summary.json", "output.log")
            if offset > len(old):
                _error("OFFSET_GAP", "Filestream offset skips uncommitted records", 409)
            for i, line in enumerate(lines, offset):
                if i < len(old):
                    if old[i] != line and not mutable:
                        _error("OFFSET_CONFLICT", "Filestream offset already contains different data", 409)
                    if not mutable:
                        continue
                    old[i] = line
                else:
                    old.append(line)
                if filename in ("wandb-history.jsonl", "wandb-events.jsonl"):
                    rows = _metrics(line, i, filename, run)
                    identity = "offset:" + str(i)
                    if rows:
                        source = json.loads(line)
                        if "_step" in source and "_timestamp" in source:
                            # `wandb sync --include-synced` advances transport
                            # offsets while replaying identical observations.
                            # Retain both raw rows, but bind projection identity
                            # to explicit step/time and canonical numeric data.
                            identity = "observation:" + _digest(_json([source["_step"], source["_timestamp"], rows]))
                    for chunk in range(0, len(rows), 10000):
                        batch_id = "wb-" + _digest(key + ":" + filename + ":" + identity + ":" + str(chunk))
                        batches.append((batch_id, rows[chunk:chunk + 10000]))
            if filename == "wandb-summary.json" and old:
                # Raw malformed/non-object summary still survives in the stream artifact.
                try:
                    if isinstance(json.loads(old[-1]), dict):
                        run["summaryMetrics"] = old[-1]
                except ValueError:
                    pass
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
        # Check the materialized-file bound before installing a pending journal;
        # an oversized request must not permanently block the previous valid run.
        limit = getattr(ctx, "max_body_bytes", 32 * 1024 * 1024)
        if any(sum(len(line.encode()) + 1 for line in run["streams"][f]) > limit for f in files):
            _error("REQUEST_TOO_LARGE", "Materialized W&B stream exceeds configured file limit", 413)
        # Immutable source envelopes retain ALL fields and revisions, including
        # arbitrary nonnumeric JSON, malformed lines, heartbeats and completion.
        ctx.artifacts.put("wandb.requests." + key, "filestream/" + hashlib.sha256(request.body).hexdigest() + ".json", request.body, "application/json")
        ctx.state.put(PENDING, key, {"run": run, "batches": batches, "files": list(files), "complete": complete})
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
            _load(ctx, key)
            if request.method == "PUT":
                # Preserve overwritten upload revisions too.
                revision = _digest(filename) + "/" + hashlib.sha256(request.body).hexdigest()
                content_type = request.headers.get("content-type", "application/octet-stream")
                ctx.artifacts.put("wandb.revisions." + key, revision, request.body, content_type)
                ctx.artifacts.put(_namespace(key), filename, request.body, content_type)
                return Response(body={})
            if request.method in ("GET", "HEAD"):
                body, content_type = ctx.artifacts.get(_namespace(key), filename)
                return Response(body=body if request.method == "GET" else b"", headers={"Content-Type": content_type})
            _error("METHOD_NOT_ALLOWED", "Run files require PUT or GET", 405)
    return None
