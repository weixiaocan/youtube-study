#!/usr/bin/env python3
"""Chrome Native Messaging host for the YouTube learning workflow."""

from __future__ import annotations

import json
import os
import struct
import sys
from pathlib import Path

from learning_service import (
    cache_cleanup_status,
    cleanup_uncommitted_cache,
    delete_unreferenced_screenshots,
    fetch_transcript,
    load_cached_records,
    load_cached_transcript,
    save_study_note,
    store_screenshot,
    sync_records,
)


def resolve_vault() -> Path:
    # 安装脚本可写入 vault-path.txt 指定知识库根目录；否则假定 host/ 位于
    # <vault>/.claudian/tools/youtube-study/host/ 这一默认布局之下。
    override = Path(__file__).resolve().parent / "vault-path.txt"
    if override.exists():
        value = override.read_text(encoding="utf-8-sig").strip()
        if value:
            return Path(value).resolve()
    return Path(__file__).resolve().parents[4]


VAULT = resolve_vault()


def compact_transcript(transcript: list[dict]) -> list[dict]:
    # Chrome 限制 host→extension 单条消息 1 MB；只回传扩展端真正用到的字段。
    return [
        {"start": item.get("start") or 0, "text": item.get("text") or ""}
        for item in transcript
    ]


def configure_binary_stdio() -> None:
    if os.name == "nt":
        import msvcrt

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def read_message() -> dict | None:
    length_bytes = sys.stdin.buffer.read(4)
    if len(length_bytes) != 4:
        return None
    length = struct.unpack("<I", length_bytes)[0]
    if length > 64 * 1024 * 1024:
        raise ValueError("native message is too large")
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise ValueError("incomplete native message")
    return json.loads(payload.decode("utf-8"))


def write_message(payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > 1024 * 1024:
        raise ValueError("native response exceeds Chrome's 1 MB limit")
    sys.stdout.buffer.write(struct.pack("<I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def handle(message: dict) -> dict:
    action = message.get("action")
    if action == "cache_status":
        return {"ok": True, **cache_cleanup_status(VAULT)}
    if action == "cleanup_cache":
        status = cache_cleanup_status(VAULT)
        removed = cleanup_uncommitted_cache(VAULT)
        return {"ok": True, **status, "removed": removed}
    cleanup_uncommitted_cache(VAULT)
    if action == "load_transcript":
        video = message.get("video") or {}
        note_path, transcript = fetch_transcript(VAULT, video)
        path_value = str(note_path) if note_path else ""
        return {
            "ok": True,
            "sessionPath": path_value,
            "notePath": path_value,
            "transcript": compact_transcript(transcript),
        }
    if action == "restore_transcript":
        note_path, transcript = load_cached_transcript(VAULT, message.get("videoId", ""))
        path_value = str(note_path) if note_path else ""
        return {
            "ok": True,
            "sessionPath": path_value,
            "notePath": path_value,
            "transcript": compact_transcript(transcript),
        }
    if action == "load_records":
        return {"ok": True, "records": load_cached_records(VAULT, message.get("videoId", ""))}
    if action == "store_screenshot":
        screenshot = store_screenshot(
            VAULT,
            message.get("videoId", ""),
            message.get("imageDataUrl", ""),
            message.get("time", 0),
        )
        return {"ok": True, "screenshot": screenshot}
    if action == "delete_screenshots":
        deleted = delete_unreferenced_screenshots(
            VAULT,
            message.get("videoId", ""),
            message.get("screenshotIds") or [],
        )
        return {"ok": True, "deleted": deleted}
    if action == "save_to_vault":
        note_path = save_study_note(
            VAULT,
            message.get("videoId", ""),
            message.get("records") or [],
        )
        return {"ok": True, "sessionPath": str(note_path), "notePath": str(note_path)}
    if action == "sync_records":
        note_path = sync_records(
            VAULT,
            message.get("videoId", ""),
            message.get("records") or [],
        )
        return {"ok": True, "sessionPath": str(note_path), "notePath": str(note_path)}
    if action == "ping":
        return {"ok": True, "vault": str(VAULT)}
    raise ValueError("unsupported native action")


def main() -> None:
    configure_binary_stdio()
    try:
        message = read_message()
        if message is None:
            return
        write_message(handle(message))
    except Exception as error:
        write_message({"ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
