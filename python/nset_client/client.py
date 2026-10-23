"""Small explicit ingestion API; scalar batches are atomic per request."""
from pathlib import Path
from urllib.parse import quote
from .transport import Transport


class Client:
    def __init__(self, url="http://127.0.0.1:8080", *, token, timeout=30):
        self.http = Transport(url, token, timeout)

    def experiment(self, name):
        return self.http.request("POST", "/api/experiments", {"name": name})

    def start_run(self, experiment, name, *, params=None, tags=None):
        experiment_id = experiment["id"] if isinstance(experiment, dict) else experiment
        data = self.http.request("POST", "/api/runs", {
            "experiment_id": experiment_id, "name": name,
            "params": params or {}, "tags": tags or {},
        })
        return Run(self, data)

    def metric_history(self, run_id, key, *, page_size=10000):
        query = {"key": key, "limit": page_size}
        path = f"/api/runs/{quote(run_id, safe='')}/metrics"
        while True:
            page = self.http.request("GET", path, query=query)
            yield from page["points"]
            if page["next_after"] is None:
                return
            query.update(after=page["next_after"], snapshot=page["snapshot"])


class Run:
    def __init__(self, client, data):
        self.client, self.data, self.id = client, data, data["id"]
        self.path = f"/api/runs/{quote(self.id, safe='')}"

    def log_batch(self, metrics):
        rows = list(metrics)
        if not 1 <= len(rows) <= 10000:
            raise ValueError("a batch must contain 1..10000 metric observations")
        return self.client.http.request("POST", self.path + "/metrics", {"metrics": rows})

    def log_metrics(self, values, *, step, timestamp=None):
        rows = [{"key": key, "step": step, "value": value} for key, value in values.items()]
        if timestamp is not None:
            for row in rows:
                row["timestamp"] = timestamp
        return self.log_batch(rows)

    def log_image_bytes(self, key, data, *, step, content_type="image/png", timestamp=None):
        query = {"key": key, "step": step}
        if timestamp is not None:
            query["timestamp"] = timestamp
        return self.client.http.request("POST", self.path + "/images", query=query,
                                        raw=data, content_type=content_type)

    def log_image(self, key, path, *, step, timestamp=None):
        path = Path(path)
        types = {".png": "image/png", ".jpg": "image/jpeg",
                 ".jpeg": "image/jpeg", ".webp": "image/webp"}
        if path.suffix.lower() not in types:
            raise ValueError("image must be PNG, JPEG, or WebP")
        return self.log_image_bytes(key, path.read_bytes(), step=step,
                                   content_type=types[path.suffix.lower()], timestamp=timestamp)

    def finish(self, status="finished"):
        self.data = self.client.http.request("PATCH", self.path, {"status": status})
        return self.data

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        try:
            self.finish("failed" if exc_type else "finished")
        except Exception as update_error:
            if exc is None:
                raise
            if hasattr(exc, "add_note"):
                exc.add_note(f"Could not update tracker run status: {update_error}")
        return False
