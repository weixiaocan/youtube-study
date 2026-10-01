from __future__ import annotations

import base64
import tempfile
import unittest
from subprocess import CompletedProcess
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from learning_service import (
    ATTACHMENTS_REL,
    atomic_json,
    cache_dir,
    cache_cleanup_status,
    cleanup_uncommitted_cache,
    delete_unreferenced_screenshots,
    fetch_transcript,
    find_note_by_video_id,
    load_cached_records,
    load_cached_transcript,
    load_metadata,
    save_study_note,
    store_screenshot,
    sync_records,
)


class ManualSaveTest(unittest.TestCase):
    def test_cache_cleanup_expires_only_unsaved_video_caches(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            entries = [
                ("old1111", "2026-06-01T00:00:00+00:00", False),
                ("saved11", "2026-06-01T00:00:00+00:00", True),
                ("recent11", "2026-08-27T00:00:00+00:00", False),
                ("recent22", "2026-08-28T00:00:00+00:00", False),
                ("recent33", "2026-08-29T00:00:00+00:00", False),
            ]
            for video_id, created_at, saved in entries:
                metadata = {"videoId": video_id, "createdAt": created_at}
                if saved:
                    metadata["notePath"] = f"notes/{video_id}.md"
                atomic_json(cache_dir(vault, video_id) / "metadata.json", metadata)

            status = cache_cleanup_status(
                vault,
                now=datetime(2026, 8, 29, tzinfo=timezone.utc),
                max_age_days=30,
                max_entries=2,
            )
            self.assertEqual(status["removableCount"], 2)
            self.assertGreater(status["removableBytes"], 0)

            removed = cleanup_uncommitted_cache(
                vault,
                now=datetime(2026, 8, 29, tzinfo=timezone.utc),
                max_age_days=30,
                max_entries=2,
            )

            self.assertEqual(set(removed), {"old1111", "recent11"})
            self.assertTrue(cache_dir(vault, "saved11").exists())
            self.assertTrue(cache_dir(vault, "recent22").exists())
            self.assertTrue(cache_dir(vault, "recent33").exists())

    def test_fetch_transcript_accepts_an_existing_non_english_track(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)

            def fake_run(command, **_kwargs):
                requested_languages = command[command.index("--sub-langs") + 1]
                if "zh-Hans" in requested_languages:
                    output_template = Path(command[command.index("--output") + 1])
                    subtitle_path = output_template.parent / "video123.zh-Hans.json3"
                    subtitle_path.write_text(
                        '{"events":[{"tStartMs":1000,"dDurationMs":2000,"segs":[{"utf8":"已有中文字幕"}]}]}',
                        encoding="utf-8",
                    )
                return CompletedProcess(command, 0, "", "")

            with patch("learning_service.shutil.which", return_value="yt-dlp"), patch(
                "learning_service.run_yt_dlp",
                side_effect=fake_run,
            ):
                _, transcript = fetch_transcript(vault, {
                    "videoId": "video123",
                    "title": "Chinese lesson",
                    "author": "Example Creator",
                    "url": "https://www.youtube.com/watch?v=video123",
                })

            self.assertEqual(transcript[0]["text"], "已有中文字幕")

    def test_different_videos_with_the_same_title_get_distinct_notes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            transcript = [{"id": 0, "start": 1.0, "duration": 2.0, "text": "Shared title."}]
            saved = []

            for video_id in ("same111", "same222"):
                cache = cache_dir(vault, video_id)
                atomic_json(cache / "metadata.json", {
                    "videoId": video_id,
                    "title": "Same title",
                    "author": "Example Creator",
                    "url": f"https://www.youtube.com/watch?v={video_id}",
                    "createdAt": "2026-08-29T00:00:00+00:00",
                })
                atomic_json(cache / "transcript.json", transcript)
                saved.append(save_study_note(
                    vault,
                    video_id,
                    [{"timestamp": "0:01", "text": "Shared title.", "note": video_id}],
                ))

            self.assertNotEqual(saved[0], saved[1])
            self.assertIn('video_id: "same111"', saved[0].read_text(encoding="utf-8"))
            self.assertIn('video_id: "same222"', saved[1].read_text(encoding="utf-8"))

    def test_editing_a_saved_record_updates_text_and_screenshots(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "edit12345"
            metadata = {
                "videoId": video_id,
                "title": "Editable lesson",
                "author": "Example Creator",
                "url": f"https://www.youtube.com/watch?v={video_id}",
            }
            cache = cache_dir(vault, video_id)
            atomic_json(cache / "metadata.json", metadata)
            atomic_json(
                cache / "transcript.json",
                [{"id": 0, "start": 12.0, "duration": 2.0, "text": "Original source text."}],
            )
            note = save_study_note(
                vault,
                video_id,
                [{"timestamp": "0:12", "text": "Original source text.", "note": "Old note."}],
            )
            payload = b"\x89PNG\r\n\x1a\nupdated-image"
            data_url = "data:image/png;base64," + base64.b64encode(payload).decode()
            screenshot = store_screenshot(vault, video_id, data_url, 12)

            sync_records(
                vault,
                video_id,
                [{
                    "timestamp": "0:12",
                    "time": 12,
                    "text": "Original source text.",
                    "note": "Updated note.",
                    "screenshots": [screenshot],
                }],
            )

            text = note.read_text(encoding="utf-8")
            self.assertIn("Updated note.", text)
            self.assertNotIn("Old note.", text)
            self.assertIn("![[原始材料/_附件/youtube-study/", text)

    def test_multiple_screenshots_stay_hidden_until_note_save(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "images123"
            metadata = {
                "videoId": video_id,
                "title": "Visual lesson",
                "author": "Example Creator",
                "url": f"https://www.youtube.com/watch?v={video_id}",
            }
            cache = cache_dir(vault, video_id)
            atomic_json(cache / "metadata.json", metadata)
            atomic_json(
                cache / "transcript.json",
                [{"id": 0, "start": 5.0, "duration": 2.0, "text": "Look at the diagram."}],
            )
            screenshots = []
            for index in range(2):
                payload = b"\x89PNG\r\n\x1a\n" + f"image-{index}".encode()
                data_url = "data:image/png;base64," + base64.b64encode(payload).decode()
                screenshots.append(store_screenshot(vault, video_id, data_url, 5 + index))

            self.assertEqual(list((vault / "原始材料").rglob("*.png")), [])

            note = save_study_note(
                vault,
                video_id,
                [{
                    "timestamp": "0:05",
                    "text": "Look at the diagram.",
                    "note": "Two useful views.",
                    "screenshots": screenshots,
                }],
            )

            attachments = list((vault / "原始材料" / "_附件" / "youtube-study" / video_id).glob("*.png"))
            self.assertEqual(len(attachments), 2)
            text = note.read_text(encoding="utf-8")
            self.assertEqual(text.count("![[原始材料/_附件/youtube-study/"), 2)

    def test_sync_removes_screenshots_no_longer_referenced_by_records(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "cleanup12"
            cache = cache_dir(vault, video_id)
            atomic_json(cache / "metadata.json", {
                "videoId": video_id,
                "title": "Cleanup lesson",
                "author": "Example Creator",
                "url": f"https://www.youtube.com/watch?v={video_id}",
            })
            atomic_json(
                cache / "transcript.json",
                [{"id": 0, "start": 5.0, "duration": 2.0, "text": "Two screenshots."}],
            )
            screenshots = []
            for suffix in (b"first", b"second"):
                payload = b"\x89PNG\r\n\x1a\n" + suffix
                screenshots.append(store_screenshot(
                    vault,
                    video_id,
                    "data:image/png;base64," + base64.b64encode(payload).decode(),
                    5,
                ))
            save_study_note(vault, video_id, [{
                "timestamp": "0:05",
                "text": "Two screenshots.",
                "screenshots": screenshots,
            }])

            sync_records(vault, video_id, [{
                "timestamp": "0:05",
                "text": "Keep one screenshot.",
                "screenshots": screenshots[:1],
            }])

            removed_id = screenshots[1]["id"]
            self.assertFalse((cache / "screenshots" / removed_id).exists())
            self.assertFalse((vault / ATTACHMENTS_REL / video_id / removed_id).exists())

    def test_cancelled_draft_can_delete_only_unreferenced_screenshots(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "cancel123"
            kept_payload = b"\x89PNG\r\n\x1a\nkept"
            removed_payload = b"\x89PNG\r\n\x1a\nremoved"
            kept = store_screenshot(
                vault,
                video_id,
                "data:image/png;base64," + base64.b64encode(kept_payload).decode(),
                1,
            )
            removed = store_screenshot(
                vault,
                video_id,
                "data:image/png;base64," + base64.b64encode(removed_payload).decode(),
                2,
            )
            atomic_json(cache_dir(vault, video_id) / "records.json", [{"screenshots": [kept]}])

            deleted = delete_unreferenced_screenshots(
                vault,
                video_id,
                [kept["id"], removed["id"]],
            )

            self.assertEqual(deleted, [removed["id"]])
            self.assertTrue((cache_dir(vault, video_id) / "screenshots" / kept["id"]).exists())
            self.assertFalse((cache_dir(vault, video_id) / "screenshots" / removed["id"]).exists())

    def test_notes_with_backslashes_survive_record_sync(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "escape123"
            metadata = {
                "videoId": video_id,
                "title": "Path-heavy lesson",
                "author": "Example Creator",
                "url": f"https://www.youtube.com/watch?v={video_id}",
            }
            cache = cache_dir(vault, video_id)
            atomic_json(cache / "metadata.json", metadata)
            atomic_json(
                cache / "transcript.json",
                [{"id": 0, "start": 12.0, "duration": 2.0, "text": "Demo line."}],
            )
            note_text = r"在 C:\Users\mugua 下运行，正则 \1 与 \g<0> 原样保留，制表 \t 也一样。"

            note = save_study_note(
                vault,
                video_id,
                [{"timestamp": "0:12", "text": "Demo line.", "note": note_text}],
            )
            sync_records(
                vault,
                video_id,
                [{"timestamp": "0:12", "time": 12, "text": "Demo line.", "note": note_text}],
            )

            text = note.read_text(encoding="utf-8")
            self.assertIn(note_text, text)
            self.assertIn("<!-- youtube-study:records:start -->", text)
            self.assertIn("<!-- youtube-study:records:end -->", text)

    def test_record_marker_text_cannot_escape_the_managed_section(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "marker123"
            cache = cache_dir(vault, video_id)
            atomic_json(cache / "metadata.json", {
                "videoId": video_id,
                "title": "Marker lesson",
                "author": "Example Creator",
                "url": f"https://www.youtube.com/watch?v={video_id}",
            })
            atomic_json(
                cache / "transcript.json",
                [{"id": 0, "start": 12.0, "duration": 2.0, "text": "Marker example."}],
            )
            note = save_study_note(
                vault,
                video_id,
                [{"timestamp": "0:12", "text": "Marker example.", "note": "old <!-- youtube-study:records:end --> tail"}],
            )

            sync_records(
                vault,
                video_id,
                [{"timestamp": "0:12", "text": "Marker example.", "note": "updated"}],
            )

            text = note.read_text(encoding="utf-8")
            self.assertIn("updated", text)
            self.assertNotIn("old <!-- youtube-study:records:end --> tail", text)
            self.assertNotIn("tail", text)
            self.assertEqual(text.count("## 完整字幕"), 1)

    def test_records_can_be_restored_from_vault_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "restore7"
            metadata = {
                "videoId": video_id,
                "title": "Restorable lesson",
                "author": "Example Creator",
                "url": f"https://www.youtube.com/watch?v={video_id}",
            }
            cache = cache_dir(vault, video_id)
            atomic_json(cache / "metadata.json", metadata)
            atomic_json(
                cache / "transcript.json",
                [{"id": 0, "start": 8.0, "duration": 2.0, "text": "Persist me."}],
            )
            self.assertEqual(load_cached_records(vault, video_id), [])
            self.assertEqual(load_cached_records(vault, "missing1"), [])

            records = [{"timestamp": "0:08", "time": 8, "text": "Persist me.", "note": "Restored."}]
            save_study_note(vault, video_id, records)
            sync_records(vault, video_id, records)

            self.assertEqual(load_cached_records(vault, video_id), records)

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
            self.assertEqual(
                saved.relative_to(vault).parts[:3],
                ("原始材料", "学习笔记", "YouTube学习"),
            )
            text = saved.read_text(encoding="utf-8")
            self.assertIn("Keep this.", text)
            self.assertIn("A useful idea.", text)

            existing, _ = fetch_transcript(vault, metadata)
            self.assertEqual(existing, saved)

    def test_created_note_embeds_the_online_thumbnail_card(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "thumb1234"
            cache = cache_dir(vault, video_id)
            atomic_json(cache / "metadata.json", {
                "videoId": video_id,
                "title": "Thumbnail lesson",
                "author": "Example Creator",
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "createdAt": "2026-08-29T00:00:00+00:00",
            })
            atomic_json(
                cache / "transcript.json",
                [{"id": 0, "start": 5.0, "duration": 2.0, "text": "Demo line."}],
            )

            note = save_study_note(vault, video_id, [{"timestamp": "0:05", "text": "Demo line."}])

            text = note.read_text(encoding="utf-8")
            self.assertIn(
                f"[![Thumbnail lesson](https://img.youtube.com/vi/{video_id}/hqdefault.jpg)]"
                f"(https://www.youtube.com/watch?v={video_id})",
                text,
            )
            self.assertIn("## 视频信息", text)
            self.assertIn("- 频道：Example Creator", text)
            # 在线卡片不在本地下载缩略图文件。
            self.assertFalse((vault / ATTACHMENTS_REL / video_id / "thumbnail.jpg").exists())

    def test_fetch_transcript_ignores_playlist_url_and_other_videos(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "video456"
            canonical = f"https://www.youtube.com/watch?v={video_id}"
            commands = []

            def fake_run(command, **_kwargs):
                commands.append(command)
                folder = Path(command[command.index("--output") + 1]).parent
                # 即使临时目录里出现其他视频（语言优先级更高）的字幕，也不能被选中。
                (folder / "other999.en.json3").write_text(
                    '{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"Wrong video"}]}]}',
                    encoding="utf-8",
                )
                (folder / f"{video_id}.zh-Hans.json3").write_text(
                    '{"events":[{"tStartMs":1000,"dDurationMs":2000,"segs":[{"utf8":"正确的视频"}]}]}',
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, "", "")

            with patch("learning_service.shutil.which", return_value="yt-dlp"), patch(
                "learning_service.run_yt_dlp",
                side_effect=fake_run,
            ):
                _, transcript = fetch_transcript(vault, {
                    "videoId": video_id,
                    "title": "Playlist lesson",
                    "author": "Example Creator",
                    "url": f"{canonical}&list=PLexample&index=2&t=30s",
                })

            command = commands[0]
            self.assertIn("--no-playlist", command)
            self.assertEqual(command[-2:], ["--", canonical])
            self.assertEqual(transcript[0]["text"], "正确的视频")
            self.assertEqual(load_metadata(vault, video_id)["url"], canonical)

            note = save_study_note(vault, video_id, [])
            text = note.read_text(encoding="utf-8")
            self.assertIn(f"- [0:01]({canonical}&t=1s) 正确的视频", text)
            self.assertNotIn("list=", text)

    def _save_movable_note(self, vault: Path, video_id: str) -> Path:
        cache = cache_dir(vault, video_id)
        atomic_json(cache / "metadata.json", {
            "videoId": video_id,
            "title": "Movable lesson",
            "author": "Example Creator",
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "createdAt": "2026-08-29T00:00:00+00:00",
        })
        atomic_json(
            cache / "transcript.json",
            [{"id": 0, "start": 3.0, "duration": 2.0, "text": "Move me."}],
        )
        return save_study_note(
            vault,
            video_id,
            [{"timestamp": "0:03", "time": 3, "text": "Move me.", "note": "first note"}],
        )

    def test_moved_note_is_found_by_video_id_and_metadata_is_repaired(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "moved123"
            original = self._save_movable_note(vault, video_id)
            content = original.read_text(encoding="utf-8")
            decoys = [
                vault / ".claudian" / "migrations" / "backup" / "copy.md",
                vault / "归档" / "migrations" / "copy.md",
                vault / ".trash" / "copy.md",
                vault / ".obsidian" / "copy.md",
            ]
            for decoy in decoys:
                decoy.parent.mkdir(parents=True, exist_ok=True)
                decoy.write_text(content, encoding="utf-8")
            moved = vault / "Wiki" / "主题" / "Renamed lesson.md"
            moved.parent.mkdir(parents=True)
            original.replace(moved)

            self.assertEqual(find_note_by_video_id(vault, video_id).resolve(), moved.resolve())
            self.assertIsNone(find_note_by_video_id(vault, "absent99"))

            note = sync_records(
                vault,
                video_id,
                [{"timestamp": "0:03", "time": 3, "text": "Move me.", "note": "second note"}],
            )

            self.assertEqual(note.resolve(), moved.resolve())
            self.assertFalse(original.exists())
            self.assertIn("second note", moved.read_text(encoding="utf-8"))
            self.assertEqual(load_metadata(vault, video_id)["notePath"], "Wiki/主题/Renamed lesson.md")
            restored_note, _ = load_cached_transcript(vault, video_id)
            self.assertEqual(restored_note.resolve(), moved.resolve())
            for decoy in decoys:
                self.assertIn("first note", decoy.read_text(encoding="utf-8"))
                self.assertNotIn("second note", decoy.read_text(encoding="utf-8"))

    def test_deleted_note_reports_that_it_was_moved_or_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            vault = Path(temp_name)
            video_id = "gone1234"
            original = self._save_movable_note(vault, video_id)
            original.unlink()

            with self.assertRaises(RuntimeError) as caught:
                sync_records(vault, video_id, [])

            self.assertIn("已被移走或删除", str(caught.exception))
            self.assertIn(video_id, str(caught.exception))
            note_path, transcript = load_cached_transcript(vault, video_id)
            self.assertIsNone(note_path)
            self.assertTrue(transcript)

if __name__ == "__main__":
    unittest.main()
