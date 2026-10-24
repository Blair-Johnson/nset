# Not Shitty Experiment Tracker

```sh
nset serve --host 127.0.0.1 --port 8080 --token '<YOUR_LONG_RANDOM_TOKEN>' --db-path ./nset-data
```

Run this with an already-built `nset` on your PATH, replacing `<YOUR_LONG_RANDOM_TOKEN>` with a private, randomly generated secret. Use at least 40 characters for the W&B SDK. Open `http://127.0.0.1:8080` and enter the same token. This documentation does not assert that published binary downloads are available; to build from source, see `docs/contributing.md`.

One Rust executable serves the embedded browser UI, native API, MLflow tracking routes and W&B tracking routes on the same origin. Serving needs no Python or Node runtime, Python process, proxy or secondary port. SDK packages and the optional TensorBoard collector run on the producer side, not as server prerequisites.

The tracker focuses on trustworthy timeseries inspection and native-resolution image timelines, with a dark experiment browser and mixed-chart dashboards. Compatibility is a scoped tracking contract, not a complete MLflow or W&B platform. Generic artifacts and run-file uploads/downloads are unsupported; native image logging remains supported. See `docs/client-compatibility.md` for producer setup and limits. This is not a hardened multi-tenant service.

## Launch options and storage

The public command is:

```text
nset serve --host <ADDRESS> --port <PORT> --token <TOKEN> --db-path <DIR> [--token-file <FILE>] [--workers <N>] [--log-level error|warn|info|debug]
```

`--token-file` replaces `--token`; they cannot be combined. `NSET_TOKEN` can supply the token instead of `--token`; unset it when using a token file. Protect the secret and token file: the token grants full service access. The UI retains it in session storage until Disconnect and never puts it in an image URL.

Defaults are host `127.0.0.1`, port `8080`, database root `./nset-data`, automatic worker count and log level `info`. Automatic workers use available parallelism capped at 32. `--db-path` is a directory, not a database filename. Internal capacity controls are environment tuning, not additional public CLI options; see `docs/durable-ingestion.md`.

The storage root contains `nset.sqlite3` (native and compatibility tables), `ingest.sqlite3` (durable intake), native images, the ownership lock and SQLite WAL/SHM sidecars when present. Only one server may own a root. Keep it on a local filesystem; remote producers use HTTP rather than shared SQLite files. Shut down the server and copy the whole root for backup, not individual databases at different times. Browser view exports are not data backups. This test-data-only transition provides no old-server state migration or backward-compatibility guarantee.

Loopback use needs no extra service. Remote access carries credentials over plaintext HTTP unless protected externally; do not expose it to an untrusted network. TLS termination is not part of this server command.

## Log from Python

Install the dependency-free native client on the producer with `pip install ./python` from a source checkout, or add `python/` to `PYTHONPATH`:

```python
import os
from nset_client import Client

client = Client("http://127.0.0.1:8080", token=os.environ["NSET_TOKEN"])
experiment = client.experiment("my experiment")
with client.start_run(experiment, "baseline", params={"lr": 0.001}) as run:
    run.log_metrics({"loss/test": 0.23}, step=100)
    run.log_image("prediction", "prediction.png", step=100)
```

For batching, use `run.log_batch([{ "key": "loss", "step": 1, "value": 0.5 }, ...])` with up to 10,000 observations per request. These synchronous writes are acknowledged after persistence; the client does not silently retry non-idempotent requests. A failed context marks the run failed. A client exception does not guarantee that an interrupted network write was not committed.

For retry-safe delivery, use `Client.durable_outbox(path)` or native `PUT /api/runs/{id}/ingest/{batch_id}`. Stable batch IDs prevent duplicate application after lost replies; a durable receipt precedes asynchronous query visibility. Producers must retain unacknowledged data. See `docs/durable-ingestion.md` for recovery and capacity limits. Official MLflow/W&B clients use this same server origin; TensorBoard writers can use the optional producer-side event-file collector described in `docs/client-compatibility.md`.

## Explore runs and charts

Open Experiments, choose an experiment, then search or filter its run table. Checkboxes select runs for comparison; row highlighting is not selection. Open Charts to compare them, and use the Runs pane to adjust the selection without leaving the workspace. Its right-edge chevron collapses or restores it; dragging the divider changes its width. Click a run name for its dedicated detail page. Its configuration viewer searches dotted paths and nested values, preserves types, and offers Copy JSON / Export JSON; it is not a raw YAML or file-artifact browser.

Click a run’s color swatch to change its shared color in tables, the drawer and plots. These overrides are stored only in this browser, separately from saved views and view exports.

The initial Overview view places scalar charts and image panels together in collapsible sections, grouped by key prefix. Use a card’s ⋯ → Edit chart for data, axes and appearance beside a live preview; Add chart uses the same editor. Follow selected runs for ordinary comparisons, or choose specific sources across experiments. Save changes updates the card; Cancel leaves it unchanged.

The dashboard X axis chooses Step, Wall time or Relative time (milliseconds since each run’s `created_at`). Smoothing runs from None to More. Changing either global control updates that setting in every scalar card’s saved configuration; image panels are unaffected. Loading mixed per-chart settings preserves them and displays Mixed. Per-chart overrides remain possible until the next global change to that setting.

In Edit chart → Axes, X values → Another metric (XY) plots metrics against each other, like an oscilloscope's XY mode: for example, loss against cumulative data. Each Y curve is paired with an X series, and the two are matched at the same step, wall time or relative time (the hidden "Match X and Y at the same" parameter). Pair each curve with the same metric from each curve's run (two categories, one curve per selected run), or with one specific series from any run or experiment for a one-off comparison. Either works with Follow selected runs or with exact sources. Only the overlap of both series is drawn. Values are interpolated between observations and never extrapolated. Smoothing applies to Y only. Curves follow the parameter order, so X need not be monotonic. A/B value readouts require monotonic X, such as a cumulative counter; threshold crossings always work. XY charts keep their own join parameter and are not changed by the dashboard X axis control.

Left-drag a scalar plot to zoom, with X, Y or both inferred from the gesture. Right-button drag or Space + left-drag pans; Alt + wheel zooms. Hover a plot and press C to cycle vertical cursor placement, horizontal placement and off. Click to place A then B; dragging still zooms. The main delta is the separation between cursor positions. Compact header icons provide fit, back and +/−. Resize from a card’s corner without rearranging neighbors until release, drag its title to reorder it, or maximize it to fill the workspace. Legends and cursor details expand below the canvas without shrinking it. See `web/README.md` for controls and precision details.

View identifies the saved layout, run selection and chart settings; Overview is the initial view’s name. A single view appears as plain text, with a selector when multiple views exist. Named views save locally in this browser. View actions (⋯) → Save view as… creates another view; Export view / Import view… transfers layout and settings, not credentials or logged data. These files are not data backups.

## What the plots mean

Charts load complete metric histories before showing a comparison; they do not downsample observations. At duplicate step or timestamp coordinates, the latest inserted observation supplies the curve value. Interpolation estimates values between observations and never extrapolates beyond them.

Linear and smooth, shape-preserving interpolation are selectable. Smoothing gives each new observation a chosen weight and is calculated over the complete ordered history, not just the visible area. Zoom and scale changes do not alter A/B or crossing answers. **Central 98%** narrows the displayed Y range without deleting observations; **Fit all** reveals the full range again.

Images retain their original bytes and resolution. Frames are selected by their logged step, not interpolated between steps. The current decoded frame stays visible until the next is ready, without a Loading-frame flash; frame changes preserve the camera. Camera controls include fit, native 1:1 pixels, smooth/nearest pixels, rotation and flip.

## Catalog API

Authenticated `GET /api/catalog` returns `{experiments, runs, series}` for tables and source selection, including empty experiments and runs. Each series has `run_id`, `key`, `kind` (`metric` or `image`), `count`, `last_step`, `last_timestamp` and `last_value`. Counts include duplicates; the last fields describe the latest inserted observation, not the greatest step, and image `last_value` is null. The response is a consistent metadata-only read: histories and image bytes remain on their existing endpoints.

## Verification and architecture

`docs/contract.md` describes the native API, and `docs/compat-gateway-contract.md` describes the in-process Rust compatibility boundary (the filename is retained for existing references). Source build and development checks are in `docs/contributing.md`. The UX contracts are in `docs/ux-contract.md` and `docs/ux-refinement-contract.md`.

`docs/verification.md` and the ingestion evidence documents retain earlier results under explicit historical headings. Those results do not establish single-command SDK parity, release readiness or measured performance. Current acceptance must identify its exact source and executed gates.

The server uses a configurable multithreaded HTTP runtime, bounded SQLite read actors, one query writer, and a separate durable journal intake worker/projector. Pending limits reject overload without evicting accepted data; raising thread counts is not a promise of higher sustained throughput. Very large histories remain complete but consume browser memory. There is no claim of unlimited scale; later rendering acceleration must preserve the numerical inspection contract.
