# Not Shitty Experiment Tracker

NSET is a self-hosted experiment tracker focused on logging and comparing scalar metrics and images. It has a native Python client and scoped MLflow and W&B tracking support.

![Four training runs compared in nset, showing accuracy, gradient norm, learning rate, and loss.](docs/images/training-comparison.png)

NSET addresses many of my frustrations with existing tools:
- Compare complete metric histories with configurable interpolation and smoothing.
- Measure curves at interpolated positions with vertical and horizontal cursors.
- Save, name, and export chart layouts.
- Keep chart zoom while adjusting styles or resizing cards.
- Scrub logged images while keeping the same crop and zoom.
- Join metrics by step or time and plot them against each other.

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

Charts retain fractional, repeated, and restarted X coordinates in event order. Preview notes show sampled discovery coverage, skipped values, and query limits. Refresh reads a new committed snapshot. WAL-mode sources require existing readable producer-owned `-wal` and `-shm` files; an unavailable source is reported without changing the repository.

## Log data

Install the native client in your training environment from this checkout:

```sh
pip install ./python
```

Set `NSET_TOKEN` to the server's token in that environment, then:

```python
import os
from nset_client import Client

client = Client("http://127.0.0.1:8080", token=os.environ["NSET_TOKEN"])
experiment = client.experiment("My experiment")

with client.start_run(experiment, "baseline", params={"lr": 0.001}) as run:
    for step, loss in enumerate([1.2, 0.7, 0.3]):
        run.log_metrics({"train/loss": loss}, step=step)
```

Refresh the experiment list, select your runs, and open Charts to compare them.

[Logging, supported SDKs, and delivery](docs/logging.md) · [Development](docs/contributing.md)
