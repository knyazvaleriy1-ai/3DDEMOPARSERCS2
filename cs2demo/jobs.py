"""Background parse jobs shared by the web server and the CLI watcher."""

from __future__ import annotations

import gzip
import logging
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from . import storage
from .parser import DemoParseError, parse_demo, write_parsed

log = logging.getLogger(__name__)


class JobRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._parse_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="parse")
        self._render_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="render")

    # -- bookkeeping -------------------------------------------------------------

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(key)
            return dict(job) if job else None

    def all(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(j) for j in self._jobs.values()]

    def update(self, key: str, **fields: Any) -> None:
        with self._lock:
            job = self._jobs.setdefault(key, {"id": key})
            job.update(fields, updated=time.time())

    # -- parsing -----------------------------------------------------------------

    def submit_parse(self, demo_id: str, dem_path: Path, step: int | None = None):
        self.update(demo_id, kind="parse", status="queued", progress=0.0, message="В очереди")
        return self._parse_pool.submit(self._run_parse, demo_id, dem_path, step)

    def _run_parse(self, demo_id: str, dem_path: Path, step: int | None) -> dict[str, Any] | None:
        def progress(fraction: float, message: str) -> None:
            self.update(demo_id, status="parsing", progress=round(fraction, 3), message=message)

        try:
            meta = parse_and_store(demo_id, dem_path, step=step, progress=progress)
        except DemoParseError as exc:
            self.update(demo_id, status="error", message=str(exc))
            return None
        except Exception as exc:  # noqa: BLE001
            log.exception("parse failed for %s", demo_id)
            self.update(demo_id, status="error", message=f"Ошибка парсинга: {exc}")
            return None
        self.update(demo_id, status="ready", progress=1.0, message="Готово")
        return meta

    # -- rendering ---------------------------------------------------------------

    def submit_render(self, key: str, fn, *args, **kwargs):
        self.update(key, kind="render", status="queued", progress=0.0, message="В очереди")

        def run():
            def progress(fraction: float, message: str) -> None:
                self.update(key, status="rendering", progress=round(fraction, 3), message=message)

            try:
                result = fn(*args, progress=progress, **kwargs)
            except Exception as exc:  # noqa: BLE001
                log.exception("render failed")
                self.update(key, status="error", message=str(exc))
                return None
            self.update(key, status="done", progress=1.0, message="Готово", result=result)
            return result

        return self._render_pool.submit(run)


def parse_and_store(demo_id: str, dem_path: Path, step: int | None = None, progress=None) -> dict[str, Any]:
    meta, frames = parse_demo(dem_path, step=step, progress=progress)
    meta["id"] = demo_id
    meta["file"] = original_name(demo_id) or meta["file"]
    out = storage.parsed_dir(demo_id)
    write_parsed(meta, frames, out)
    with gzip.open(out / "frames.bin.gz.part", "wb", compresslevel=6) as fh:
        fh.write(frames)
    (out / "frames.bin.gz.part").replace(out / "frames.bin.gz")
    (out / "frames.bin").unlink(missing_ok=True)
    return meta


def import_demo(src: Path, display_name: str | None = None, move: bool = False) -> tuple[str, Path]:
    """Copy (or move) a demo into the data dir; returns (demo_id, stored_path)."""
    demo_id = storage.demo_id_for(src, display_name)
    dest = storage.demos_dir() / f"{demo_id}.dem"
    name_file = dest.with_suffix(".name")
    if not name_file.exists():
        name_file.write_text(f"{display_name or src.stem}.dem", encoding="utf-8")
    if not dest.exists():
        tmp = dest.with_suffix(".dem.part")
        if move:
            shutil.move(str(src), tmp)
        else:
            shutil.copyfile(src, tmp)
        tmp.replace(dest)
    elif move:
        src.unlink(missing_ok=True)
    return demo_id, dest


def original_name(demo_id: str) -> str | None:
    path = storage.demos_dir() / f"{demo_id}.name"
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def is_parsed(demo_id: str) -> bool:
    out = storage.parsed_dir(demo_id)
    return (out / "meta.json").exists() and (out / "frames.bin.gz").exists()
