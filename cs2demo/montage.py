"""Highlight montage: pick the best moments of one or more demos, render them
and cut everything into a single video (intro card, "#10 → #1" countdown,
cross-fades)."""

from __future__ import annotations

import base64
import json
import logging
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from . import storage
from .media import ffmpeg_exe, write_sidecar
from .parser import load_meta

log = logging.getLogger(__name__)

ProgressFn = Callable[[float, str], None]


def match_label(meta: dict[str, Any]) -> str:
    """"Team A vs Team B · map" from the players' clan tags (or side names)."""
    names = []
    for side, fallback in (("T", "T"), ("CT", "CT")):
        clans = [p.get("clan") for p in meta.get("players", []) if p.get("startSide") == side and p.get("clan")]
        names.append(max(set(clans), key=clans.count) if clans else fallback)
    return f"{names[0]} vs {names[1]} · {meta.get('map', '')}"


def select(
    metas: dict[str, dict[str, Any]],
    top: int = 10,
    include: list[str] | None = None,
    min_score: float | None = None,
    per_demo: int | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    """Best highlights across demos. ``include`` entries are substrings of
    highlight ids (e.g. ``clutch1v5``) that must be in the cut if present."""
    pool = [(d, h) for d, m in metas.items() for h in m.get("highlights", [])]
    if min_score is not None:
        pool = [x for x in pool if x[1]["score"] >= min_score]
    pool.sort(key=lambda x: (-x[1]["score"], x[1]["start"]))
    chosen: list[tuple[str, dict[str, Any]]] = []
    for needle in include or []:
        for x in pool:
            if needle.lower() in x[1]["id"] and x not in chosen:
                chosen.append(x)
    counts: dict[str, int] = {}
    for d, _h in chosen:
        counts[d] = counts.get(d, 0) + 1
    for x in pool:
        if len(chosen) >= top:
            break
        if x in chosen or (per_demo and counts.get(x[0], 0) >= per_demo):
            continue
        chosen.append(x)
        counts[x[0]] = counts.get(x[0], 0) + 1
    # Countdown: weakest first, the best moment closes the cut.
    chosen.sort(key=lambda x: (x[1]["score"], x[1]["start"]))
    return chosen[:top] if len(chosen) > top else chosen


_REUSE_KEYS = {"width": 1280, "height": 720, "fps": 30, "pov": "first", "slowmo": False, "hud": True, "detail": "auto"}


def _reusable(demo_id: str, h: dict[str, Any], badge: str, label: str, opts: dict[str, Any]) -> Path | None:
    """An already rendered montage clip with the same settings (so an
    interrupted montage resumes instead of starting over)."""
    path = storage.clips_dir(demo_id) / f"{h['id']}-{opts.get('pov', 'first')}-montage.mp4"
    try:
        side = json.loads(path.with_suffix(".json").read_text())
    except (OSError, ValueError):
        return None
    want = {k: opts.get(k, v) for k, v in _REUSE_KEYS.items()}
    want.update(badge=badge, match=label)
    if any(side.get(k) != v for k, v in want.items()):
        return None
    if side.get("sound") != bool(opts.get("sound", True)):
        return None
    return path


def _render_worker(base_url: str, queue: list, opts, progress: ProgressFn, results: dict, lock: threading.Lock) -> None:
    from .recorder import render_highlights

    while True:
        with lock:
            if not queue:
                return
            demo_id, h, badge, label = queue.pop(0)

        def prog(f: float, msg: str, _h=h) -> None:
            progress(f, f"{_h['title']}: {msg}")

        recs = render_highlights(
            demo_id, [h], base_url=base_url, progress=prog, badge=badge, match=label, suffix="-montage", **opts
        )
        with lock:
            results[(demo_id, h["id"])] = Path(recs[0]["path"])


def render_all(
    selection: list[tuple[str, dict[str, Any]]],
    metas: dict[str, dict[str, Any]],
    *,
    jobs: int = 1,
    progress: ProgressFn | None = None,
    **opts: Any,
) -> list[Path]:
    from .recorder import BackgroundServer

    progress = progress or (lambda f, m: None)
    n = len(selection)
    results: dict = {}
    queue = []
    for i, (d, h) in enumerate(selection):
        badge, label = f"#{n - i}", match_label(metas[d])
        done = _reusable(d, h, badge, label, opts)
        if done:
            log.info("reusing %s", done)
            results[(d, h["id"])] = done
        else:
            queue.append((d, h, badge, label))
    # Longest clips first; each worker takes the next one when it is free.
    queue.sort(key=lambda it: -it[1]["duration"])
    lock = threading.Lock()
    started = time.time()

    def worker_progress(f: float, msg: str) -> None:
        progress(min(0.95, (len(results) + f) / max(1, n) * 0.95), msg)

    if queue:
        with BackgroundServer() as srv:
            threads = [
                threading.Thread(target=_render_worker, args=(srv.url, queue, opts, worker_progress, results, lock),
                                 daemon=True)
                for _ in range(max(1, min(jobs, len(queue))))
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
    log.info("rendered %d clips in %.0fs", len(results), time.time() - started)
    missing = [h["id"] for d, h in selection if (d, h["id"]) not in results]
    if missing:
        raise RuntimeError(f"не удалось отрендерить: {', '.join(missing)}")
    return [results[(d, h["id"])] for d, h in selection]


def intro_card(dest: Path, width: int, height: int, title: str, lines: list[str], base_url: str) -> Path:
    """Render a title card JPEG with the viewer's fonts and styling."""
    from playwright.sync_api import sync_playwright

    from .recorder import _launch_args

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=_launch_args())
        try:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.goto(f"{base_url.rstrip('/')}/card.html", wait_until="load")
            data = page.evaluate("([t, l]) => window.drawCard(t, l)", [title, lines])
        finally:
            browser.close()
    dest.write_bytes(base64.b64decode(data.split(",", 1)[1]))
    return dest


def concat(clips: list[Path], dest: Path, intro: Path | None = None, intro_seconds: float = 3.0,
           fade: float = 0.35, fps: int = 30) -> Path:
    """Join clips (same size) into one H.264 + AAC file with fades between them."""
    exe = ffmpeg_exe()
    if not exe:
        raise RuntimeError("ffmpeg не найден")
    inputs: list[str] = []
    parts: list[tuple[int, float, bool]] = []  # (input index, duration, has audio)
    idx = 0
    if intro:
        inputs += ["-loop", "1", "-framerate", str(fps), "-t", f"{intro_seconds}", "-i", str(intro)]
        parts.append((idx, intro_seconds, False))
        idx += 1
    for clip in clips:
        inputs += ["-i", str(clip)]
        parts.append((idx, _duration(exe, clip), _has_audio(exe, clip)))
        idx += 1
    filters, labels = [], []
    width, height = _size(exe, clips[0])
    for i, (inp, dur, audio) in enumerate(parts):
        out_fade = max(0.0, dur - fade)
        filters.append(
            f"[{inp}:v]scale={width}:{height},setsar=1,fps={fps},format=yuv420p,"
            f"fade=t=in:st=0:d={fade},fade=t=out:st={out_fade:.3f}:d={fade}[v{i}]"
        )
        if audio:
            filters.append(f"[{inp}:a]aresample=48000,aformat=channel_layouts=stereo,"
                           f"afade=t=in:st=0:d={fade},afade=t=out:st={out_fade:.3f}:d={fade},"
                           f"apad,atrim=0:{dur:.3f}[a{i}]")
        else:
            filters.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{dur:.3f}[a{i}]")
        labels.append(f"[v{i}][a{i}]")
    filters.append(f"{''.join(labels)}concat=n={len(parts)}:v=1:a=1[v][a]")
    tmp = dest.with_name(dest.stem + ".part.mp4")
    cmd = [
        exe, "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filters),
        "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(tmp),
    ]  # fmt: skip
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg: {proc.stderr.strip()[-600:]}")
    tmp.replace(dest)
    return dest


def _probe(exe: str, path: Path) -> str:
    return subprocess.run([exe, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr


def _duration(exe: str, path: Path) -> float:
    import re

    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", _probe(exe, path))
    if not m:
        raise RuntimeError(f"не удалось определить длительность {path}")
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def _has_audio(exe: str, path: Path) -> bool:
    return "Audio:" in _probe(exe, path)


def _size(exe: str, path: Path) -> tuple[int, int]:
    import re

    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", _probe(exe, path))
    return (int(m.group(1)), int(m.group(2))) if m else (1280, 720)


def make_montage(
    demo_ids: list[str],
    out: Path | None = None,
    *,
    top: int = 10,
    include: list[str] | None = None,
    min_score: float | None = None,
    per_demo: int | None = None,
    title: str = "CS2 хайлайты",
    jobs: int = 1,
    progress: ProgressFn | None = None,
    **render_opts: Any,
) -> dict[str, Any]:
    progress = progress or (lambda f, m: None)
    metas = {d: load_meta(storage.parsed_dir(d)) for d in demo_ids}
    selection = select(metas, top=top, include=include, min_score=min_score, per_demo=per_demo)
    if not selection:
        raise RuntimeError("нет подходящих хайлайтов")
    for needle in include or []:
        if not any(needle.lower() in h["id"] for _d, h in selection):
            log.warning("no highlight matching %r in these demos", needle)
    clips = render_all(selection, metas, jobs=jobs, progress=progress, **render_opts)

    out_dir = storage.clips_dir("montages")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = out or out_dir / f"montage-{stamp}.mp4"
    progress(0.96, "Титульная карточка")
    width, height = render_opts.get("width", 1280), render_opts.get("height", 720)
    with tempfile.TemporaryDirectory() as tmp:
        from .recorder import BackgroundServer

        with BackgroundServer() as srv:
            matches = sorted({match_label(metas[d]) for d, _h in selection})
            card = intro_card(Path(tmp) / "intro.jpg", width, height, title,
                              [*matches, f"{len(selection)} лучших моментов"], srv.url)
        progress(0.97, "Склейка")
        concat(clips, out, intro=card, fps=render_opts.get("fps", 30))
    record = {
        "title": title,
        "montage": True,
        "clips": [{"demo": d, "highlight": h["id"], "title": h["title"], "score": h["score"]} for d, h in selection],
        "width": width,
        "height": height,
        "fps": render_opts.get("fps", 30),
        "pov": render_opts.get("pov", "first"),
        "duration": round(_duration(ffmpeg_exe(), out), 2),
        "source": "montage",
    }
    write_sidecar(out, record)
    progress(1.0, f"Готово: {out}")
    return {**record, "path": str(out)}

