from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import native_host
from learning_service import atomic_json, cache_dir


class NativeHostContractTest(unittest.TestCase):
    def test_cache_actions_only_remove_expired_unsaved_entries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            old_unsaved = cache_dir(vault, "old1111")
            atomic_json(old_unsaved / "metadata.json", {
                "videoId": "old1111",
                "createdAt": "2020-01-01T00:00:00+00:00",
            })
            old_saved = cache_dir(vault, "saved11")
            atomic_json(old_saved / "metadata.json", {
                "videoId": "saved11",
                "createdAt": "2020-01-01T00:00:00+00:00",
                "notePath": "notes/saved.md",
            })

            with patch.object(native_host, "VAULT", vault):
                status = native_host.handle({"action": "cache_status"})
                result = native_host.handle({"action": "cleanup_cache"})

            self.assertEqual(status["removableCount"], 1)
            self.assertEqual(result["removed"], ["old1111"])
            self.assertFalse(old_unsaved.exists())
            self.assertTrue(old_saved.exists())


if __name__ == "__main__":
    unittest.main()
