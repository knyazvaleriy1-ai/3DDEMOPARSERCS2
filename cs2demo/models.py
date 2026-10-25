"""Player models for the 3D view.

By default an animated soldier (idle / walk / run, Mixamo rig) is downloaded
once from the three.js examples on GitHub into ``<data>/models/``. Drop your own
glTF binaries there to replace it:

* ``player_t.glb`` / ``player_ct.glb`` – per side,
* ``player.glb`` – both sides.

Any rigged humanoid works; a Mixamo-style skeleton (``mixamorig:*`` bones) gets
procedural aiming, crouching and weapon-holding on top of its animations.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

from .maps import _download
from .storage import data_root

log = logging.getLogger(__name__)

DEFAULT_URL = "https://raw.githubusercontent.com/mrdoob/three.js/r170/examples/models/gltf/Soldier.glb"
DEFAULT_NAME = "soldier.glb"
SIDES = ("t", "ct")

_lock = threading.Lock()


def models_dir() -> Path:
    path = data_root() / "models"
    path.mkdir(parents=True, exist_ok=True)
    return path


def default_model() -> Path:
    dest = models_dir() / DEFAULT_NAME
    if not dest.exists():
        with _lock:
            if not dest.exists():
                log.info("downloading default player model")
                _download(DEFAULT_URL, dest)
    return dest


def model_for(side: str) -> Path:
    """User override for ``side`` (t / ct), else ``player.glb``, else the default soldier."""
    root = models_dir()
    for name in (f"player_{side}.glb", "player.glb"):
        if (root / name).is_file():
            return root / name
    return default_model()


def info() -> dict[str, dict[str, object]]:
    out: dict[str, dict[str, object]] = {}
    for side in SIDES:
        try:
            path = model_for(side)
            out[side] = {"file": path.name, "custom": path.name != DEFAULT_NAME}
        except Exception as exc:  # noqa: BLE001 - offline: the viewer falls back to capsules
            out[side] = {"file": None, "error": str(exc)}
    return out
