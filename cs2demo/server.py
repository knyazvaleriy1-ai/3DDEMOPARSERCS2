"""FastAPI web server: demo library, parsed data, map assets and the clip library."""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, archives, faceit, maps, media, models, storage
from .highlights import DEFAULTS as HIGHLIGHT_DEFAULTS
from .highlights import detect_highlights
from .jobs import JobRegistry, import_demo, is_parsed
from .parser import load_meta
from .recorder import POV_MODES, VOICE_MODES, pick_highlights, playwright_available, render_highlights, render_pov

log = logging.getLogger(__name__)

WEB_DIR = Path(__file__).parent / "web"
_meta_lock = threading.Lock()


class MontageRequest(BaseModel):
    clips: list[dict[str, str]]  # [{"demo": id, "file": name.mp4}], in playback order
    title: str = "CS2 хайлайты"


def _montage_job(paths: list[Path], title: str, base_url: str, progress=None) -> dict[str, Any]:
    import tempfile
    import time

    from .montage import concat, intro_card

    progress = progress or (lambda f, m: None)
    out = storage.clips_dir("montages") / f"montage-{time.strftime('%Y%m%d-%H%M%S')}.mp4"
    with tempfile.TemporaryDirectory() as tmp:
        card = None
        if playwright_available():
            progress(0.1, "Титульная карточка")
            try:
                from .montage import _size

                width, height = _size(media.ffmpeg_exe(), paths[0])
                card = intro_card(Path(tmp) / "intro.jpg", width, height, title, [f"{len(paths)} моментов"], base_url)
            except Exception as exc:  # noqa: BLE001 - the card is optional
                log.warning("intro card failed: %s", exc)
        progress(0.3, "Склейка")
        concat(paths, out, intro=card)
    record = {"title": title, "montage": True, "clips": [p.name for p in paths], "source": "montage"}
    media.write_sidecar(out, record)
    return {**record, "file": out.name, "url": f"/clips/montages/{out.name}"}


class HighlightOptions(BaseModel):
    pre: float | None = None
    post: float | None = None
    max_gap: float | None = None
    max_span: float | None = None
    max_clip: float | None = None
    min_score: float | None = None
    save: bool = False


class RenderRequest(BaseModel):
    clips: list[str] | None = None
    top: int | None = None
    min_score: float | None = None
    player: str | None = None
    pov: str = "first"
    width: int = 1280
    height: int = 720
    fps: int = 30
    slowmo: bool = False
    hud: bool = True
    sound: bool = True
    keys: bool = False
    voice: str = "team"
    quality: str = "auto"


class FaceitRequest(BaseModel):
    url: str


class PovRequest(BaseModel):
    player: str
    rounds: list[int] | None = None
    ff: int = 8
    width: int = 1280
    height: int = 720
    fps: int = 30
    hud: bool = True
    sound: bool = True
    keys: bool = False
    voice: str = "team"
    quality: str = "auto"


def _check_id(demo_id: str) -> str:
    if not storage.is_valid_id(demo_id):
        raise HTTPException(400, "Некорректный id демо")
    return demo_id


def _summary(demo_id: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    meta = meta or load_meta(storage.parsed_dir(demo_id))
    rounds = meta.get("rounds", [])
    # Teams are identified by the side they started on (sides swap at half).
    teams = []
    last = meta["scoreboard"][-1]["stats"] if meta.get("scoreboard") else []
    for side, fallback in (("T", "Команда 1"), ("CT", "Команда 2")):
        members = [i for i, p in enumerate(meta.get("players", [])) if p.get("startSide") == side]
        clans = [meta["players"][i].get("clan") for i in members if meta["players"][i].get("clan")]
        score = max((last[i][4] for i in members if i < len(last) and last[i]), default=0)
        teams.append({"name": clans[0] if clans else fallback, "score": score})
    return {
        "id": demo_id,
        "status": "ready",
        "file": meta.get("file"),
        "map": meta.get("map"),
        "rounds": len(rounds),
        "players": [p["name"] for p in meta.get("players", [])],
        "kills": len(meta.get("kills", [])),
        "highlights": len(meta.get("highlights", [])),
        "parsedAt": meta.get("parsedAt"),
        "duration": round(
            (meta["frames"]["endTick"] - meta["frames"]["startTick"]) / float(meta.get("tickRate") or 64), 1
        ),
        "teams": teams,
    }


def create_app() -> FastAPI:
    # Module scripts and WebAssembly need these exact types; Python's table
    # comes from the Windows registry, where .js is often text/plain and .mjs
    # missing, and browsers then refuse to run the file.
    for ext, mime in ((".js", "text/javascript"), (".mjs", "text/javascript"), (".wasm", "application/wasm")):
        mimetypes.add_type(mime, ext)
    app = FastAPI(title="CS2 3D Demo Viewer", version=__version__)
    app.add_middleware(GZipMiddleware, minimum_size=2048)
    jobs = JobRegistry()
    app.state.jobs = jobs

    # -- status ------------------------------------------------------------------

    @app.get("/api/status")
    def status() -> dict[str, Any]:
        return {
            "version": __version__,
            "data": str(storage.data_root()),
            "ffmpeg": media.ffmpeg_exe() is not None,
            "headlessRender": playwright_available(),
            "povModes": list(POV_MODES),
            "highlightDefaults": HIGHLIGHT_DEFAULTS,
        }

    # -- demos -------------------------------------------------------------------

    @app.get("/api/demos")
    def list_demos() -> list[dict[str, Any]]:
        out = []
        seen = set()
        for d in sorted(storage.parsed_dir().iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if d.is_dir() and is_parsed(d.name):
                try:
                    out.append(_summary(d.name))
                    seen.add(d.name)
                except Exception as exc:  # noqa: BLE001
                    out.append({"id": d.name, "status": "error", "message": str(exc)})
                    seen.add(d.name)
        for job in jobs.all():
            if job.get("kind") == "parse" and job["id"] not in seen and job.get("status") != "ready":
                out.insert(0, {"id": job["id"], "status": job["status"], "progress": job.get("progress"),
                               "message": job.get("message"), "file": job.get("file")})
        return out

    @app.post("/api/demos")
    async def upload_demo(file: UploadFile = File(...)) -> dict[str, Any]:
        name = Path(file.filename or "demo.dem").name
        packed = archives.is_compressed(Path(name))
        if not (name.lower().endswith(".dem") or packed):
            raise HTTPException(400, "Нужен файл .dem или .dem.zst (FACEIT)")
        tmpdir = Path(tempfile.mkdtemp(dir=storage.demos_dir()))
        try:
            tmp = tmpdir / ("upload" + "".join(Path(name).suffixes[-2:]) if packed else "upload.dem")
            with tmp.open("wb") as out:
                shutil.copyfileobj(file.file, out, 1 << 20)
            if packed:
                try:
                    tmp = await asyncio.to_thread(archives.decompress_demo, tmp, tmpdir / "out")
                except archives.ArchiveError as exc:
                    raise HTTPException(400, str(exc)) from exc
            with tmp.open("rb") as fh:
                magic = fh.read(8)
            if not magic.startswith(b"PBDEMS2"):
                raise HTTPException(400, "Это не демо CS2 (ожидается сигнатура PBDEMS2)")
            demo_id, dem_path = import_demo(tmp, Path(archives.demo_name(name)).stem, move=True)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
        if is_parsed(demo_id):
            return {"id": demo_id, "status": "ready"}
        jobs.submit_parse(demo_id, dem_path)
        jobs.update(demo_id, file=name)
        return {"id": demo_id, "status": "queued"}

    @app.get("/api/faceit")
    def faceit_status() -> dict[str, Any]:
        """Whether matches can be downloaded by FACEIT link (a key is set)."""
        return {"configured": faceit.configured()}

    @app.post("/api/faceit")
    def faceit_download(req: FaceitRequest) -> dict[str, Any]:
        """Download and parse the demo of a FACEIT match (link or id) in the background:
        poll /api/jobs/{job}; its result has the demo ids."""
        mid = faceit.match_id(req.url)
        if not mid:
            raise HTTPException(400, "Не похоже на ссылку на матч FACEIT")
        if not faceit.configured():
            raise HTTPException(501, "На сервере не задан ключ FACEIT API (переменная FACEIT_API_KEY)")
        key = f"faceit-{mid}"
        current = jobs.get(key)
        if current and current.get("status") in ("queued", "downloading"):
            return {"job": key}
        jobs.submit_download(key, _faceit_import, req.url)
        return {"job": key}

    def _faceit_import(link: str, progress) -> dict[str, Any]:
        tmpdir = Path(tempfile.mkdtemp(dir=storage.demos_dir()))
        try:
            info, demos = faceit.download(link, tmpdir, progress=progress)
            ids = []
            for dem in demos:
                demo_id, dem_path = import_demo(dem, dem.stem, move=True)
                if not is_parsed(demo_id):
                    jobs.submit_parse(demo_id, dem_path)
                    jobs.update(demo_id, file=dem.name)
                ids.append(demo_id)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
        return {"match": info, "ids": ids}

    @app.get("/api/demos/{demo_id}")
    def demo_status(demo_id: str) -> dict[str, Any]:
        _check_id(demo_id)
        job = jobs.get(demo_id)
        if job and job.get("status") not in ("ready", None):
            return job
        if is_parsed(demo_id):
            return _summary(demo_id)
        raise HTTPException(404, "Демо не найдено")

    @app.post("/api/demos/{demo_id}/reparse")
    def reparse(demo_id: str) -> dict[str, Any]:
        _check_id(demo_id)
        dem = storage.demos_dir() / f"{demo_id}.dem"
        if not dem.exists():
            raise HTTPException(404, "Исходный .dem не найден")
        jobs.submit_parse(demo_id, dem)
        return {"id": demo_id, "status": "queued"}

    @app.delete("/api/demos/{demo_id}")
    def delete_demo(demo_id: str, clips: bool = False) -> dict[str, Any]:
        _check_id(demo_id)
        shutil.rmtree(storage.parsed_dir(demo_id), ignore_errors=True)
        (storage.demos_dir() / f"{demo_id}.dem").unlink(missing_ok=True)
        (storage.demos_dir() / f"{demo_id}.name").unlink(missing_ok=True)
        if clips:
            shutil.rmtree(storage.clips_dir() / demo_id, ignore_errors=True)
        return {"deleted": demo_id}

    @app.get("/api/demos/{demo_id}/meta")
    def demo_meta(demo_id: str) -> FileResponse:
        _check_id(demo_id)
        path = storage.parsed_dir(demo_id) / "meta.json"
        if not path.exists():
            raise HTTPException(404, "Демо ещё не разобрано")
        return FileResponse(path, media_type="application/json", headers={"Cache-Control": "no-cache"})

    @app.get("/api/demos/{demo_id}/frames")
    def demo_frames(demo_id: str, request: Request) -> Response:
        _check_id(demo_id)
        path = storage.parsed_dir(demo_id) / "frames.bin.gz"
        if not path.exists():
            raise HTTPException(404, "Демо ещё не разобрано")
        if "gzip" in request.headers.get("accept-encoding", ""):
            return FileResponse(
                path,
                media_type="application/octet-stream",
                headers={"Content-Encoding": "gzip", "Cache-Control": "no-cache"},
            )
        import gzip

        return Response(gzip.decompress(path.read_bytes()), media_type="application/octet-stream")

    @app.post("/api/demos/{demo_id}/highlights")
    def recompute_highlights(demo_id: str, options: HighlightOptions) -> list[dict[str, Any]]:
        _check_id(demo_id)
        out_dir = storage.parsed_dir(demo_id)
        if not (out_dir / "meta.json").exists():
            raise HTTPException(404, "Демо ещё не разобрано")
        with _meta_lock:
            meta = load_meta(out_dir)
            opts = options.model_dump(exclude={"save"}, exclude_none=True)
            highlights = detect_highlights(meta, **opts)
            if options.save:
                meta["highlights"] = highlights
                tmp = out_dir / "meta.json.part"
                tmp.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                tmp.replace(out_dir / "meta.json")
        return highlights

    # -- maps --------------------------------------------------------------------

    def _map_name(name: str) -> str:
        if not maps.valid_map_name(name):
            raise HTTPException(400, "Некорректное имя карты")
        return name

    @app.get("/api/maps/{name}/info")
    def map_info(name: str) -> dict[str, Any]:
        return maps.map_info(_map_name(name))

    @app.get("/api/maps/{name}/mesh")
    def map_mesh(name: str) -> FileResponse:
        try:
            path = maps.mesh_path(_map_name(name))
        except FileNotFoundError as exc:
            raise HTTPException(404, f"Нет 3D-геометрии для карты {name}") from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"Не удалось скачать геометрию карты: {exc}") from exc
        return FileResponse(path, media_type="application/octet-stream",
                            headers={"Cache-Control": "max-age=86400"})

    @app.get("/api/maps/{name}/radar")
    def map_radar(name: str, lower: bool = False) -> FileResponse:
        try:
            path = maps.radar_path(_map_name(name), lower=lower)
        except FileNotFoundError as exc:
            raise HTTPException(404, "Нет радара для карты") from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"Не удалось скачать радар: {exc}") from exc
        return FileResponse(path, media_type="image/png", headers={"Cache-Control": "max-age=86400"})

    # -- sounds -------------------------------------------------------------------

    @app.get("/api/sounds")
    def sounds() -> list[dict[str, str]]:
        return media.list_sounds()

    # -- player models -----------------------------------------------------------

    @app.get("/api/models")
    def model_info() -> dict[str, Any]:
        return models.info()

    @app.get("/api/models/file/{name}")
    def model_file(name: str) -> FileResponse:
        if not storage.is_valid_id(name) or not name.endswith(".glb"):
            raise HTTPException(400, "Некорректное имя модели")
        path = models.models_dir() / name
        if not path.is_file():
            raise HTTPException(404, "Модель не найдена")
        return FileResponse(path, media_type="model/gltf-binary", headers={"Cache-Control": "no-cache"})

    # -- clips -------------------------------------------------------------------

    @app.get("/api/clips")
    def clips(demo: str | None = None) -> list[dict[str, Any]]:
        if demo:
            _check_id(demo)
        return media.list_clips(demo)

    @app.post("/api/demos/{demo_id}/clips")
    async def upload_clip(
        demo_id: str,
        background: BackgroundTasks,
        file: UploadFile = File(...),
        name: str = Form(...),
        info: str = Form("{}"),
    ) -> dict[str, Any]:
        """Store a clip recorded in the browser (WebCodecs MP4 or MediaRecorder WebM)."""
        _check_id(demo_id)
        if not storage.is_valid_id(name):
            raise HTTPException(400, "Некорректное имя клипа")
        ext = ".mp4" if (file.content_type or "").startswith("video/mp4") else ".webm"
        out_dir = storage.clips_dir(demo_id)
        dest = out_dir / f"{name}{ext}"
        with dest.open("wb") as out:
            shutil.copyfileobj(file.file, out, 1 << 20)
        try:
            record = json.loads(info)
            if not isinstance(record, dict):
                record = {}
        except ValueError:
            record = {}
        record["source"] = "browser"
        media.write_sidecar(dest, record)

        # WebM (MediaRecorder), VP9-in-MP4 (WebCodecs fallback) and Opus audio are
        # converted to H.264 + AAC so the clips play anywhere and upload to any site.
        video_ok = ext == ".mp4" and record.get("codec") in (None, "avc")
        audio_ok = record.get("audioCodec") in (None, "aac")
        if not (video_ok and audio_ok) and media.ffmpeg_exe():
            def convert() -> None:
                src = dest
                if dest.suffix == ".mp4":  # VP9 in MP4: move aside, re-encode in place
                    src = dest.with_name(dest.stem + ".src.mp4")
                    dest.replace(src)
                mp4 = dest.with_suffix(".mp4")
                if media.transcode_to_mp4(src, mp4, copy_video=video_ok):
                    media.write_sidecar(mp4, {**record, "codec": "avc", "audioCodec": "aac"})
                    src.unlink(missing_ok=True)
                elif src != dest:
                    src.replace(dest)

            background.add_task(convert)
        return {"saved": dest.name, "url": f"/clips/{demo_id}/{dest.name}"}

    @app.delete("/api/clips/{demo_id}/{file_name}")
    def delete_clip(demo_id: str, file_name: str) -> dict[str, Any]:
        _check_id(demo_id)
        if not storage.is_valid_id(file_name) or Path(file_name).suffix not in media.VIDEO_EXTS:
            raise HTTPException(400, "Некорректное имя файла")
        path = storage.clips_dir(demo_id) / file_name
        path.unlink(missing_ok=True)
        path.with_suffix(".json").unlink(missing_ok=True)
        return {"deleted": file_name}

    @app.post("/api/demos/{demo_id}/render")
    def render(demo_id: str, req: RenderRequest, request: Request) -> dict[str, Any]:
        """Server-side headless render of highlights to MP4 (needs Playwright)."""
        _check_id(demo_id)
        if not playwright_available():
            raise HTTPException(
                501,
                "Рендер на сервере недоступен: pip install playwright && python -m playwright install chromium",
            )
        if req.pov not in POV_MODES:
            raise HTTPException(400, f"pov: {', '.join(POV_MODES)}")
        if not is_parsed(demo_id):
            raise HTTPException(404, "Демо ещё не разобрано")
        meta = load_meta(storage.parsed_dir(demo_id))
        chosen = pick_highlights(meta, req.clips, req.top, req.min_score, req.player)
        if not chosen:
            raise HTTPException(400, "Нет подходящих хайлайтов")
        key = f"render-{demo_id}"
        current = jobs.get(key)
        if current and current.get("status") in ("queued", "rendering"):
            raise HTTPException(409, "Рендер этого демо уже идёт")
        base_url = str(request.base_url)
        jobs.submit_render(
            key,
            render_highlights,
            demo_id,
            chosen,
            base_url=base_url,
            width=max(320, min(req.width, 3840)),
            height=max(240, min(req.height, 2160)),
            fps=max(10, min(req.fps, 120)),
            pov=req.pov,
            slowmo=req.slowmo,
            hud=req.hud,
            sound=req.sound,
            keys=req.keys,
            voice=req.voice if req.voice in VOICE_MODES else "team",
            detail=req.quality if req.quality in ("auto", "low", "high") else "auto",
        )
        return {"job": key, "clips": [h["id"] for h in chosen]}

    @app.post("/api/demos/{demo_id}/render-pov")
    def render_pov_job(demo_id: str, req: PovRequest, request: Request) -> dict[str, Any]:
        """Server-side headless render of a player's POV over rounds (one MP4)."""
        _check_id(demo_id)
        if not playwright_available():
            raise HTTPException(
                501,
                "Рендер на сервере недоступен: pip install playwright && python -m playwright install chromium",
            )
        if not is_parsed(demo_id):
            raise HTTPException(404, "Демо ещё не разобрано")
        if req.ff not in (0, 4, 8, 16):
            raise HTTPException(400, "ff: 0, 4, 8 или 16")
        meta = load_meta(storage.parsed_dir(demo_id))
        if not any(p["name"].lower() == req.player.lower() for p in meta["players"]):
            raise HTTPException(400, f"Нет игрока {req.player}")
        key = f"render-{demo_id}"
        current = jobs.get(key)
        if current and current.get("status") in ("queued", "rendering"):
            raise HTTPException(409, "Рендер этого демо уже идёт")
        jobs.submit_render(
            key,
            render_pov,
            demo_id,
            req.player,
            req.rounds,
            base_url=str(request.base_url),
            width=max(320, min(req.width, 3840)),
            height=max(240, min(req.height, 2160)),
            fps=max(10, min(req.fps, 120)),
            ff=req.ff,
            hud=req.hud,
            sound=req.sound,
            keys=req.keys,
            voice=req.voice if req.voice in VOICE_MODES else "team",
            detail=req.quality if req.quality in ("auto", "low", "high") else "auto",
        )
        return {"job": key}

    @app.post("/api/montage")
    def montage(req: MontageRequest, request: Request) -> dict[str, Any]:
        """Join already recorded clips into one video (intro card + fades)."""
        if not media.ffmpeg_exe():
            raise HTTPException(501, "Нужен ffmpeg")
        paths = []
        for c in req.clips:
            demo, name = c.get("demo", ""), c.get("file", "")
            if not storage.is_valid_id(demo) or not storage.is_valid_id(name) or Path(name).suffix not in media.VIDEO_EXTS:
                raise HTTPException(400, f"Некорректный клип: {demo}/{name}")
            path = storage.clips_dir() / demo / name
            if not path.is_file():
                raise HTTPException(404, f"Нет клипа {demo}/{name}")
            paths.append(path)
        if len(paths) < 2:
            raise HTTPException(400, "Выберите хотя бы два клипа")
        current = jobs.get("montage")
        if current and current.get("status") in ("queued", "rendering"):
            raise HTTPException(409, "Нарезка уже собирается")
        jobs.submit_render("montage", _montage_job, paths, req.title.strip()[:60] or "CS2 хайлайты", str(request.base_url))
        return {"job": "montage", "clips": len(paths)}

    @app.get("/api/jobs/{key}")
    def job(key: str) -> dict[str, Any]:
        found = jobs.get(key)
        if not found:
            raise HTTPException(404, "Нет такой задачи")
        return found

    @app.exception_handler(maps.MapAssetError)
    async def map_error(_request: Request, exc: maps.MapAssetError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=400)

    app.mount("/clips", StaticFiles(directory=storage.clips_dir()), name="clips")
    sounds_dir = storage.data_root() / "sounds"
    sounds_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/sounds", StaticFiles(directory=sounds_dir), name="sounds")
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app
