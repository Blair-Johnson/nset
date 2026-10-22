import unittest
from support import ROOT
from nset_client import Client


class ClientTests(unittest.TestCase):
    def test_rejects_unsafe_base_urls_and_tokens(self):
        for url in ("file:///tmp/data", "http://user:pass@localhost:8080", "http://localhost?token=a"):
            with self.assertRaises(ValueError):
                Client(url, token="test")
        for token in ("", "a\r\nb"):
            with self.assertRaises(ValueError):
                Client(token=token)


if __name__ == "__main__":
    unittest.main()
