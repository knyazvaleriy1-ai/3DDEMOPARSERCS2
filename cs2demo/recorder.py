"""Headless clip rendering: drive the web viewer in Chromium frame by frame.

The viewer exposes ``window.cs2render`` in render mode (``?render=1``). Every
frame is rendered deterministically (no real-time playback, so no dropped
frames even on a slow software renderer), returned as a JPEG and piped into
ffmpeg, which writes an H.264 MP4.
"""

from __future__ import annotations

import base64
import logging
import os
import socket
import threading
import time
from typing import Any, Callable

from . import storage
from .media import FrameEncoder, write_sidecar
from .parser import load_meta

log = logging.getLogger(__name__)

POV_MODES = ("first", "third", "overview")

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
    quality: float = 0.9,
    detail: str = "auto",
    badge: str | None = None,
    match: str | None = None,
    suffix: str = "",
    progress: ProgressFn | None = None,
) -> list[dict[str, Any]]:
    """Render ``highlights`` of ``demo_id`` to MP4 files; returns clip records."""
    from playwright.sync_api import sync_playwright

    progress = progress or (lambda f, m: None)
    if pov not in POV_MODES:
        raise ValueError(f"pov must be one of {POV_MODES}")
    if not highlights:
        return []
    out_dir = storage.clips_dir(demo_id)
    results: list[dict[str, Any]] = []
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

            total = len(highlights)
            for n, h in enumerate(highlights):
                opts = {"pov": pov, "fps": fps, "slowmo": slowmo, "hud": hud, "sound": sound, "quality": quality,
                        "badge": badge, "match": match}
                info = page.evaluate("([id, opts]) => window.cs2render.begin(id, opts)", [h["id"], opts])
                frames = int(info["frames"])
                dest = out_dir / f"{h['id']}-{pov}{suffix}.mp4"
                wav = None
                if sound:
                    progress((n + 0.01) / total, f"Клип {n + 1}/{total}: звук")
                    data = page.evaluate("() => window.cs2render.audio()")
                    if data:
                        wav = out_dir / f".{h['id']}-{pov}{suffix}.wav"
                        wav.write_bytes(base64.b64decode(data))
                encoder = FrameEncoder(dest, fps, audio=wav)
                started = time.time()
                try:
                    batch = 4
                    for i in range(0, frames, batch):
                        chunk = page.evaluate(
                            "([a, b]) => window.cs2render.frames(a, b)", [i, min(i + batch, frames)]
                        )
                        for data_url in chunk:
                            encoder.write(base64.b64decode(data_url.split(",", 1)[1]))
                        done = (n + min(i + batch, frames) / frames) / total
                        progress(done, f"Клип {n + 1}/{total}: {h['title']} — кадр {min(i + batch, frames)}/{frames}")
                    encoder.close()
                except BaseException:
                    encoder.abort()
                    raise
                finally:
                    if wav:
                        wav.unlink(missing_ok=True)
                page.evaluate("() => window.cs2render.end()")
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
                    "sound": bool(wav),
                    "slowmo": slowmo,
                    "hud": hud,
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
        finally:
            browser.close()
    progress(1.0, f"Готово: {len(results)} клип(ов)")
    return results


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
