# Server-backed saved views

A server-backed view appears in the ordinary **Saved view** picker alongside local views. Open or share its stable link, `#/views/<encoded id>`; for example, `http://127.0.0.1:8080/#/views/server%3A…`. Renaming or updating the view does not change its link.

Views are shared globally within the server, under its existing token authentication. Anyone with that token can read and update them. The link is **not public access**: recipients must connect with the server token. Never put the token in a URL.

## Editing and following updates

For a server-backed view, **Save changes** publishes your draft, including its name, selected runs, charts, and layout. **Revert to saved** discards your draft and fetches the latest server revision, not just the copy originally opened. **Save view as** makes a local fork; it does not create another server resource or overwrite the shared view.

While the view has no unsaved changes, it follows server updates within a few seconds. Once you edit it, the draft stays local and survives a browser reload; incoming changes do not replace it. If another client publishes first, your stale save is rejected with HTTP `409` and your draft is preserved. Keep it as a local fork, or revert to the latest server version before editing again. There is no automatic merge or force-overwrite step.

## Agent API

Send the existing `Authorization: Bearer <token>` header. JSON writes use `Content-Type: application/json`.

| Request                                                    | Result                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /api/views` with `{workspace: WorkspaceV2}`          | `201` and `{id, revision, workspace}`.                                           |
| `GET /api/views`                                           | `{views: [{id, name, experimentId, revision, updatedAt}]}` summaries.            |
| `GET /api/views/<encoded id>`                              | `{id, revision, workspace}`.                                                     |
| `GET /api/views/<encoded id>?revision=N`                   | `204` with no body when unchanged; otherwise the current envelope.               |
| `PUT /api/views/<encoded id>` with `{revision, workspace}` | Updated `{id, revision, workspace}`, or `409` if the supplied revision is stale. |

Creation generates an ID of the form `server:<uuid>`. The server sets `workspace.updatedAt` in milliseconds and returns the stored workspace with its assigned identity. Use that returned workspace and revision for later updates to the same ID. Encode the entire ID as one URL path segment. On `409`, retain your draft and read the latest version before deciding how to reconcile; do not blindly retry with a newer revision.

`WorkspaceV2` uses the existing saved-view format in [workspace.ts](../web/src/workspace.ts) and [workspace-types.ts](../web/src/workspace-types.ts): `version: 2`, `id`, `name`, `experimentId`, `selectedRunIds`, `sections`, and `updatedAt`. The optional `pendingSelectedRunIds` array preserves selection intent while filter evidence is unresolved; these IDs must not overlap `selectedRunIds`. Sections contain `cards`. Each chart retains its ordinary `kind`, `source`, `config`, `outliers`, and `size` fields; an rx chart additionally has a [RecordBinding](../web/src/records.ts) in `records`. `config: {}` is accepted and filled with defaults by `validateConfig`.

Saved views have no arbitrary count, workspace-byte, or annotation-content quotas. Closed-schema, finite-number, protected-key, source-binding, and request validation remain in force. Colors support named/hex colors and finite numeric RGB/HSL, HWB, Lab/LCH, OKLab/OKLCH, and predefined `color(...)` spaces; missing-channel `none` and dynamic color expressions are not supported. Browser support for individual color spaces can vary.

### Authored chart details and semantic run names

These optional fields extend workspace version 2; old documents remain valid. `workspace.runLabels` maps stable run IDs to view-wide semantic names without renaming runs. Keys and labels must be nonempty after trimming; keys cannot be `__proto__`, `constructor`, or `prototype`. IDs may refer to unavailable or unselected runs, and labels need not be unique. Legends and cursor readouts distinguish same-run metrics and disambiguate colliding names. Switching to original labels is a local presentation preference.

The resizable Chart details pane supports Markdown headings, emphasis, lists, tables, quotations, code, rules, and inline/display LaTeX. Raw HTML, scripts, executable code, remote images, and arbitrary embeds are not supported. HTTP(S) links are allowed; math rendering disables trusted HTML and bounds expansion. Configuration fields are selected by the view author, not inferred or expanded into the full run configuration.

Use `[Inspect interval](measurement:late-training)` to reference a measurement declared on the same chart. Clicking it places native chart cursors and reveals their readout; the chart's own Clear cursors control removes them. Coordinates use displayed axis units: step, timestamp, elapsed time, or metric X for the X axis, and displayed metric units for Y. Cursor positions, pane width, and naming-mode choices do not write back to the shared view. Unknown measurement references and unsupported link destinations are inert.

Each chart may have `details` with these optional members:

- `markdown`: a string, including an empty string. Rendering is inert; saving Markdown does not enable executable content.
- `configFields`: an ordered array of `{ "path": ["optimizer", "lr"], "label": "Learning rate" }`. Paths contain one or more nonblank string segments and resolve only own properties beneath `run.params`. A literal dotted key uses one segment, such as `["optimizer.lr"]`. The three forbidden names above are rejected in every segment; duplicate segment arrays are rejected. An optional label must be nonblank. Missing values are displayed explicitly rather than inferred.
- `measurements`: a map from names matching `^[A-Za-z0-9][A-Za-z0-9_-]*$` to `{ "axis": "x", "a": 500, "b": 1500 }`. The three forbidden names are also rejected here. Axis is `x` or `y`; `a` is required and both coordinates must be finite numbers. Omit `b` or use `null` for a single cursor. Image charts may have an empty map but cannot declare measurements.

Unknown fields and null containers are rejected. Empty details objects, field arrays, and alias maps are valid. Chart reset preserves authored details; JSON import/export and saved-view copies preserve details and aliases. There are no annotation-specific size or count quotas; existing safe-JSON and request validation still apply.

This is a complete `POST /api/views` body, not an annotation-only patch. Replace the experiment/run IDs and metric key with your own references:

```json
{
  "workspace": {
    "version": 2,
    "id": "incoming",
    "name": "Depth comparison",
    "experimentId": "experiment-a",
    "selectedRunIds": ["run-a", "run-b"],
    "runLabels": {
      "run-a": "A · 2 layers",
      "run-b": "B · 4 layers"
    },
    "updatedAt": 0,
    "sections": [
      {
        "id": "results",
        "title": "Results",
        "collapsed": false,
        "cards": [
          {
            "id": "loss",
            "title": "Training loss",
            "kind": "timeseries",
            "source": { "mode": "selected", "keys": ["train/loss"] },
            "config": {},
            "outliers": "all",
            "size": "normal",
            "details": {
              "markdown": "### Depth comparison\n\nCompare $v_2(t)-v_4(t)$. [Inspect](measurement:late-training).",
              "configFields": [
                { "path": ["n_layers"], "label": "Layers" },
                { "path": ["optimizer", "lr"], "label": "Learning rate" }
              ],
              "measurements": {
                "late-training": { "axis": "x", "a": 500, "b": 1500 }
              }
            }
          }
        ]
      }
    ]
  }
}
```

For updates, use the server-returned workspace ID and `{ "revision": N, "workspace": ... }` envelope. Details and aliases participate in the same revision/CAS rules as the rest of the workspace.

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
