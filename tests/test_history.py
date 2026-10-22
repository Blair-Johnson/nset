from concurrent.futures import ThreadPoolExecutor
import unittest
from support import Server
from nset_client import Client


class HistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server().start()
        cls.client = cls.server.client

    @classmethod
    def tearDownClass(cls):
        cls.server.close()

    def test_complete_large_history(self):
        run = self.client.start_run(self.client.experiment("history"), "all points")
        for start, end in ((0, 10000), (10000, 10023)):
            run.log_batch([{"key": "loss", "step": step, "value": step / 10023}
                           for step in range(start, end)])
        points = list(self.client.metric_history(run.id, "loss", page_size=10000))
        self.assertEqual(len(points), 10023)
        self.assertEqual([p["step"] for p in points], list(range(10023)))
        self.assertEqual(len({p["seq"] for p in points}), 10023)

    def test_snapshot_does_not_drift_during_pagination(self):
        run = self.client.start_run(self.client.experiment("history"), "snapshot")
        run.log_batch([{"key": "loss", "step": i, "value": i} for i in range(7)])
        query = {"key": "loss", "limit": 3}
        page = self.client.http.request("GET", run.path + "/metrics", query=query)
        points = page["points"]
        snapshot = page["snapshot"]
        self.assertEqual(page["total"], 7)
        run.log_metrics({"loss": 999}, step=0)  # Duplicate x remains a stored observation.
        while page["next_after"] is not None:
            query.update(after=page["next_after"], snapshot=snapshot)
            page = self.client.http.request("GET", run.path + "/metrics", query=query)
            self.assertEqual(page["snapshot"], snapshot)
            self.assertEqual(page["total"], 7)
            points.extend(page["points"])
        self.assertEqual(len(points), 7)
        self.assertEqual(len(list(self.client.metric_history(run.id, "loss"))), 8)

    def test_concurrent_clients(self):
        exp = self.client.experiment("concurrent")
        def submit(index):
            client = Client(self.server.url, token=self.server.token)
            run = client.start_run(exp, f"worker {index}")
            run.log_batch([{"key": "loss", "step": i, "value": i / 1000} for i in range(1000)])
            run.finish()
            return len(list(client.metric_history(run.id, "loss")))
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(submit, range(8))), [1000] * 8)


if __name__ == "__main__":
    unittest.main()
