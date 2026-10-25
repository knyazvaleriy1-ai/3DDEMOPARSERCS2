"""ffmpeg helpers and the on-disk clip library."""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from . import storage

VIDEO_EXTS = (".mp4", ".webm", ".mkv")
AUDIO_EXTS = (".wav", ".mp3", ".ogg", ".flac", ".m4a")


def ffmpeg_exe() -> str | None:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return None


def transcode_to_mp4(src: Path, dest: Path, copy_video: bool = False) -> bool:
    """Re-encode to H.264 + AAC MP4 (``copy_video`` keeps an H.264 stream as is)."""
    exe = ffmpeg_exe()
    if not exe:
        return False
    tmp = dest.with_name(dest.stem + ".part.mp4")
    video = ["-c:v", "copy"] if copy_video else [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ]  # fmt: skip
    cmd = [
        exe, "-y", "-loglevel", "error", "-i", str(src), *video,
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(tmp),
    ]  # fmt: skip
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        return False
    tmp.replace(dest)
    return True


class FrameEncoder:
    """Pipes JPEG frames into ffmpeg and writes an H.264 MP4."""

    def __init__(self, dest: Path, fps: int, crf: int = 20, audio: Path | None = None):
        exe = ffmpeg_exe()
        if not exe:
            raise RuntimeError("ffmpeg не найден: установите ffmpeg или пакет imageio-ffmpeg")
        self.dest = dest
        self.tmp = dest.with_name(dest.stem + ".part.mp4")
        audio_in = ["-i", str(audio)] if audio else []
        audio_out = ["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "160k", "-shortest"] if audio else []
        cmd = [
            exe, "-y", "-loglevel", "error",
            "-f", "image2pipe", "-framerate", str(fps), "-c:v", "mjpeg", "-i", "-", *audio_in,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", *audio_out,
            "-movflags", "+faststart", str(self.tmp),
        ]  # fmt: skip
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def write(self, jpeg: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(jpeg)

    def close(self) -> Path:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        err = self.proc.stderr.read().decode(errors="replace") if self.proc.stderr else ""
        code = self.proc.wait()
        if code != 0 or not self.tmp.exists():
            self.tmp.unlink(missing_ok=True)
            raise RuntimeError(f"ffmpeg завершился с ошибкой {code}: {err.strip()[:400]}")
        self.tmp.replace(self.dest)
        return self.dest

    def abort(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        self.proc.kill()
        self.tmp.unlink(missing_ok=True)


def write_sidecar(video: Path, info: dict[str, Any]) -> None:
    data = {**info, "file": video.name, "created": int(time.time())}
    video.with_suffix(".json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def list_clips(demo_id: str | None = None) -> list[dict[str, Any]]:
    root = storage.clips_dir()
    dirs = [root / demo_id] if demo_id else [p for p in root.iterdir() if p.is_dir()]
    out = []
    for d in dirs:
        if not d.is_dir():
            continue
        for video in sorted(d.iterdir()):
            if video.suffix not in VIDEO_EXTS or ".part" in video.name or ".src." in video.name:
                continue
            sidecar = video.with_suffix(".json")
            info: dict[str, Any] = {}
            if sidecar.exists():
                try:
                    info = json.loads(sidecar.read_text(encoding="utf-8"))
                except ValueError:
                    info = {}
            stat = video.stat()
            out.append(
                {
                    **info,
                    "demo": d.name,
                    "file": video.name,
                    "url": f"/clips/{d.name}/{video.name}",
                    "size": stat.st_size,
                    "created": info.get("created") or int(stat.st_mtime),
                }
            )
    out.sort(key=lambda c: c["created"], reverse=True)
    return out


def list_sounds() -> list[dict[str, str]]:
    """User sound overrides in <data>/sounds (file stem = sound name)."""
    root = storage.data_root() / "sounds"
    if not root.is_dir():
        return []
    return [
        {"name": p.stem.lower(), "file": p.name, "url": f"/sounds/{p.name}"}
        for p in sorted(root.iterdir())
        if p.suffix.lower() in AUDIO_EXTS and storage.is_valid_id(p.name.lower())
    ]
