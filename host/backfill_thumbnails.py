#!/usr/bin/env python3
"""Backfill clickable video thumbnails into notes saved before v1.1.

Notes created before v1.1 have no thumbnail in their 视频信息 section.
This script scans the YouTube study notes folder, and for every note that
has a video_id but no image embed, downloads the thumbnail beside the
video's screenshots and inserts a clickable embed line at the top of the
视频信息 section. Everything else in the note is left untouched.

Safe by default: run without --apply to preview what would change.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from learning_service import (  # noqa: E402
    NOTES_REL,
    atomic_text,
    download_thumbnail,
)

THUMBNAIL_MARK = "[!["


def note_title(text: str) -> str:
    match = re.search(r"(?m)^# (.+)$", text)
    return match.group(1).strip() if match else "视频"


def note_url(text: str) -> str | None:
    match = re.search(r'(?m)^source:\s*("(?:[^"\\]|\\.)*")', text)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except ValueError:
        return None


def insert_thumbnail(text: str, alt: str, thumbnail_path: str, url: str) -> str:
    """Insert the clickable thumbnail embed right after the 视频信息 heading."""
    heading = "## 视频信息"
    start = text.find(heading)
    if start < 0:
        return text
    body_start = text.find("\n", start) + 1
    body = text[body_start:]
    content_start = body_start + len(body) - len(body.lstrip("\n"))
    alt = re.sub(r"[\[\]]", "", alt)
    embed = f"[![{alt}]({thumbnail_path})]({url})\n\n"
    return text[:content_start] + embed + text[content_start:]


def collect_notes(vault: Path) -> list[tuple[Path, dict]]:
    """Return (note, info) for notes that miss a thumbnail but have a video_id."""
    notes_root = vault / NOTES_REL
    if not notes_root.exists():
        return []
    found: list[tuple[Path, dict]] = []
    for note in sorted(notes_root.glob("*.md")):
        try:
            text = note.read_text(encoding="utf-8")
        except OSError:
            continue
        if THUMBNAIL_MARK in text:
            continue
        match = re.search(r'(?m)^video_id:\s*"([A-Za-z0-9_-]{6,20})"\s*$', text)
        if not match:
            continue
        url = note_url(text)
        found.append((note, {
            "videoId": match.group(1),
            "title": note_title(text),
            "url": url or f"https://www.youtube.com/watch?v={match.group(1)}",
        }))
    return found


def main() -> None:
    default_vault = Path(__file__).resolve().parents[4]
    parser = argparse.ArgumentParser(
        description="为 v1.1 之前保存的笔记批量补上可点击的视频缩略图"
    )
    parser.add_argument("--vault", type=Path, default=default_vault)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="真正写入笔记并下载缩略图；默认只预览将处理的内容",
    )
    args = parser.parse_args()
    vault = args.vault.resolve()

    notes = collect_notes(vault)
    if not notes:
        print("没有需要补缩略图的笔记。")
        return

    print(f"发现 {len(notes)} 篇缺少缩略图的笔记：")
    for note, info in notes:
        print(f"  - {note.relative_to(vault)}  (video {info['videoId']})")

    if not args.apply:
        print("\n预览模式，未做任何修改。确认无误后加 --apply 执行。")
        return

    updated = failed = 0
    for note, info in notes:
        thumbnail = download_thumbnail(vault, info["videoId"])
        if not thumbnail:
            print(f"  [跳过] 缩略图下载失败：{note.name}")
            failed += 1
            continue
        text = note.read_text(encoding="utf-8")
        atomic_text(note, insert_thumbnail(text, info["title"], thumbnail, info["url"]))
        updated += 1
        print(f"  [已更新] {note.name} -> {thumbnail}")

    print(f"\n完成：更新 {updated} 篇，失败跳过 {failed} 篇。")


if __name__ == "__main__":
    main()
