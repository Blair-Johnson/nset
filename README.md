# Not Shitty Experiment Tracker

A small experiment tracker focused on trustworthy timeseries inspection and native-resolution image timelines. A Rust executable serves the browser UI, writes scalar observations to SQLite, and stores images as immutable files. The UI uses uPlot and OpenSeadragon; Node is a build dependency, not a runtime service.

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

Open `http://127.0.0.1:8080` and enter the token. `NSET_TOKEN` is an alternative to `--token-file`. The UI retains the token in session storage until logout; it is never placed in an image URL. All API routes require a bearer token. Treat that token as full read/write access.

Keep the database on a local filesystem. Remote training clients use HTTP, not shared SQLite files. For remote access, use HTTPS through a reverse proxy or an SSH tunnel; do not expose plaintext token traffic to an untrusted network. Copy the executable to a compatible host to deploy; no Python or Node installation is required to serve it.

## Populate example runs

With the server running, in another terminal:

```sh
pixi run python examples/demo.py --token-file ./access-token
```

The demo includes three runs with irregularly spaced loss observations, narrow spikes, oscillating threshold crossings, and native PNG sequences. Select several runs to compare their curves; choose the image tab to scrub through a prediction sequence.

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

## Plot semantics and configuration

Metric history is paginated, not sampled. The inspector loads the complete snapshot before authoritative curve/readout updates. Duplicate x coordinates remain stored, but numerical curves use the observation with the greatest sequence number at that coordinate. Interpolation is an estimate, never an additional measurement. No extrapolation is performed.

Linear and shape-preserving cubic interpolation are selectable. EMA is defined per observation and computed on the complete ordered series, not on the current viewport. Axis transformations affect display, not the underlying numerical query. A horizontal threshold may have several crossings or an interval of equal values; neither is silently reduced to a first-hit answer.

Common uPlot settings are exposed through controls and saved view configurations. Advanced JSON options provide additional customization without executing arbitrary JavaScript. Function-valued callbacks and protected inspector hooks are not equivalent to JSON configuration; see the frontend configuration documentation for exact supported options and boundaries.

Image bytes are preserved without recompression. Timeline changes preserve the viewer's camera rather than fitting each new frame. Image frame selection is discrete and labeled by its actual logged step; images are not interpolated between training steps.

## Verification and architecture

The API and initial component boundaries are documented in `docs/contract.md`. The detailed development checklist is retained locally in ignored `.agents/plan.md`. Executed checks, screenshots, performance observations, and current limitations are recorded in `docs/verification.md` once integration verification completes.

```sh
pixi run check
NSET_BINARY="$PWD/target/release/nset" pixi run python -m unittest discover -s tests -p 'test_*.py'
NSET_BINARY="$PWD/target/release/nset" pixi run python scripts/benchmark.py
```

The server deliberately starts simple: one SQLite writer and two read workers, transactional metric batches, snapshot-bounded reads, and bounded work queues. Very large histories are complete but still consume browser memory. There is no claim of unlimited scale; later rendering acceleration must preserve the numerical inspection contract.
