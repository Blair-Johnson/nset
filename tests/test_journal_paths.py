"""Node-local root selection without opening a journal or contacting a server."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from nset_client.client import Client, _spool_path


class JournalPathTests(unittest.TestCase):
    def test_explicit_and_scheduler_roots_take_precedence(self):
        keys = ("NSET_SPOOL_DIR", "SLURM_TMPDIR", "PBS_JOBFS", "TMPDIR", "TEMP", "TMP")
        with tempfile.TemporaryDirectory() as directory:
            roots = {key: str(Path(directory) / key.lower()) for key in keys}
            for index, key in enumerate(keys):
                with self.subTest(key=key), patch.dict(os.environ, dict(list(roots.items())[index:]), clear=True):
                    path = _spool_path("http://example.test")
                    self.assertEqual(path.parents[2], Path(roots[key]))
                    self.assertEqual(path.name, hashlib.sha256(b"http://example.test").hexdigest())
                    self.assertEqual(path.parent.name, "outbox")
                    self.assertFalse(path.exists())

    def test_relative_configured_root_is_rejected(self):
        for key in ("NSET_SPOOL_DIR", "SLURM_TMPDIR", "PBS_JOBFS", "TMPDIR", "TEMP", "TMP"):
            with self.subTest(key=key), patch.dict(os.environ, {key: "relative/path"}, clear=True):
                with self.assertRaisesRegex(ValueError, key):
                    _spool_path("http://example.test")

    @unittest.skipIf(os.name == "nt", "POSIX fallback")
    def test_default_ignores_home_and_xdg(self):
        with patch.dict(os.environ, {"HOME": "/shared/home", "XDG_STATE_HOME": "/shared/state"}, clear=True):
            self.assertEqual(_spool_path("http://example.test").parents[2], Path("/tmp"))

    def test_url_normalization_and_token_rotation_share_path_without_writes(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"NSET_SPOOL_DIR": directory}):
            first = Client("http://example.test/", token="first")
            second = Client("http://example.test", token="second")
            other = Client("http://different.test", token="first")
            try:
                self.assertEqual(first.spool_path, second.spool_path)
                self.assertNotEqual(first.spool_path, other.spool_path)
                self.assertEqual(list(Path(directory).iterdir()), [])
            finally:
                for client in (first, second, other):
                    client.close()
