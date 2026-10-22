import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from support import Server
from nset_client import APIError, Client


class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server().start()
        cls.client = cls.server.client

    @classmethod
    def tearDownClass(cls):
        cls.server.close()

    def test_auth_and_public_ui(self):
        for path in ("/api/health", "/api/experiments", "/api/images/unknown/content"):
            with self.assertRaises(HTTPError) as caught:
                urlopen(self.server.url + path)
            self.assertEqual(caught.exception.code, 401)
        with self.assertRaises(APIError) as caught:
            Client(self.server.url, token="incorrect").http.request("GET", "/api/health")
        self.assertEqual(caught.exception.status, 401)
        with urlopen(self.server.url) as response:
            self.assertIn(b"<html", response.read().lower())
        request = Request(self.server.url + "/api/health", headers={
            "Authorization": "Bearer " + self.server.token, "Origin": "https://evil.example"})
        with urlopen(request) as response:
            self.assertNotEqual(response.headers.get("Access-Control-Allow-Origin"), "*")

    def test_run_lifecycle_and_duplicate_experiment(self):
        exp = self.client.experiment("lifecycle")
        self.assertEqual(exp["id"], self.client.experiment("lifecycle")["id"])
        run = self.client.start_run(exp, "<script>plain text</script>", params={"lr": 0.1})
        updated = self.client.http.request("PATCH", run.path, {"params": {"seed": 42}})
        self.assertEqual(updated["params"], {"lr": 0.1, "seed": 42})
        run.log_metrics({"loss": 1.0, "accuracy": 0.2}, step=0)
        keys = self.client.http.request("GET", run.path + "/metric-keys")["keys"]
        self.assertEqual(set(keys), {"loss", "accuracy"})
        self.assertEqual(run.finish()["status"], "finished")
        self.server.stop()
        self.server.start()
        persisted = self.client.http.request("GET", run.path)
        self.assertEqual(persisted["status"], "finished")
        self.assertEqual(len(list(self.client.metric_history(run.id, "loss"))), 1)

    def test_invalid_batch_is_atomic(self):
        run = self.client.start_run(self.client.experiment("validation"), "atomic")
        invalid = [
            {"key": "loss", "step": -1, "value": 2},
            {"key": "loss", "step": 9007199254740992, "value": 2},
            {"key": "", "step": 1, "value": 2},
        ]
        for bad in invalid:
            with self.assertRaises(APIError) as caught:
                run.log_batch([{"key": "loss", "step": 0, "value": 1}, bad])
            self.assertIn(caught.exception.status, (400, 422))
        self.assertEqual(list(self.client.metric_history(run.id, "loss")), [])
        with self.assertRaises(APIError) as caught:
            self.client.http.request("GET", "/api/runs/00000000-0000-0000-0000-000000000000")
        self.assertEqual(caught.exception.status, 404)

    def test_context_manager_marks_failed(self):
        with self.assertRaisesRegex(RuntimeError, "deliberate"):
            with self.client.start_run(self.client.experiment("context"), "failure") as run:
                raise RuntimeError("deliberate")
        self.assertEqual(self.client.http.request("GET", run.path)["status"], "failed")


if __name__ == "__main__":
    unittest.main()
