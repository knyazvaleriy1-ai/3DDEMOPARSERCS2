"""Deployment configs of the web version stay consistent with the build script."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_vercel_config_builds_into_its_output_directory():
    cfg = json.loads((ROOT / "vercel.json").read_text())
    assert cfg["framework"] is None  # not the Python/FastAPI preset: a static site
    script = re.fullmatch(r"sh (\S+)", cfg["buildCommand"]).group(1)
    text = (ROOT / script).read_text()
    assert f"scripts/build_site.py {cfg['outputDirectory']}" in text
    for rule in cfg["headers"]:
        assert rule["source"].startswith("/")
    ignored = (ROOT / ".vercelignore").read_text().split()
    assert not {"cs2demo/", "scripts/", "scripts/vercel_build.sh"} & set(ignored)
