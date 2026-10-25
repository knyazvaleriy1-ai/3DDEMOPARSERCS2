"""Map assets for the 3D view, fetched on demand from the ``awpy-data`` releases.

* ``<map>.mesh`` – collision geometry (``AWMH`` format: magic, version, vertex
  count, triangle count, float32 xyz vertices, uint32 triangle indices),
* ``radars/<map>.png`` (+ ``_lower`` for multi-level maps) – overview images,
* ``map_data.json`` – world → radar transform per map.

The assets belong to Valve; they are downloaded to the local data directory and
never committed. Geometry lives in one large zip per release, so a single map's
mesh is pulled out with HTTP range requests when the server supports them.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

from .storage import maps_dir

log = logging.getLogger(__name__)

DATA_REPO = "pnxenopoulos/awpy-data"
FALLBACK_VERSION = "2000935"
DOWNLOAD_URL = "https://github.com/{repo}/releases/download/{version}/{name}"
LATEST_API = "https://api.github.com/repos/{repo}/releases/latest"
USER_AGENT = "cs2demo-viewer"
TIMEOUT = 60

_MAP_RE = re.compile(r"^[a-z0-9_]{2,64}$")
_lock = threading.Lock()
_version_cache: str | None = None


class MapAssetError(RuntimeError):
    pass


def valid_map_name(name: str) -> bool:
    return bool(_MAP_RE.match(name))


def _request(url: str, headers: dict[str, str] | None = None):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    return urllib.request.urlopen(req, timeout=TIMEOUT)  # noqa: S310 - fixed https hosts


def _local_versions() -> list[str]:
    root = maps_dir()
    versions = [p.name for p in root.iterdir() if p.is_dir() and p.name.isdigit()]
    return sorted(versions, key=int)


def resolve_version(online: bool = True) -> str:
    """Pinned via CS2DEMO_MAPDATA_VERSION, else newest cached, else latest release."""
    global _version_cache
    env = os.environ.get("CS2DEMO_MAPDATA_VERSION")
    if env:
        return env
    if _version_cache:
        return _version_cache
    local = _local_versions()
    if local:
        _version_cache = local[-1]
        return _version_cache
    if online:
        try:
            with _request(
                LATEST_API.format(repo=DATA_REPO), {"Accept": "application/vnd.github+json"}
            ) as resp:
                tag = json.load(resp).get("tag_name")
            if tag:
                _version_cache = str(tag)
                return _version_cache
        except Exception as exc:  # noqa: BLE001
            log.info("latest awpy-data release lookup failed (%s); using %s", exc, FALLBACK_VERSION)
    _version_cache = FALLBACK_VERSION
    return _version_cache


def version_dir(version: str | None = None) -> Path:
    path = maps_dir() / (version or resolve_version())
    path.mkdir(parents=True, exist_ok=True)
    return path


def _asset_url(version: str, name: str) -> str:
    return DOWNLOAD_URL.format(repo=DATA_REPO, version=version, name=name)


def _download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    try:
        with _request(url) as resp, tmp.open("wb") as fh:
            shutil.copyfileobj(resp, fh, 1 << 20)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    os.replace(tmp, dest)
    return dest


class _HttpRangeFile(io.RawIOBase):
    """Seekable read-only view of a remote file, backed by HTTP range requests."""

    CHUNK = 1 << 20

    def __init__(self, url: str):
        super().__init__()
        with _request(url, {"Range": "bytes=0-0"}) as resp:
            if resp.status != 206:
                raise MapAssetError("range requests not supported")
            self.url = resp.geturl()
            content_range = resp.headers.get("Content-Range", "")
        match = re.match(r"bytes \d+-\d+/(\d+)", content_range)
        if not match:
            raise MapAssetError("no Content-Range in response")
        self.size = int(match.group(1))
        self.pos = 0
        self._buf_start = 0
        self._buf = b""

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            self.pos = offset
        elif whence == io.SEEK_CUR:
            self.pos += offset
        else:
            self.pos = self.size + offset
        self.pos = max(0, min(self.pos, self.size))
        return self.pos

    def _fill(self, start: int, length: int) -> None:
        end = min(self.size, start + max(length, self.CHUNK)) - 1
        with _request(self.url, {"Range": f"bytes={start}-{end}"}) as resp:
            if resp.status != 206:
                raise MapAssetError("range request ignored by server")
            self._buf = resp.read()
        self._buf_start = start

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            size = self.size - self.pos
        size = min(size, self.size - self.pos)
        if size <= 0:
            return b""
        buf_end = self._buf_start + len(self._buf)
        if not (self._buf_start <= self.pos and self.pos + size <= buf_end):
            self._fill(self.pos, size)
        off = self.pos - self._buf_start
        data = self._buf[off : off + size]
        self.pos += len(data)
        return data

    def readinto(self, b) -> int:  # type: ignore[override]
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


def _extract_member(zip_url: str, member: str, dest: Path) -> Path:
    """Pull one member out of a remote zip; falls back to a full download."""
    try:
        remote = _HttpRangeFile(zip_url)
        with zipfile.ZipFile(io.BufferedReader(remote, buffer_size=1 << 16)) as zf:
            names = set(zf.namelist())
            if member not in names:
                raise FileNotFoundError(member)
            tmp = dest.with_name(dest.name + ".part")
            with zf.open(member) as src, tmp.open("wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)
            os.replace(tmp, dest)
            return dest
    except FileNotFoundError:
        raise
    except Exception as exc:  # noqa: BLE001
        log.info("partial zip download failed (%s); downloading the whole archive", exc)
    with tempfile.TemporaryDirectory() as tmpdir:
        archive = _download(zip_url, Path(tmpdir) / "archive.zip")
        with zipfile.ZipFile(archive) as zf:
            if member not in zf.namelist():
                raise FileNotFoundError(member)
            tmp = dest.with_name(dest.name + ".part")
            with zf.open(member) as src, tmp.open("wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)
            os.replace(tmp, dest)
    return dest


def map_data(version: str | None = None) -> dict[str, Any]:
    version = version or resolve_version()
    path = version_dir(version) / "map_data.json"
    if not path.exists():
        with _lock:
            if not path.exists():
                _download(_asset_url(version, "map_data.json"), path)
    return json.loads(path.read_text(encoding="utf-8"))


def mesh_path(map_name: str, version: str | None = None) -> Path:
    if not valid_map_name(map_name):
        raise MapAssetError(f"bad map name: {map_name!r}")
    version = version or resolve_version()
    dest = version_dir(version) / f"{map_name}.mesh"
    if dest.exists():
        return dest
    with _lock:
        if not dest.exists():
            _extract_member(_asset_url(version, "geometry.zip"), f"{map_name}.mesh", dest)
    return dest


def radar_path(map_name: str, lower: bool = False, version: str | None = None) -> Path:
    if not valid_map_name(map_name):
        raise MapAssetError(f"bad map name: {map_name!r}")
    version = version or resolve_version()
    radars = version_dir(version) / "radars"
    name = f"{map_name}_lower.png" if lower else f"{map_name}.png"
    dest = radars / name
    if dest.exists():
        return dest
    marker = version_dir(version) / ".images.done"
    with _lock:
        if not marker.exists():
            radars.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory() as tmpdir:
                archive = _download(_asset_url(version, "images.zip"), Path(tmpdir) / "images.zip")
                with zipfile.ZipFile(archive) as zf:
                    for info in zf.infolist():
                        base = Path(info.filename).name
                        if base.endswith(".png") and valid_map_name(base[:-4]):
                            (radars / base).write_bytes(zf.read(info))
            marker.touch()
    if not dest.exists():
        raise FileNotFoundError(name)
    return dest


def map_info(map_name: str) -> dict[str, Any]:
    """Everything the viewer needs to know about a map; never raises."""
    info: dict[str, Any] = {"map": map_name, "version": None, "transform": None, "lower": False}
    try:
        version = resolve_version()
        info["version"] = version
        data = map_data(version)
        transform = data.get(map_name)
        if transform:
            info["transform"] = transform
            sections = transform.get("verticalsections") or {}
            lower = sections.get("lower")
            if lower:
                info["lower"] = True
                info["lowerMaxZ"] = float(lower.get("AltitudeMax", 0))
    except Exception as exc:  # noqa: BLE001
        info["error"] = str(exc)
    return info


def prefetch(map_names: list[str]) -> dict[str, str]:
    """Download assets for the given maps (or every map in the release)."""
    results = {}
    data = map_data()
    names = map_names or sorted(data)
    for name in names:
        try:
            mesh_path(name)
            status = "ok"
        except FileNotFoundError:
            status = "нет геометрии"
        except Exception as exc:  # noqa: BLE001
            status = f"ошибка: {exc}"
        try:
            radar_path(name)
        except Exception:  # noqa: BLE001
            status += " (без радара)"
        results[name] = status
    return results


def offline_error(exc: BaseException) -> bool:
    return isinstance(exc, (urllib.error.URLError, TimeoutError, ConnectionError))
