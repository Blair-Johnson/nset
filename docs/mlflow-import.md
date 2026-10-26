# Importing MLflow data

`scripts/mlflow_import.py` copies an MLflow tracking server's experiments, runs,
params, tags, metric history, and logged images into nset through the native HTTP
API. It uses only the Python standard library and can be re-run safely: existing
runs, metric batches, and images are recognized and skipped.

## 1. Export from MLflow

For a Postgres or MySQL backend, export each table as gzipped CSV and copy the
artifact root to local files. For the stock docker-compose deployment (Postgres plus
an S3-compatible bucket), run this on the MLflow host:

```sh
mkdir -p ~/mlflow-export/tables ~/mlflow-export/artifacts && cd ~/mlflow-export
for t in experiments runs params tags metrics; do
  podman exec mlflow-postgres psql -U mlflow -d mlflow \
    -c "\copy (select * from \"$t\") to stdout with csv header" | gzip > tables/$t.csv.gz
done
podman exec mlflow-postgres pg_dump -U mlflow -d mlflow -Fc > mlflow.pgdump   # full backup
# from the compose directory (credentials in .env):
podman run --rm --network mlflow-network --env-file .env -v ~/mlflow-export/artifacts:/out:Z \
  amazon/aws-cli --endpoint-url http://storage:9000 s3 sync s3://mlflow /out
```

Use `docker` instead of `podman` where appropriate. Copy `~/mlflow-export` to the
machine that will run the import, e.g. `ssh host 'tar -C ~/mlflow-export -cf - .' | tar -xf -`.

A local MLflow with a SQLite store needs no export; pass `--sqlite mlflow.db` and
`--artifacts mlruns` directly.

## 2. Import

Start the destination server, then:

```sh
export NSET_TOKEN=...   # the server's token
python scripts/mlflow_import.py --tables ~/mlflow-export/tables \
  --artifacts ~/mlflow-export/artifacts --url http://127.0.0.1:8080 --work-dir ./mlflow-import-work
```

Add `--dry-run` to stage and count the source without contacting nset, or
`--experiment ID_OR_NAME` (repeatable) to import a subset first. The importer stages
CSV tables once into `<work-dir>/staging.sqlite3`, prints progress per run, waits
for scalar projection, compares every imported series with the nset catalog, and
writes `<work-dir>/import-report.json`. It exits nonzero if any series count differs.

## What is mapped

| MLflow | nset |
|---|---|
| Experiment | Experiment with the same name; deleted ones get a ` (deleted in MLflow)` suffix |
| Run name, params, tags | Run name, params, tags. Numeric and boolean params become JSON numbers/booleans (`--raw-params` keeps strings) |
| Run status | `FINISHED` -> finished; `FAILED`/`KILLED` -> failed; others -> running |
| Run ids, times, user, lifecycle | `mlflow_import.*` tags (`run_id`, `start_time`, `end_time`, `status`, `lifecycle_stage`, ...) |
| Metric history | Scalar series with the original step, timestamp, and value |
| `mlflow.log_image` | Images with the original key, step, and timestamp (thumbnails skipped) |
| Other PNG/JPEG/WebP artifacts | With `--other-images`: images keyed `artifacts/<path>` at step 0 |

Not imported: other artifacts (configs, pickles, CSVs, models), datasets/inputs,
traces, evaluations, prompts, and the model registry. Their counts by extension
appear in the report. Keep the export (or `mlflow.pgdump`) if you may need them.

nset cannot store NaN or infinite values, negative steps, or keys over 512 bytes;
those rows are dropped and counted under `dropped` in the report. Imported runs show
the import time as their nset creation time; the original MLflow start and end times
are in the `mlflow_import.start_time` and `mlflow_import.end_time` tags.

Large images upload with `--image-workers` concurrent requests (default 2, matching
the server's default image concurrency).
