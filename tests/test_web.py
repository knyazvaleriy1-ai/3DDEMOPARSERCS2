"""The server-less web version: JS port of the highlight detector and the site build."""

import gzip
import importlib.util
import json
import random
import shutil
import subprocess
from pathlib import Path

import numpy as np
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


def _jump_arrays(frames=60, players=2):
    from cs2demo import parser as P

    flags = np.full((frames, players), P.FLAG_PRESENT | P.FLAG_ALIVE, dtype=np.uint8)
    z = np.zeros((frames, players), dtype=np.float32)
    keys = np.zeros((frames, players), dtype=np.uint16)
    for p, t in ((0, 20), (1, 30)):  # take-off frames
        for i in range(8):
            flags[t + i, p] |= P.FLAG_AIRBORNE
            z[t + i, p] = 12.0 * min(i + 1, 8 - i)
    keys[27:32, 1] |= 1 << P.KEY_SPACE  # player 1 holds Space, player 0 scrolls
    return keys, flags, z


def test_keys_from_buttons_and_wheel_jumps():
    from cs2demo import parser as P

    w_tab_rmb = (1 << 3) | (1 << 33) | (1 << 11)
    bits = P.keys_from_buttons(np.array([w_tab_rmb, 0], dtype=np.uint64))
    names = [P.KEY_NAMES[i] for i in range(16) if bits[0] & (1 << i)]
    assert names == ["W", "RMB", "TAB"] and bits[1] == 0

    keys, flags, z = _jump_arrays()
    P.mark_wheel_jumps(keys, flags, z, step=2)
    wheel = (keys & (1 << P.KEY_WHEEL)) != 0
    assert np.nonzero(wheel[:, 0])[0].tolist() == [19, 20, 21, 22]
    assert not wheel[:, 1].any()


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_js_keys_match_python():
    from cs2demo import parser as P

    rng = np.random.default_rng(7)
    masks = [int(m) for m in rng.integers(0, 1 << 40, size=200, dtype=np.uint64)] + [0, (1 << 36) - 1]
    cases = []
    for step in (1, 2, 4):
        keys, flags, z = _jump_arrays(80, 3)
        flags[:, 2] = rng.choice([1 | 2, 1 | 2 | P.FLAG_AIRBORNE, 1], size=80)
        z[:, 2] = rng.uniform(-20, 40, size=80).astype(np.float32)
        keys[:, 2] = rng.choice([0, 1 << P.KEY_SPACE], size=80, p=[0.8, 0.2])
        cases.append((step, keys, flags, z))
    runner = """
    const { keysFromButtons, markWheelJumps } = await import(process.argv[1]);
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const { masks, cases } = JSON.parse(input);
    const out = { masks: masks.map((m) => keysFromButtons(BigInt(m))), cases: [] };
    for (const c of cases) {
      const keys = Uint16Array.from(c.keys), flags = Uint8Array.from(c.flags), z = Float32Array.from(c.z);
      markWheelJumps(keys, flags, z, c.frames, c.players, c.step);
      out.cases.push([...keys]);
    }
    console.log(JSON.stringify(out));
    """
    payload = {
        "masks": [str(m) for m in masks],
        "cases": [{"step": st, "frames": k.shape[0], "players": k.shape[1], "keys": k.ravel().tolist(),
                   "flags": f.ravel().tolist(), "z": zz.ravel().tolist()} for st, k, f, zz in cases],
    }
    module = (ROOT / "cs2demo/web/js/parse/parser.js").as_uri()
    res = subprocess.run([NODE, "--input-type=module", "-e", runner, module], input=json.dumps(payload),
                         capture_output=True, text=True, check=True)
    js = json.loads(res.stdout)
    assert js["masks"] == P.keys_from_buttons(np.array(masks, dtype=np.uint64)).tolist()
    for (step, keys, flags, z), got in zip(cases, js["cases"], strict=True):
        P.mark_wheel_jumps(keys, flags, z, step)
        assert got == keys.ravel().tolist(), f"step {step}"


def test_keys_known_follow_available_button_columns():
    import pandas as pd

    from cs2demo import parser as P

    # demoparser2 0.42.0: no JUMP / DUCK / WALK columns
    df = pd.DataFrame({"FORWARD": [True, None], "SCOREBOARD": [False, True], "FIRE": [None, None]})
    col_bool = lambda name: df[name].fillna(False).astype(bool).to_numpy() if name in df else np.zeros(len(df), bool)  # noqa: E731
    masks, known = P._button_masks(df, col_bool)
    assert known == ["W", "LMB", "TAB"]
    assert masks.tolist() == [1 << 3, 1 << 33]
    df["JUMP"] = [True, False]
    _, known = P._button_masks(df, col_bool)
    assert known == ["W", "SPACE", "LMB", "TAB"]
