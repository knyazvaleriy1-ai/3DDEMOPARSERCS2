"""Headless clip rendering: drive the web viewer in Chromium frame by frame.

The viewer exposes ``window.cs2render`` in render mode (``?render=1``). Every
frame is rendered deterministically (no real-time playback, so no dropped
frames even on a slow software renderer), returned as a JPEG and piped into
ffmpeg, which writes an H.264 MP4.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import socket
import threading
import time
import wave
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable

from . import storage
from .media import FrameEncoder, write_sidecar
from .parser import load_meta

log = logging.getLogger(__name__)

POV_MODES = ("first", "third", "overview")
# Whose voice chat goes into the clip (web/js/voice.js): everyone, the
# clip player's team, only them, one side, nobody.
VOICE_MODES = ("all", "team", "player", "T", "CT", "off")

ProgressFn = Callable[[float, str], None]


def pick_highlights(
    meta: dict[str, Any],
    clip_ids: list[str] | None = None,
    top: int | None = None,
    min_score: float | None = None,
    player: str | None = None,
) -> list[dict[str, Any]]:
    highlights = list(meta.get("highlights", []))
    if clip_ids:
        wanted = set(clip_ids)
        return [h for h in highlights if h["id"] in wanted]
    if player:
        needle = player.lower()
        highlights = [h for h in highlights if needle in h["playerName"].lower()]
    if min_score is not None:
        highlights = [h for h in highlights if h["score"] >= min_score]
    highlights.sort(key=lambda h: h["score"], reverse=True)
    if top:
        highlights = highlights[:top]
    highlights.sort(key=lambda h: h["start"])
    return highlights


def playwright_available() -> bool:
    try:
        import playwright.sync_api  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def _launch_args() -> list[str]:
    """Use the GPU when Chromium can, fall back to SwiftShader (CPU) otherwise.

    CS2DEMO_RENDER_GPU=0 forces software rendering.
    """
    if os.environ.get("CS2DEMO_RENDER_GPU") == "0":
        return ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    return ["--ignore-gpu-blocklist", "--enable-gpu", "--enable-unsafe-swiftshader"]


@contextmanager
def _viewer_page(demo_id: str, base_url: str, width: int, height: int, detail: str, progress: ProgressFn):
    """A headless Chromium page with the viewer loaded in render mode."""
    from playwright.sync_api import sync_playwright

    url = f"{base_url.rstrip('/')}/?demo={demo_id}&render=1"
    if detail in ("low", "high"):
        # auto: full materials on a GPU, simplified ones on software GL
        url += f"&quality={detail}"
    with sync_playwright() as pw:
        try:
            # CS2DEMO_CHROMIUM: use a specific Chromium/Chrome binary instead of
            # the one downloaded by `playwright install`.
            browser = pw.chromium.launch(
                args=_launch_args(), executable_path=os.environ.get("CS2DEMO_CHROMIUM") or None
            )
        except Exception as exc:
            raise RuntimeError(
                "Не удалось запустить Chromium. Выполните: python -m playwright install chromium"
                f" ({exc})"
            ) from exc
        try:
            page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
            console: list[str] = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
            page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))
            progress(0.01, "Загрузка просмотрщика")
            page.goto(url, wait_until="domcontentloaded")
            try:
                page.wait_for_function(
                    "() => window.cs2render && (window.cs2render.ready || window.cs2render.error)",
                    timeout=240_000,
                )
            except Exception as exc:
                raise RuntimeError("Просмотрщик не загрузился: " + "; ".join(console[-5:])) from exc
            error = page.evaluate("() => window.cs2render.error || null")
            if error:
                raise RuntimeError(f"Ошибка просмотрщика: {error}")
            yield page
        finally:
            browser.close()


def _write_sound(page: Any, parts: list[list[int]], fps: int, wav: Path) -> bool:
    """The current director's sound, part by part (per round for POV videos),
    into one WAV file. False when sound is off."""

    def part_sound(a: int, b: int) -> str | None:
        return page.evaluate("([a, b]) => window.cs2render.audioRange(a, b)", [a, b])

    first = part_sound(*parts[0])
    if first is None:
        return False
    with wave.open(str(wav), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(48000)
        for k, (a, b) in enumerate(parts):
            data = first if k == 0 else part_sound(a, b)
            if data is None:  # keep later parts in step
                out.writeframes(b"\0" * (round((b - a) / fps * 48000) * 4))
                continue
            with wave.open(io.BytesIO(base64.b64decode(data))) as part:
                if part.getnchannels() != 2 or part.getsampwidth() != 2 or part.getframerate() != 48000:
                    raise RuntimeError("неожиданный формат звука")
                out.writeframes(part.readframes(part.getnframes()))
    return True


def _encode(
    page: Any, dest: Path, info: dict[str, Any], fps: int, sound: bool, progress: Callable[[int, int, str], None]
) -> bool:
    """Pull every frame of the started director into an MP4; True if it has sound."""
    frames = int(info["frames"])
    parts = info.get("parts") or [[0, frames]]
    wav = dest.with_name(f".{dest.stem}.wav") if sound else None
    if wav is not None:
        progress(0, frames, "звук")
        if not _write_sound(page, parts, fps, wav):
            wav.unlink(missing_ok=True)
            wav = None
    encoder = FrameEncoder(dest, fps, audio=wav)
    try:
        batch = 4
        for i in range(0, frames, batch):
            chunk = page.evaluate("([a, b]) => window.cs2render.frames(a, b)", [i, min(i + batch, frames)])
            for data_url in chunk:
                encoder.write(base64.b64decode(data_url.split(",", 1)[1]))
            progress(min(i + batch, frames), frames, "")
        encoder.close()
    except BaseException:
        encoder.abort()
        raise
    finally:
        if wav:
            wav.unlink(missing_ok=True)
    page.evaluate("() => window.cs2render.end()")
    return wav is not None


def render_highlights(
    demo_id: str,
    highlights: list[dict[str, Any]],
    *,
    base_url: str,
    width: int = 1280,
    height: int = 720,
    fps: int = 30,
    pov: str = "first",
    slowmo: bool = False,
    hud: bool = True,
    sound: bool = True,
    keys: bool = False,
    voice: str = "team",
    quality: float = 0.9,
    detail: str = "auto",
    badge: str | None = None,
    match: str | None = None,
    suffix: str = "",
    progress: ProgressFn | None = None,
) -> list[dict[str, Any]]:
    """Render ``highlights`` of ``demo_id`` to MP4 files; returns clip records."""
    progress = progress or (lambda f, m: None)
    if pov not in POV_MODES:
        raise ValueError(f"pov must be one of {POV_MODES}")
    if voice not in VOICE_MODES:
        raise ValueError(f"voice must be one of {VOICE_MODES}")
    if not highlights:
        return []
    out_dir = storage.clips_dir(demo_id)
    results: list[dict[str, Any]] = []
    with _viewer_page(demo_id, base_url, width, height, detail, progress) as page:
        total = len(highlights)
        for n, h in enumerate(highlights):
            opts = {"pov": pov, "fps": fps, "slowmo": slowmo, "hud": hud, "sound": sound, "quality": quality,
                    "keys": keys, "voice": voice, "badge": badge, "match": match}
            info = page.evaluate("([id, opts]) => window.cs2render.begin(id, opts)", [h["id"], opts])
            dest = out_dir / f"{h['id']}-{pov}{suffix}.mp4"
            started = time.time()

            def step(done: int, frames: int, what: str, n=n, h=h) -> None:
                if what:
                    progress((n + 0.01) / total, f"Клип {n + 1}/{total}: {what}")
                else:
                    progress((n + done / frames) / total, f"Клип {n + 1}/{total}: {h['title']} — кадр {done}/{frames}")

            has_sound = _encode(page, dest, info, fps, sound, step)
            frames = int(info["frames"])
            record = {
                "highlight": h["id"],
                "title": h["title"],
                "player": h["playerName"],
                "round": h["round"],
                "score": h["score"],
                "tags": h.get("tags", []),
                "pov": pov,
                "width": width,
                "height": height,
                "fps": fps,
                "sound": has_sound,
                "slowmo": slowmo,
                "hud": hud,
                "keys": keys,
                "voice": voice if has_sound else "off",
                "detail": detail,
                "badge": badge,
                "match": match,
                "duration": round(frames / fps, 2),
                "renderSeconds": round(time.time() - started, 1),
                "source": "headless",
            }
            write_sidecar(dest, record)
            results.append({**record, "file": dest.name, "path": str(dest)})
            log.info("rendered %s (%d frames)", dest, frames)
    progress(1.0, f"Готово: {len(results)} клип(ов)")
    return results


def parse_rounds(spec: str | None) -> list[int] | None:
    """'1-12', '3,5,7-9' -> round numbers; None/'' -> every round."""
    if not spec:
        return None
    out: list[int] = []
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        a, _, b = part.partition("-")
        lo, hi = int(a), int(b or a)
        out.extend(range(min(lo, hi), max(lo, hi) + 1))
    return sorted(set(out))


def render_pov(
    demo_id: str,
    player: str,
    rounds: list[int] | None = None,
    *,
    base_url: str,
    width: int = 1280,
    height: int = 720,
    fps: int = 30,
    ff: int = 8,
    hud: bool = True,
    sound: bool = True,
    keys: bool = False,
    voice: str = "team",
    quality: float = 0.9,
    detail: str = "auto",
    progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """One MP4 of ``player``'s first-person view over ``rounds`` (all by
    default): normal speed while alive, the rest of the round ``ff`` times
    faster after their death (0 cuts it), freeze time skipped."""
    progress = progress or (lambda f, m: None)
    if voice not in VOICE_MODES:
        raise ValueError(f"voice must be one of {VOICE_MODES}")
    if ff not in (0, 4, 8, 16):
        raise ValueError("ff must be 0, 4, 8 or 16")
    out_dir = storage.clips_dir(demo_id)
    with _viewer_page(demo_id, base_url, width, height, detail, progress) as page:
        opts = {"fps": fps, "ff": ff, "hud": hud, "sound": sound, "keys": keys, "voice": voice, "quality": quality}
        info = page.evaluate(
            "([name, rounds, opts]) => window.cs2render.beginPov(name, rounds, opts)", [player, rounds or [], opts]
        )
        dest = out_dir / f"{info['file']}.mp4"
        started = time.time()
        title = info["info"]["title"]

        def step(done: int, frames: int, what: str) -> None:
            if what:
                progress(0.01, f"{title}: {what}")
            else:
                progress(done / frames, f"{title} — кадр {done}/{frames}")

        has_sound = _encode(page, dest, info, fps, sound, step)
    frames = int(info["frames"])
    record = {
        **{k: v for k, v in info["info"].items() if k not in ("codec", "audioCodec")},
        "pov": "pov",
        "sound": has_sound,
        "voice": voice if has_sound else "off",
        "keys": keys,
        "hud": hud,
        "detail": detail,
        "duration": round(frames / fps, 2),
        "renderSeconds": round(time.time() - started, 1),
        "source": "headless",
    }
    write_sidecar(dest, record)
    log.info("rendered %s (%d frames)", dest, frames)
    progress(1.0, "Готово")
    return {**record, "file": dest.name, "path": str(dest)}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class BackgroundServer:
    """Run the web app in a thread so the CLI can render without ``serve``."""

    def __init__(self, port: int | None = None):
        import uvicorn

        from .server import create_app

        self.port = port or _free_port()
        config = uvicorn.Config(create_app(), host="127.0.0.1", port=self.port, log_level="warning")
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self) -> "BackgroundServer":
        self.thread.start()
        deadline = time.time() + 20
        while not self.server.started:
            if time.time() > deadline:
                raise RuntimeError("web server did not start")
            time.sleep(0.05)
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)


def render_demo_cli(
    demo_id: str,
    *,
    top: int | None,
    min_score: float | None,
    player: str | None,
    clip_ids: list[str] | None,
    **render_opts: Any,
) -> list[dict[str, Any]]:
    meta = load_meta(storage.parsed_dir(demo_id))
    highlights = pick_highlights(meta, clip_ids=clip_ids, top=top, min_score=min_score, player=player)
    if not highlights:
        return []

    def progress(fraction: float, message: str) -> None:
        print(f"\r[{fraction * 100:5.1f}%] {message[:110]:<110}", end="", flush=True)

    with BackgroundServer() as srv:
        results = render_highlights(demo_id, highlights, base_url=srv.url, progress=progress, **render_opts)
    print()
    return results
