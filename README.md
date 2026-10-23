# Not Shitty Experiment Tracker

A small experiment tracker focused on trustworthy timeseries inspection and native-resolution image timelines, with a dark experiment browser and mixed-chart dashboards. A Rust executable serves the browser UI, writes scalar observations to SQLite, and stores images as immutable files. The UI uses uPlot and OpenSeadragon; Node is a build dependency, not a runtime service.

This is a new API, not an MLflow or wandb compatibility layer. It is an early implementation, not a hardened multi-tenant service.

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

For throughput, use `run.log_batch([{ "key": "loss", "step": 1, "value": 0.5 }, ...])` with up to 10,000 observations per request. Writes are synchronous and acknowledged after persistence; the client does not silently retry non-idempotent requests. A failed context marks the run failed. A client exception does not guarantee that an interrupted network write was not committed; automatic deduplication is not provided.

## Explore runs and charts

Open **Experiments**, choose an experiment, then search or filter its run table. Check the runs you want to compare and open **Charts**; selection is shared between Runs and Charts.

The initial **Overview** view places line charts and image panels together in collapsible sections. Keys such as `train/loss` and `train/prediction` share a `train` section; keys without a slash go in an Overview section. Use the **Runs** picker to adjust the comparison without leaving Charts.

Use a card’s **⋯ → Edit chart** to choose data, axes and appearance beside a live preview. **Save changes** updates that card; **Cancel** leaves it unchanged. **Add chart** creates a line chart or image panel. Follow selected runs for ordinary comparisons, or choose specific series across experiments for a custom comparison.

Changes to named views are saved in this browser. Use **View actions (⋯) → Save as…** for another view and **Export view / Import view…** to transfer its layout and settings. These files contain data references, not credentials or logged observations; they are not data backups.

Line charts start in **Pan** mode. Choose **Zoom** to drag a box, **Inspect** for A/B values and deltas, or **Threshold** for all crossings. Ordinary scrolling moves the page; **Alt + wheel** zooms a chart. **Fit**, **Back** and **+/−** provide visible navigation controls. Image panels keep the camera while you scrub or play the timeline; maximize a card for more space without losing its timeline. See `web/README.md` for shortcuts and detailed controls.

## What the plots mean

Charts load complete metric histories before showing a comparison; they do not downsample observations. At duplicate step or timestamp coordinates, the latest inserted observation supplies the curve value. Interpolation estimates values between observations and never extrapolates beyond them.

Linear and smooth, shape-preserving interpolation are selectable. Smoothing gives each new observation a chosen weight and is calculated over the complete ordered history, not just the visible area. Zoom and scale changes do not alter A/B or threshold answers. **Central 98%** narrows the displayed Y range without deleting observations; **Fit all** reveals the full range again.

Images retain their original bytes and resolution. Frames are selected by their logged step, not interpolated between steps. Camera controls include fit, native 1:1 pixels, smooth/nearest pixels, rotation and flip.

## Catalog API

Authenticated `GET /api/catalog` returns `{experiments, runs, series}` for tables and source selection, including empty experiments and runs. Each series has `run_id`, `key`, `kind` (`metric` or `image`), `count`, `last_step`, `last_timestamp` and `last_value`. Counts include duplicates; the last fields describe the latest inserted observation, not the greatest step, and image `last_value` is null. The response is a consistent metadata-only read: histories and image bytes remain on their existing endpoints.

## Verification and architecture

The API and initial component boundaries are documented in `docs/contract.md`. The redesign specification and reference survey are in `docs/ux-contract.md` and `docs/ux-survey.md`; the detailed development checklists are retained locally in ignored `.agents/plan.md` and `.agents/ux-redesign-plan.md`. Executed checks, screenshots, performance observations, and current limitations are recorded in `docs/verification.md`. The full acceptance command is `bash scripts/verify.sh`; it also installs Chromium for the browser checks.

```sh
pixi run check
NSET_BINARY="$PWD/target/release/nset" pixi run python -m unittest discover -s tests -p 'test_*.py'
NSET_BINARY="$PWD/target/release/nset" pixi run python scripts/benchmark.py
```

The server deliberately starts simple: one SQLite writer and two read workers, transactional metric batches, snapshot-bounded reads, and bounded work queues. Very large histories are complete but still consume browser memory. There is no claim of unlimited scale; later rendering acceleration must preserve the numerical inspection contract.
