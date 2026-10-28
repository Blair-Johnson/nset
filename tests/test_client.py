import unittest
from support import IsolatedClientTestCase
from nset_client import Client


class ClientTests(IsolatedClientTestCase):
    def test_finish_canceled_flushes_before_forwarding_status(self):
        from unittest.mock import ANY, Mock, call, patch
        from nset_client import Run
        client = self.client(token="test")
        run = Run(client, {"id": "test-id", "status": "running"})
        response = {"id": run.id, "status": "canceled"}
        calls = Mock()
        with patch.object(run, "flush") as flush, \
             patch.object(client.http, "request", return_value=response) as update:
            calls.attach_mock(flush, "flush")
            calls.attach_mock(update, "update")
            self.assertEqual(run.finish(status="canceled"), response)
            self.assertEqual(calls.mock_calls, [
                call.flush(timeout=ANY),
                call.update("PATCH", run.path, {"status": "canceled"}),
            ])
        self.assertEqual(run.data, response)

    def test_finish_canceled_does_not_update_status_when_flush_fails(self):
        from unittest.mock import patch
        from nset_client import Run
        client = self.client(token="test")
        run = Run(client, {"id": "test-id", "status": "running"})
        with patch.object(run, "flush", side_effect=TimeoutError("pending scalars")), \
             patch.object(client.http, "request") as update:
            with self.assertRaisesRegex(TimeoutError, "pending scalars"):
                run.finish(status="canceled")
            update.assert_not_called()
        self.assertEqual(run.data["status"], "running")

    def test_context_preserves_training_error_when_status_update_fails(self):
        from unittest.mock import Mock
        from nset_client import Run
        run = Run(self.client(token="test"), {"id": "test-id"})
        run.finish = Mock(side_effect=OSError("network unavailable"))
        with self.assertRaisesRegex(RuntimeError, "training failed"):
            with run:
                raise RuntimeError("training failed")
        with self.assertRaisesRegex(OSError, "network unavailable"):
            with run:
                pass
    def test_rejects_unsafe_base_urls_and_tokens(self):
        for url in ("file:///tmp/data", "http://user:pass@localhost:8080", "http://localhost?token=a"):
            with self.assertRaises(ValueError):
                Client(url, token="test")
        for token in ("", "a\r\nb"):
            with self.assertRaises(ValueError):
                Client(token=token)


if __name__ == "__main__":
    unittest.main()
