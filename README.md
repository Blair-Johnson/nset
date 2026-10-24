# Not Shitty Experiment Tracker

NSET is a self-hosted experiment tracker compatible with existing logging clients like MLflow and WandB. It is narrowly focused on providing a high-quality user experience for logging and analyzing scalar metrics and images.

![Four training runs compared in nset, showing accuracy, gradient norm, learning rate, and loss.](docs/images/training-comparison.png)

NSET addresses many of my frustrations with existing tools: 
- Curves are plotted at full resolution with configurable interpolation settings.
- Cursors enable easy comparative measurements between curves.
- Curves can be measured at interpolated positions, rather than only where logged data exists.
- Layouts can be saved, named, and exported.
- Chart zoom and layout is preserved across content setting changes.
- Logged images can easily be scrubbed through without resetting crop or zoom.
- Metrics can be joined on a common axis with interpolation and plotted against each other.

## Set up and launch

Install Pixi and a C/C++ build toolchain, then build from source:

```sh
git clone https://github.com/Blair-Johnson/nset.git
cd nset
pixi run web-install
pixi run build
```

Choose an access token, then start the server:

```sh
export NSET_TOKEN='replace-this-with-your-own-random-access-token'
./target/release/nset serve --host 127.0.0.1 --port 8080 \
  --token "$NSET_TOKEN" --db-path ./nset-data
```

Open `http://127.0.0.1:8080` and enter the same token. Use at least 40 characters for W&B clients. `--db-path` sets the directory where the server stores its data.

Use `--host 0.0.0.0` for remote clients, with HTTPS or a tunnel on untrusted networks. Run `./target/release/nset serve --help` for other options.

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

Already using MLflow or W&B? Keep your existing tracking calls and point the client at the same server:

```sh
export MLFLOW_TRACKING_URI=http://127.0.0.1:8080
export MLFLOW_TRACKING_TOKEN="$NSET_TOKEN"
export WANDB_BASE_URL=http://127.0.0.1:8080
export WANDB_API_KEY="$NSET_TOKEN"
export WANDB_ENTITY=local
```

See [supported clients](docs/client-compatibility.md) for supported MLflow and W&B features and TensorBoard event ingestion.

[Chart controls](web/README.md) · [Durable delivery](docs/durable-ingestion.md) · [Build and development](docs/contributing.md)
