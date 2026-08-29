#!/usr/bin/env python3
"""Persist one visible Markdown note per YouTube video.

Notes are raw material (原始材料/学习笔记/YouTube学习); the Wiki is curated
separately from them. JSON needed by the side panel is kept under
.claudian/cache/youtube-study and is safe to rebuild.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


NOTES_REL = Path("原始材料") / "学习笔记" / "YouTube学习"
CACHE_REL = Path(".claudian") / "cache" / "youtube-study"
ATTACHMENTS_REL = Path("原始材料") / "_附件" / "youtube-study"
RECORDS_START = "<!-- youtube-study:records:start -->"
RECORDS_END = "<!-- youtube-study:records:end -->"
TRANSCRIPT_START = "<!-- youtube-study:transcript:start -->"
TRANSCRIPT_END = "<!-- youtube-study:transcript:end -->"
SCREENSHOT_ID = re.compile(r"[0-9]{10}-[a-f0-9]{10}\.(?:jpg|png|webp)")


def safe_filename(value: str, limit: int = 96) -> str:
    value = re.sub(r'[<>:"/\\|?*]+', "-", value)
    value = re.sub(r"\s+", " ", value).strip(" .-")
    return (value[:limit].rstrip(" .-") or "YouTube 视频")


def validate_video_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,20}", value or ""):
        raise ValueError("invalid video id")
    return value


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(value, encoding="utf-8", newline="\n")
    temp.replace(path)


def atomic_json(path: Path, value: object) -> None:
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2))


def atomic_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_bytes(value)
    temp.replace(path)


def cache_dir(vault: Path, video_id: str) -> Path:
    return vault / CACHE_REL / validate_video_id(video_id)


def load_metadata(vault: Path, video_id: str) -> dict | None:
    path = cache_dir(vault, video_id) / "metadata.json"
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _cache_cleanup_targets(
    vault: Path,
    *,
    now: datetime | None = None,
    max_age_days: int = 30,
    max_entries: int = 50,
) -> list[tuple[str, Path]]:
    cache_root = vault / CACHE_REL
    if not cache_root.exists():
        return []
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    candidates: list[tuple[datetime, str, Path]] = []
    for directory in cache_root.iterdir():
        if not directory.is_dir():
            continue
        try:
            video_id = validate_video_id(directory.name)
        except ValueError:
            continue
        metadata = load_metadata(vault, video_id)
        if metadata and metadata.get("notePath"):
            continue
        created_at = None
        if metadata and metadata.get("createdAt"):
            try:
                created_at = datetime.fromisoformat(str(metadata["createdAt"]).replace("Z", "+00:00"))
            except ValueError:
                created_at = None
        if created_at is None:
            created_at = datetime.fromtimestamp(directory.stat().st_mtime, tz=timezone.utc)
        elif created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        candidates.append((created_at, video_id, directory))

    cutoff = current.timestamp() - max(0, max_age_days) * 86400
    expired = {video_id for created_at, video_id, _ in candidates if created_at.timestamp() < cutoff}
    retained = sorted(
        (item for item in candidates if item[1] not in expired),
        key=lambda item: item[0],
        reverse=True,
    )
    overflow = {video_id for _, video_id, _ in retained[max(0, max_entries):]}
    remove_ids = expired | overflow
    return [(video_id, directory) for _, video_id, directory in candidates if video_id in remove_ids]


def cache_cleanup_status(
    vault: Path,
    *,
    now: datetime | None = None,
    max_age_days: int = 30,
    max_entries: int = 50,
) -> dict:
    targets = _cache_cleanup_targets(
        vault,
        now=now,
        max_age_days=max_age_days,
        max_entries=max_entries,
    )
    total_bytes = sum(
        path.stat().st_size
        for _, directory in targets
        for path in directory.rglob("*")
        if path.is_file()
    )
    return {"removableCount": len(targets), "removableBytes": total_bytes}


def cleanup_uncommitted_cache(
    vault: Path,
    *,
    now: datetime | None = None,
    max_age_days: int = 30,
    max_entries: int = 50,
) -> list[str]:
    """Remove expired hidden caches that have never been saved to the vault."""
    targets = _cache_cleanup_targets(
        vault,
        now=now,
        max_age_days=max_age_days,
        max_entries=max_entries,
    )
    removed: list[str] = []
    for video_id, directory in targets:
        shutil.rmtree(directory)
        removed.append(video_id)
    return removed


def note_from_metadata(vault: Path, metadata: dict) -> Path:
    note_path = metadata.get("notePath")
    if not note_path:
        raise RuntimeError("视频缓存中缺少 notePath，请重新获取字幕")
    path = (vault / note_path).resolve()
    try:
        path.relative_to(vault.resolve())
    except ValueError as error:
        raise RuntimeError("非法的笔记路径") from error
    return path


def parse_json3(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    items: list[dict] = []
    previous = ""
    for event in data.get("events", []):
        segments = event.get("segs") or []
        text = "".join(segment.get("utf8", "") for segment in segments)
        text = re.sub(r"\s+", " ", text.replace("\n", " ")).strip()
        if not text or text == previous:
            continue
        previous = text
        items.append({
            "id": len(items),
            "start": (event.get("tStartMs") or 0) / 1000,
            "duration": (event.get("dDurationMs") or 0) / 1000,
            "text": text,
        })
    return items


def subtitle_priority(path: Path) -> tuple[int, str]:
    language = path.name.removesuffix(".json3").rsplit(".", 1)[-1].lower()
    preferred = ("en-orig", "en", "zh-hans", "zh-hant", "zh")
    try:
        return preferred.index(language), language
    except ValueError:
        return len(preferred), language


def format_time(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def transcript_markdown(transcript: list[dict], url: str) -> str:
    lines = []
    for item in transcript:
        seconds = float(item.get("start") or 0)
        text = re.sub(r"\s+", " ", str(item.get("text") or "")).strip()
        lines.append(f"- [{format_time(seconds)}]({url}&t={int(seconds)}s) {text}")
    return "\n".join(lines) or "当前没有可用字幕。"


def record_screenshot_ids(record: dict) -> list[str]:
    values = record.get("screenshots") or []
    return [
        str(item.get("id") or "")
        for item in values
        if isinstance(item, dict) and item.get("id")
    ]


def records_markdown(records: list[dict], screenshot_paths: dict[str, str] | None = None) -> str:
    screenshot_paths = screenshot_paths or {}
    sections: list[str] = []
    for record in records:
        timestamp = str(record.get("timestamp") or "0:00")
        text = str(record.get("text") or "（当时未获取到字幕）")
        note = str(record.get("note") or "").strip()
        sections.extend([f"### {timestamp}", "", "> " + text.replace("\n", "\n> ")])
        for screenshot_id in record_screenshot_ids(record):
            screenshot_path = screenshot_paths.get(screenshot_id)
            if screenshot_path:
                sections.extend(["", f"![[{screenshot_path}]]"])
        if note:
            sections.extend(["", note])
        sections.append("")
    return "\n".join(sections).rstrip() or "暂无观看记录。"


def store_screenshot(vault: Path, video_id: str, image_data_url: str, time_seconds: float) -> dict:
    """Store a user-provided screenshot in the hidden video cache."""
    video_id = validate_video_id(video_id)
    match = re.fullmatch(r"data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)", image_data_url or "")
    if not match:
        raise ValueError("截图格式无效")
    extension = {"jpeg": "jpg", "png": "png", "webp": "webp"}[match.group(1)]
    try:
        payload = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("截图数据损坏") from error
    if not payload or len(payload) > 2_500_000:
        raise ValueError("截图不能超过 2.5 MB")
    if extension == "jpg" and not payload.startswith(b"\xff\xd8\xff"):
        raise ValueError("截图不是有效的 JPEG")
    if extension == "png" and not payload.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("截图不是有效的 PNG")
    if extension == "webp" and not (payload.startswith(b"RIFF") and payload[8:12] == b"WEBP"):
        raise ValueError("截图不是有效的 WebP")

    millis = max(0, int(float(time_seconds or 0) * 1000))
    digest = hashlib.sha256(payload).hexdigest()[:10]
    screenshot_id = f"{millis:010d}-{digest}.{extension}"
    path = cache_dir(vault, video_id) / "screenshots" / screenshot_id
    atomic_bytes(path, payload)
    return {"id": screenshot_id, "size": len(payload)}


def materialize_record_screenshots(vault: Path, video_id: str, records: list[dict]) -> dict[str, str]:
    """Copy screenshots referenced by records into the Obsidian attachment folder."""
    video_id = validate_video_id(video_id)
    paths: dict[str, str] = {}
    for record in records:
        for screenshot_id in record_screenshot_ids(record):
            if not SCREENSHOT_ID.fullmatch(screenshot_id):
                continue
            source = cache_dir(vault, video_id) / "screenshots" / screenshot_id
            if not source.exists():
                continue
            destination = vault / ATTACHMENTS_REL / video_id / screenshot_id
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists():
                shutil.copy2(source, destination)
            paths[screenshot_id] = destination.relative_to(vault).as_posix()
    return paths


def cleanup_orphan_screenshots(vault: Path, video_id: str, records: list[dict]) -> list[str]:
    """Delete managed screenshot files that no current record references."""
    video_id = validate_video_id(video_id)
    referenced = {
        screenshot_id
        for record in records
        for screenshot_id in record_screenshot_ids(record)
        if SCREENSHOT_ID.fullmatch(screenshot_id)
    }
    removed: set[str] = set()
    roots = [
        cache_dir(vault, video_id) / "screenshots",
        vault / ATTACHMENTS_REL / video_id,
    ]
    for root in roots:
        if not root.exists():
            continue
        for path in root.iterdir():
            if path.is_file() and SCREENSHOT_ID.fullmatch(path.name) and path.name not in referenced:
                path.unlink()
                removed.add(path.name)
        if not any(root.iterdir()):
            root.rmdir()
    return sorted(removed)


def delete_unreferenced_screenshots(vault: Path, video_id: str, screenshot_ids: list[str]) -> list[str]:
    """Delete selected managed screenshots unless a saved local record still references them."""
    video_id = validate_video_id(video_id)
    referenced = {
        screenshot_id
        for record in load_cached_records(vault, video_id)
        for screenshot_id in record_screenshot_ids(record)
    }
    requested = {
        str(screenshot_id)
        for screenshot_id in screenshot_ids
        if SCREENSHOT_ID.fullmatch(str(screenshot_id)) and str(screenshot_id) not in referenced
    }
    deleted: set[str] = set()
    for root in (cache_dir(vault, video_id) / "screenshots", vault / ATTACHMENTS_REL / video_id):
        if not root.exists():
            continue
        for screenshot_id in requested:
            path = root / screenshot_id
            if path.is_file():
                path.unlink()
                deleted.add(screenshot_id)
        if not any(root.iterdir()):
            root.rmdir()
    return sorted(deleted)


def replace_section(text: str, heading: str, next_heading: str, start: str, end: str, body: str) -> str:
    # body 含用户笔记，可能带反斜杠（如 Windows 路径）；
    # re.sub 的字符串替换模板会解析这些反斜杠，必须用函数形式原样插入。
    replacement = f"{start}\n{body}\n{end}"
    start_index = text.find(start)
    end_index = text.rfind(end)
    if start_index >= 0 and end_index >= start_index:
        return text[:start_index] + replacement + text[end_index + len(end):]
    section = re.compile(rf"(?ms)(^## {re.escape(heading)}\s*$).*?(?=^## {re.escape(next_heading)}\s*$)")
    if section.search(text):
        return section.sub(lambda m: f"{m.group(1)}\n\n{replacement}\n\n", text, count=1)
    return text.rstrip() + f"\n\n## {heading}\n\n{replacement}\n"


def create_note(vault: Path, metadata: dict, transcript: list[dict]) -> Path:
    notes_root = vault / NOTES_REL
    notes_root.mkdir(parents=True, exist_ok=True)
    title = metadata.get("title") or metadata["videoId"]
    captured = str(metadata.get("createdAt") or date.today().isoformat())[:10]
    note = notes_root / f"{captured} {safe_filename(title)}.md"
    if note.exists():
        expected_video_id = json.dumps(metadata["videoId"], ensure_ascii=False)
        existing_text = note.read_text(encoding="utf-8")
        if re.search(rf"(?m)^video_id:\s*{re.escape(expected_video_id)}\s*$", existing_text):
            return note
        note = notes_root / f"{captured} {safe_filename(title)} [{metadata['videoId']}].md"
        if note.exists():
            suffixed_text = note.read_text(encoding="utf-8")
            if not re.search(rf"(?m)^video_id:\s*{re.escape(expected_video_id)}\s*$", suffixed_text):
                raise RuntimeError("同名笔记路径已被其他视频占用")
            return note
    url = metadata["url"]
    content = "\n".join([
        "---",
        'kb_type: "video-note"',
        'kb_status: "raw"',
        'kb_owner: "human"',
        'source_type: "youtube"',
        f"source: {json.dumps(url, ensure_ascii=False)}",
        f"video_id: {json.dumps(metadata['videoId'], ensure_ascii=False)}",
        f"creator: {json.dumps(metadata.get('author') or '', ensure_ascii=False)}",
        f"captured: {json.dumps(captured, ensure_ascii=False)}",
        "kb_tags:",
        '  - "kb/video-note"',
        '  - "status/raw"',
        '  - "source/youtube"',
        "---",
        "",
        f"# {title}",
        "",
        "## 视频信息",
        "",
        f"- 频道：{metadata.get('author') or '未知'}",
        f"- 来源：[YouTube]({url})",
        "",
        "## 我的记录",
        "",
        RECORDS_START,
        "暂无观看记录。",
        RECORDS_END,
        "",
        "## 完整字幕",
        "",
        TRANSCRIPT_START,
        transcript_markdown(transcript, url),
        TRANSCRIPT_END,
        "",
    ])
    atomic_text(note, content)
    return note


def existing_note(vault: Path, metadata: dict | None) -> Path | None:
    if not metadata or not metadata.get("notePath"):
        return None
    try:
        note = note_from_metadata(vault, metadata)
    except RuntimeError:
        return None
    return note if note.exists() else None


def load_cached_transcript(vault: Path, video_id: str) -> tuple[Path | None, list[dict]]:
    """Return an existing transcript cache without downloading anything."""
    video_id = validate_video_id(video_id)
    metadata = load_metadata(vault, video_id)
    transcript_path = cache_dir(vault, video_id) / "transcript.json"
    if not metadata or not transcript_path.exists():
        return None, []
    try:
        transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, []
    if not isinstance(transcript, list) or not transcript:
        return None, []
    return existing_note(vault, metadata), transcript


def load_cached_records(vault: Path, video_id: str) -> list:
    path = cache_dir(vault, validate_video_id(video_id)) / "records.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return value if isinstance(value, list) else []


def fetch_transcript(vault: Path, video: dict) -> tuple[Path | None, list[dict]]:
    """Fetch and cache a transcript without creating a visible knowledge note."""
    video_id = validate_video_id(video.get("videoId", ""))
    cache = cache_dir(vault, video_id)
    transcript_path = cache / "transcript.json"
    metadata = load_metadata(vault, video_id)
    note, cached = load_cached_transcript(vault, video_id)
    if cached:
        return note, cached

    yt_dlp = shutil.which("yt-dlp")
    if not yt_dlp:
        raise RuntimeError("未找到 yt-dlp，请先安装或加入 PATH")
    url = video.get("url") or f"https://www.youtube.com/watch?v={video_id}"
    with tempfile.TemporaryDirectory(prefix="youtube-study-") as temp_name:
        output = str(Path(temp_name) / "%(id)s.%(ext)s")
        command = [
            yt_dlp, "--no-warnings", "--skip-download", "--write-subs", "--write-auto-subs",
            "--sub-langs", "all", "--sub-format", "json3", "--output", output, url,
        ]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=120)
        candidates = sorted(Path(temp_name).glob("*.json3"), key=subtitle_priority)
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "没有生成字幕文件").strip()[-800:]
            raise RuntimeError(f"yt-dlp 获取字幕失败：{detail}")
        if not candidates:
            raise RuntimeError("此视频没有可用的人工字幕或自动字幕")
        transcript = parse_json3(candidates[0])
    if not transcript:
        raise RuntimeError("字幕文件存在，但没有可用片段")

    previous_note_path = metadata.get("notePath") if metadata else None
    metadata = {
        "videoId": video_id,
        "title": video.get("title", ""),
        "author": video.get("author", ""),
        "url": url,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    if previous_note_path:
        metadata["notePath"] = previous_note_path
    atomic_json(cache / "metadata.json", metadata)
    atomic_json(transcript_path, transcript)
    return existing_note(vault, metadata), transcript


def save_study_note(vault: Path, video_id: str, records: list[dict]) -> Path:
    """Create the visible Markdown note only after an explicit user action."""
    video_id = validate_video_id(video_id)
    metadata = load_metadata(vault, video_id)
    transcript_path = cache_dir(vault, video_id) / "transcript.json"
    if not metadata or not transcript_path.exists():
        raise RuntimeError("尚未获取当前视频字幕，请先获取字幕")
    try:
        transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("字幕缓存损坏，请重新获取字幕") from error
    if not isinstance(transcript, list) or not transcript:
        raise RuntimeError("当前视频没有可保存的字幕")

    note = existing_note(vault, metadata) or create_note(vault, metadata, transcript)
    metadata["notePath"] = note.relative_to(vault).as_posix()
    atomic_json(cache_dir(vault, video_id) / "metadata.json", metadata)
    return sync_records(vault, video_id, records)


def sync_records(vault: Path, video_id: str, records: list[dict]) -> Path:
    metadata = load_metadata(vault, validate_video_id(video_id))
    if not metadata:
        raise RuntimeError("尚未保存当前视频，请先保存到知识库")
    note = note_from_metadata(vault, metadata)
    if not note.exists():
        raise RuntimeError("当前视频笔记不存在，请重新获取字幕")
    atomic_json(cache_dir(vault, video_id) / "records.json", records)
    screenshot_paths = materialize_record_screenshots(vault, video_id, records)
    text = note.read_text(encoding="utf-8")
    updated = replace_section(
        text,
        "我的记录",
        "完整字幕",
        RECORDS_START,
        RECORDS_END,
        records_markdown(records, screenshot_paths),
    )
    atomic_text(note, updated)
    cleanup_orphan_screenshots(vault, video_id, records)
    return note


def main() -> None:
    default_vault = Path(__file__).resolve().parents[4]
    parser = argparse.ArgumentParser(description="下载 YouTube 字幕进隐藏缓存；创建可见笔记只由扩展端在用户明确保存时完成")
    parser.add_argument("url", nargs="?")
    parser.add_argument("--vault", type=Path, default=default_vault)
    args = parser.parse_args()
    if not args.url:
        parser.error("需要 YouTube URL")
    vault = args.vault.resolve()
    parsed = urlparse(args.url)
    video_id = dict(part.split("=", 1) for part in parsed.query.split("&") if "=" in part).get("v", "")
    _, transcript = fetch_transcript(vault, {"videoId": video_id, "url": args.url, "title": video_id})
    print(json.dumps({"cacheDir": str(cache_dir(vault, video_id)), "segments": len(transcript)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
