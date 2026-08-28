from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from learning_service import (
    atomic_json,
    cache_dir,
    fetch_transcript,
    load_cached_transcript,
    save_study_note,
)


class ManualSaveTest(unittest.TestCase):
    def test_cached_transcript_can_be_restored_without_fetching(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "cached123"
            metadata = {
                "videoId": video_id,
                "title": "Cached video",
                "author": "Example Creator",
                "url": f"https://www.youtube.com/watch?v={video_id}",
            }
            transcript = [{"id": 0, "start": 5.0, "duration": 2.0, "text": "Already fetched."}]
            cache = cache_dir(vault, video_id)
            atomic_json(cache / "metadata.json", metadata)
            atomic_json(cache / "transcript.json", transcript)

            note, loaded = load_cached_transcript(vault, video_id)

            self.assertIsNone(note)
            self.assertEqual(loaded, transcript)
            self.assertEqual(load_cached_transcript(vault, "missing1"), (None, []))

    def test_cached_transcript_is_not_visible_until_explicit_save(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "abc123XYZ"
            metadata = {
                "videoId": video_id,
                "title": "A useful video",
                "author": "Example Creator",
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "createdAt": "2026-08-27T00:00:00+00:00",
            }
            transcript = [{"id": 0, "start": 3.0, "duration": 2.0, "text": "A useful idea."}]
            cache = cache_dir(vault, video_id)
            atomic_json(cache / "metadata.json", metadata)
            atomic_json(cache / "transcript.json", transcript)

            note, loaded = fetch_transcript(vault, metadata)

            self.assertIsNone(note)
            self.assertEqual(loaded, transcript)
            self.assertEqual(list(vault.rglob("*.md")), [])

            saved = save_study_note(
                vault,
                video_id,
                [{"timestamp": "0:03", "text": "A useful idea.", "note": "Keep this."}],
            )

            self.assertTrue(saved.exists())
            text = saved.read_text(encoding="utf-8")
            self.assertIn("Keep this.", text)
            self.assertIn("A useful idea.", text)

            existing, _ = fetch_transcript(vault, metadata)
            self.assertEqual(existing, saved)


if __name__ == "__main__":
    unittest.main()
