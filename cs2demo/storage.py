"""On-disk layout of the working data directory.

    <data>/demos/<id>.dem            uploaded / imported demos
    <data>/parsed/<id>/meta.json     parsed metadata, events and highlights
    <data>/parsed/<id>/frames.bin    packed per-tick player state
    <data>/maps/<map>.mesh|.png      map assets (downloaded from awpy-data)
    <data>/clips/<id>/<clip>.mp4     recorded clips
"""

from __future__ import annotations

import hashlib
import os
import re
import unicodedata
from pathlib import Path


def data_root() -> Path:
    root = Path(os.environ.get("CS2DEMO_DATA", "data")).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def demos_dir() -> Path:
    return _sub("demos")


def parsed_dir(demo_id: str | None = None) -> Path:
    base = _sub("parsed")
    return base / demo_id if demo_id else base


def maps_dir() -> Path:
    return _sub("maps")


def clips_dir(demo_id: str | None = None) -> Path:
    base = _sub("clips")
    if demo_id:
        path = base / demo_id
        path.mkdir(parents=True, exist_ok=True)
        return path
    return base


def _sub(name: str) -> Path:
    path = data_root() / name
    path.mkdir(parents=True, exist_ok=True)
    return path


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,95}$")


def is_valid_id(value: str) -> bool:
    """Ids and clip names are used as path components, so keep them boring."""
    return bool(_ID_RE.match(value)) and ".." not in value


_TRANSLIT = dict(
    zip(
        "абвгдеёжзийклмнопрстуфхцчшщъыьэюяєіїґ",
        "a b v g d e e zh z i y k l m n o p r s t u f h ts ch sh sch _ y _ e yu ya e i yi g".split(),
        strict=True,
    )
)
_TRANSLIT.update({"ъ": "", "ь": ""})


def slugify(text: str, fallback: str = "demo") -> str:
    text = "".join(_TRANSLIT.get(ch, ch) for ch in text.lower())
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:48] or fallback


def demo_id_for(path: Path, display_name: str | None = None) -> str:
    """Stable id: readable stem + short content hash (first 4 MB + size)."""
    h = hashlib.sha1()
    size = path.stat().st_size
    with path.open("rb") as fh:
        h.update(fh.read(4 * 1024 * 1024))
    h.update(str(size).encode())
    return f"{slugify(display_name or path.stem)}-{h.hexdigest()[:8]}"
