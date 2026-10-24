# Not Shitty Experiment Tracker

A small experiment tracker focused on trustworthy timeseries inspection and native-resolution image timelines, with a dark experiment browser and mixed-chart dashboards. A Rust executable serves the browser UI, writes scalar observations to SQLite, and stores images as immutable files. The UI uses uPlot and OpenSeadragon; Node is a build dependency, not a runtime service.

The native API is supplemented by an optional server-side gateway for official MLflow and W&B tracking clients, plus a TensorBoard event-file collector. Existing training instrumentation can keep its SDK; configure the endpoint and credentials instead. Compatibility is a tested subset, not a complete replacement for either vendor's service. See `docs/client-compatibility.md` for setup and limits. This is an early implementation, not a hardened multi-tenant service.

## Build

Install Pixi and a platform C/C++ build toolchain (SQLite is compiled into the binary). From the repository:

```sh
pixi install --locked
pixi run web-install
pixi run build
```

The executable is `target/release/nset` (`nset.exe` on Windows). Build separately for each target OS/architecture. Frontend assets are compiled into the executable; do not run Cargo directly before building `web/dist`.

## Launch

Generate a random token file with owner-only permissions on Unix:

```sh
pixi run python -c 'import os,secrets; f=os.open("access-token",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.write(f,(secrets.token_urlsafe(32)+"\n").encode()); os.close(f)'
./target/release/nset --data-dir ./data --listen 127.0.0.1:8080 --token-file ./access-token
```

Open `http://127.0.0.1:8080` and enter the token. `NSET_TOKEN` is an alternative to `--token-file`. The UI retains the token in session storage until Disconnect; it is never placed in an image URL. All API routes require a bearer token. Treat that token as full read/write access.

Keep the database on a local filesystem. Remote training clients use HTTP, not shared SQLite files. For remote access, use HTTPS through a reverse proxy or an SSH tunnel; do not expose plaintext token traffic to an untrusted network. Copy the executable to a compatible host to deploy; no Python or Node installation is required to serve it.

## Populate example runs

For an isolated demo, run `pixi run preview` after installing the web dependencies. It builds the executable, starts a loopback server on port 8080, and seeds three runs. Enter the token stored in `artifacts/preview.token`; the synthetic database stays in ignored `artifacts/preview-data`. Stop the foreground command with Ctrl-C.

For your own running server, populate examples from another terminal:

```sh
pixi run python examples/demo.py --token-file ./access-token
```

The demo includes three runs with irregularly spaced loss observations, narrow spikes, oscillating threshold crossings, and native PNG sequences. Select several runs and open Charts to compare their curves and scrub the image panels’ prediction sequences.

## Log from Python

Install the dependency-free client with `pip install ./python`, or add `python/` to `PYTHONPATH`:

```python
import os
from nset_client import Client

client = Client("http://127.0.0.1:8080", token=os.environ["NSET_TOKEN"])
experiment = client.experiment("my experiment")
with client.start_run(experiment, "baseline", params={"lr": 0.001}) as run:
    run.log_metrics({"loss/test": 0.23}, step=100)
    run.log_image("prediction", "prediction.png", step=100)
```

For throughput, use `run.log_batch([{ "key": "loss", "step": 1, "value": 0.5 }, ...])` with up to 10,000 observations per request. These legacy writes are synchronous and acknowledged after persistence; the client does not silently retry non-idempotent requests. A failed context marks the run failed. A client exception does not guarantee that an interrupted network write was not committed.

For retry-safe delivery, use `Client.durable_outbox(path)` or the native `PUT /api/runs/{id}/ingest/{batch_id}` endpoint. Stable batch IDs prevent duplicate application after lost replies; a durable receipt precedes asynchronous query visibility. Producers must retain unacknowledged data. See `docs/durable-ingestion.md` for usage, recovery, capacity limits and configurable concurrency. Official MLflow/W&B clients use the gateway described in `docs/client-compatibility.md`; TensorBoard writers use its event-file collector.

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

The API and initial component boundaries are documented in `docs/contract.md`. The redesign specification, compact UX contract and reference survey are in `docs/ux-contract.md`, `docs/ux-refinement-contract.md` and `docs/ux-survey.md`; the detailed development checklists are retained locally in ignored `.agents/plan.md` and `.agents/ux-redesign-plan.md`. Executed checks, screenshots, performance observations, and current limitations are recorded in `docs/verification.md`. The full acceptance command is `bash scripts/verify.sh`; it also installs Chromium for the browser checks.

```sh
pixi run check
NSET_BINARY="$PWD/target/release/nset" pixi run python -m unittest discover -s tests -p 'test_*.py'
NSET_BINARY="$PWD/target/release/nset" pixi run python scripts/benchmark.py
```

The server uses a configurable multithreaded HTTP runtime, bounded SQLite read actors, one query writer, and a separate durable journal intake worker/projector. Pending limits reject overload without evicting accepted data; raising thread counts is not a promise of higher sustained throughput. `docs/durable-ingestion-evidence.md` records recovery checks and concurrent delivery probes. Very large histories are complete but still consume browser memory. There is no claim of unlimited scale; later rendering acceleration must preserve the numerical inspection contract.
