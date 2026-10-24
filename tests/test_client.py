import unittest
from support import IsolatedClientTestCase
from nset_client import Client


class ClientTests(IsolatedClientTestCase):
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
