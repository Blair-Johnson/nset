# Not Shitty Experiment Tracker

NSET is a self-hosted experiment tracker compatible with existing logging clients like MLflow and WandB. It is narrowly focused on providing a high-quality user experience for logging and analyzing scalar metrics and images.

![Four training runs compared in nset, showing accuracy, gradient norm, learning rate, and loss.](docs/images/training-comparison.png)

NSET addresses many of my frustrations with existing tools:
- Curves are plotted at full resolution.
- Cursors enable easy comparative measurements between curves.
- Curves can be measured at interpolated positions, rather than only where logged data exists.
- Page layouts and chart settings can be saved, named, imported/exported, and managed via API (easy for agents to present data).
- Chart viewport settings are preserved across content changes.
- Image viewer supports easy timeline scrubbing without resetting viewport crop.
- Data updates live without manual polling or scrolling to induce refresh events.
- Metrics can be joined on a common axis (using interpolated points) and plotted against each other without requiring exact intersection.
- Configurable Gaussian smoothing instead of lag-inducing EMA.
- Mouse pointer crosshair uses nearest intersection to display ordered values from curves, enabling easy inspection.

## Set up and launch

Install Pixi and a C/C++ build toolchain, then build from source:

```sh
git clone https://github.com/Blair-Johnson/nset.git
cd nset
pixi install --locked
pixi run web-install
pixi run build
```

Choose a random access token, then start the server:

```sh
export NSET_TOKEN='replace-this-with-your-own-random-access-token'
./target/release/nset serve --host 127.0.0.1 --port 8080 \
  --db-path ./nset-data
```

Open `http://127.0.0.1:8080` and enter the same token. Use at least 40 characters for W&B clients. The token grants access to the whole service. `--db-path` sets the data directory; keep it on local storage.

Use `--host 0.0.0.0` for remote clients, with HTTPS or a secure tunnel on untrusted networks. `--log-level debug` enables diagnostic logs. Run `./target/release/nset serve --help` for other options.

## Read local rx records

Add `--rx-repo /path/to/repository` to `nset serve` to browse that repository’s recorded structured events alongside native data. The repository appears as a read-only source; Git worktrees resolve to their shared repository storage.

Select runs, open Charts, and add an **rx records** chart. Enter a numeric X field and add Y fields with Tab completion. **Filter records** selects observations within those runs; **Group by** separates curves using a scalar field on each record. For example, filter `kind = "epoch"`, choose X `epoch`, and add `train_loss` and `val_loss`. Use `metrics.loss` for a nested field and `$["metrics.loss"]` for a literal dotted key. **Inspect records** pages through the underlying JSON.

Charts retain fractional, repeated, and restarted X coordinates in event order. Preview notes show sampled discovery coverage, skipped values, and query limits. Refresh reads a new committed snapshot. The database is opened read-only; normal SQLite WAL/shared-memory reader coordination is allowed. Permission or recovery failures are reported without a writable fallback. Inspection pages assume append-only event sequences and detect database replacement; in-place edits are not frozen across pages. Numeric axes use finite double precision; the filter editor rejects unsafe integers rather than rounding them.

## Share a saved view

Server-backed views appear in the **Saved view** picker and have stable links for people using the same server token. See [Server-backed saved views](docs/server-views.md) for editing behavior and an agent API example.

## Log data

Install the native client in your training environment from this checkout:

```sh
pip install ./client
```

Set `NSET_TOKEN` to the server's token in that environment, then:

```python
import os
from nset_client import Client

with Client("http://127.0.0.1:8080", token=os.environ["NSET_TOKEN"]) as client:
    experiment = client.experiment("My experiment")
    with client.start_run(experiment, "baseline", params={"lr": 0.001}) as run:
        for step, loss in enumerate([1.2, 0.7, 0.3]):
            run.log_metrics({"train/loss": loss}, step=step)
```

Scalar calls retain data locally and retry delivery automatically; exiting the contexts waits for server acceptance. Refresh the experiment list, select your runs, and open Charts to compare them.

[Logging, supported SDKs, and delivery](docs/logging.md) · [Development](docs/contributing.md)
