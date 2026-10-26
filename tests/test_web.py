"""The server-less web version: JS port of the highlight detector and the site build."""

import gzip
import importlib.util
import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from cs2demo.highlights import detect_highlights
from conftest import make_kill, make_meta

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")

JS_RUNNER = """
const { detectHighlights } = await import(process.argv[1]);
let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify(JSON.parse(input).map((m) => detectHighlights(m))));
"""


def _random_meta(seed: int) -> dict:
    rng = random.Random(seed)
    weapons = ["ak47", "m4a1", "awp", "ssg08", "deagle", "knife_t", "taser", "usp_silencer", "hegrenade", "glock"]
    rounds, kills = [], []
    for r in range(4):
        start = 64 * 140 * r
        alive = {"T": [0, 1, 2, 3, 4], "CT": [5, 6, 7, 8, 9]}
        dead: set[int] = set()
        t = start + 64 * 20
        for _ in range(rng.randint(2, 9)):
            t += rng.randint(8, 64 * 25)
            victims = [p for p in range(10) if p not in dead]
            if len(victims) < 2:
                break
            v = rng.choice(victims)
            enemies = [p for p in victims if (p < 5) != (v < 5)]
            if not enemies:
                break
            a = rng.choice(enemies)
            dead.add(v)
            kills.append(make_kill(
                t, a, v, round_idx=r, a_side="T" if a < 5 else "CT", v_side="T" if v < 5 else "CT",
                weapon=rng.choice(weapons), headshot=rng.random() < 0.4, noscope=rng.random() < 0.1,
                smoke=rng.random() < 0.1, penetrated=int(rng.random() < 0.1), blind=rng.random() < 0.05,
                air=rng.random() < 0.05, distance=rng.uniform(1, 60),
            ))
        rounds.append({
            "num": r + 1, "start": start, "freezeEnd": start + 64 * 15, "end": t + 64 * 2, "next": t + 64 * 9,
            "winner": rng.choice(["T", "CT"]), "reason": rng.choice(["ct_killed", "t_killed", "bomb_defused"]),
            "alive": alive,
        })
    return make_meta(kills, rounds)


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_js_highlights_match_python():
    metas = [_random_meta(seed) for seed in range(40)]
    metas.append(make_meta([make_kill(64 * 30 + i * 64, 1, 5 + i, headshot=True) for i in range(3)]))
    module = (ROOT / "cs2demo/web/js/parse/highlights.js").as_uri()
    out = subprocess.run([NODE, "--input-type=module", "-e", JS_RUNNER, module], input=json.dumps(metas),
                         capture_output=True, text=True, check=True)
    js = json.loads(out.stdout)
    py = [detect_highlights(m) for m in metas]
    assert sum(len(h) for h in py) > 40  # the random matches do produce highlights
    assert js == json.loads(json.dumps(py))


def _load_build_site():
    spec = importlib.util.spec_from_file_location("build_site", ROOT / "scripts/build_site.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_build_site(tmp_path, monkeypatch):
    build_site = _load_build_site()
    mesh = tmp_path / "de_test.mesh"
    mesh.write_bytes(b"AWMH" + bytes(range(256)) * 40)
    radar = tmp_path / "de_test.png"
    radar.write_bytes(b"\x89PNG fake")
    glb = tmp_path / "soldier.glb"
    glb.write_bytes(b"glTF fake")

    def radar_path(name, lower=False, version=None):
        if lower:
            raise FileNotFoundError(name)
        return radar

    info = {"map": "de_test", "version": "1", "transform": {"pos_x": 0, "pos_y": 0, "scale": 5}, "lower": False}
    monkeypatch.setattr(build_site.maps, "map_data", lambda version=None: {"de_test": {}})
    monkeypatch.setattr(build_site.maps, "map_info", lambda name: info)
    monkeypatch.setattr(build_site.maps, "mesh_path", lambda name, version=None: mesh)
    monkeypatch.setattr(build_site.maps, "radar_path", radar_path)
    monkeypatch.setattr(build_site.models, "model_for", lambda side: glb)

    out = tmp_path / "site"
    status = build_site.build(out, None)
    assert "radar" in status["de_test"]
    assert "export const STATIC = true;" in (out / "js/config.js").read_text()
    assert (out / "index.html").is_file() and (out / ".nojekyll").is_file()
    assert (out / "vendor/demoparser/cs2wasm_bg.wasm").is_file()
    m = out / "assets/maps/de_test"
    assert gzip.decompress((m / "mesh.bin.gz").read_bytes()) == mesh.read_bytes()
    assert json.loads((m / "info.json").read_text()) == info
    assert (m / "radar.png").read_bytes() == radar.read_bytes()
    assert json.loads((out / "assets/models/index.json").read_text())["ct"]["file"] == "soldier.glb"
    # the repository copy stays in server mode
    assert "export const STATIC = false;" in (ROOT / "cs2demo/web/js/config.js").read_text()
