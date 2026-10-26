# Server-backed saved views

A server-backed view appears in the ordinary **Saved view** picker alongside local views. Open or share its stable link, `#/views/<encoded id>`; for example, `http://127.0.0.1:8080/#/views/server%3A…`. Renaming or updating the view does not change its link.

Views are shared globally within the server, under its existing token authentication. Anyone with that token can read and update them. The link is **not public access**: recipients must connect with the server token. Never put the token in a URL.

## Editing and following updates

For a server-backed view, **Save changes** publishes your draft, including its name, selected runs, charts, and layout. **Revert to saved** discards your draft and fetches the latest server revision, not just the copy originally opened. **Save view as** makes a local fork; it does not create another server resource or overwrite the shared view.

While the view has no unsaved changes, it follows server updates within a few seconds. Once you edit it, the draft stays local and survives a browser reload; incoming changes do not replace it. If another client publishes first, your stale save is rejected with HTTP `409` and your draft is preserved. Keep it as a local fork, or revert to the latest server version before editing again. There is no automatic merge or force-overwrite step.

## Agent API

Send the existing `Authorization: Bearer <token>` header. JSON writes use `Content-Type: application/json`.

| Request | Result |
| --- | --- |
| `POST /api/views` with `{workspace: WorkspaceV2}` | `201` and `{id, revision, workspace}`. |
| `GET /api/views` | `{views: [{id, name, experimentId, revision, updatedAt}]}` summaries. |
| `GET /api/views/<encoded id>` | `{id, revision, workspace}`. |
| `GET /api/views/<encoded id>?revision=N` | `204` with no body when unchanged; otherwise the current envelope. |
| `PUT /api/views/<encoded id>` with `{revision, workspace}` | Updated `{id, revision, workspace}`, or `409` if the supplied revision is stale. |

Creation generates an ID of the form `server:<uuid>`. The server sets `workspace.updatedAt` in milliseconds and returns the stored workspace with its assigned identity. Use that returned workspace and revision for later updates to the same ID. Encode the entire ID as one URL path segment. On `409`, retain your draft and read the latest version before deciding how to reconcile; do not blindly retry with a newer revision.

`WorkspaceV2` uses the existing saved-view format in [workspace.ts](../web/src/workspace.ts) and [workspace-types.ts](../web/src/workspace-types.ts): `version: 2`, `id`, `name`, `experimentId`, `selectedRunIds`, `sections`, and `updatedAt`. Sections contain `cards`. Each chart retains its ordinary `kind`, `source`, `config`, `outliers`, and `size` fields; an rx chart additionally has a [RecordBinding](../web/src/records.ts) in `records`. `config: {}` is accepted and filled with defaults by `validateConfig`.

The server stores at most 128 views and validates each workspace against the saved-view safety limits, including a 256 KiB JSON budget. Numeric byte accounting is conservative near that limit. Colors support named/hex colors and finite numeric RGB/HSL, HWB, Lab/LCH, OKLab/OKLCH, and predefined `color(...)` spaces; missing-channel `none` and dynamic color expressions are not supported. Browser support for individual color spaces can vary.

### Python example: an rx view, then an update

First attach a repository with `--rx-repo` as described in the [README](../README.md#read-local-rx-records). `GET /api/rx/catalog` provides `source.id` and a page of runs with `run_uid` fields. Choose the run UIDs yourself; the views API does not automatically select rx experiments or runs. This example expects records with numeric `epoch` and `loss` fields.

Save this as `publish_view.py`, set `NSET_TOKEN`, and run `python publish_view.py RUN_UID [RUN_UID ...]`. It uses only the Python standard library; `NSET_URL` optionally overrides the loopback server URL.

```python
import json
import os
import sys
from urllib.parse import quote
from urllib.request import Request, urlopen

base = os.environ.get("NSET_URL", "http://127.0.0.1:8080").rstrip("/")
token = os.environ["NSET_TOKEN"]


def api(method, path, body=None):
    request = Request(
        base + "/api" + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"},
        method=method,
    )
    with urlopen(request, timeout=30) as response:
        return None if response.status == 204 else json.load(response)


run_uids = list(dict.fromkeys(sys.argv[1:]))
if not run_uids:
    raise SystemExit("Pass one or more rx run UIDs from /api/rx/catalog")
source = api("GET", "/rx/catalog")["source"]["id"]
workspace = {
    "version": 2, "id": "incoming", "name": "rx loss",
    "experimentId": source,
    "selectedRunIds": [f"{source}:{uid}" for uid in run_uids],
    "updatedAt": 0,
    "sections": [{
        "id": "results", "title": "Results", "collapsed": False,
        "cards": [{
            "id": "loss", "title": "Loss by epoch", "kind": "timeseries",
            "source": {"mode": "selected", "keys": []},
            "config": {}, "outliers": "all", "size": "normal",
            "records": {
                "sourceId": source, "runUids": run_uids,
                "x": "epoch", "ys": ["loss"],
                "filters": {"any": False, "conditions": []},
            },
        }],
    }],
}
saved = api("POST", "/views", {"workspace": workspace})
path = "/views/" + quote(saved["id"], safe="")
print(base + "/#/views/" + quote(saved["id"], safe=""))

# Update the same resource, retaining its server-assigned identity.
workspace = saved["workspace"]
workspace["name"] = "rx loss — reviewed"
saved = api("PUT", path, {"revision": saved["revision"],
                          "workspace": workspace})
```

`records.runUids` contains portable rx UIDs, whereas `selectedRunIds` contains UI run IDs (`<source.id>:<run_uid>`). An empty `records.runUids` follows the workspace's selected rx runs instead. The example pins its chart to explicit UIDs. A failed PUT raises `urllib.error.HTTPError`; this example does not retry stale updates.
