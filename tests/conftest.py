import gzip
import json
import os
from pathlib import Path

import numpy as np
import pytest

RATE = 64


def make_kill(tick, attacker, victim, *, round_idx=0, a_side="T", v_side="CT", weapon="ak47", **extra):
    kill = {
        "tick": tick, "round": round_idx, "attacker": attacker, "victim": victim, "assister": -1,
        "weapon": weapon, "headshot": False, "penetrated": 0, "noscope": False, "smoke": False,
        "blind": False, "air": False, "flashAssist": False, "distance": 10.0,
        "attackerSide": a_side, "victimSide": v_side, "teamkill": False,
        "pos": [0.0, 0.0, 0.0], "attackerPos": [0.0, 0.0, 0.0], "place": "",
    }
    kill.update(extra)
    return kill


def make_meta(kills, rounds=None, players=10):
    """A minimal parsed-demo meta: players 0-4 are T, 5-9 are CT."""
    if rounds is None:
        rounds = [{
            "num": 1, "start": 0, "freezeEnd": 64 * 15, "end": 64 * 130, "next": 64 * 137,
            "winner": "T", "reason": "ct_killed",
            "alive": {"T": [0, 1, 2, 3, 4], "CT": [5, 6, 7, 8, 9]},
        }]
    return {
        "format": 1,
        "map": "de_test",
        "file": "test.dem",
        "tickRate": RATE,
        "players": [
            {"key": str(i), "steamid": str(i), "name": f"player{i}", "bot": False,
             "startSide": "T" if i < 5 else "CT"}
            for i in range(players)
        ],
        "rounds": rounds,
        "kills": kills,
        "weapons": [""],
        "places": [""],
    }


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CS2DEMO_DATA", str(tmp_path / "data"))
    return tmp_path / "data"


@pytest.fixture()
def parsed_demo(data_dir):
    """Write a tiny synthetic parsed demo into the data dir; returns its id."""
    from cs2demo import storage
    from cs2demo.highlights import detect_highlights

    demo_id = "test-demo-0001"
    kills = [make_kill(64 * 20 + i * 64, 0, 5 + i) for i in range(3)]
    meta = make_meta(kills)
    frames, players = 50, 10
    pos = np.zeros((frames, players, 3), "<f4")
    ang = np.zeros((frames, players, 2), "<i2")
    u8 = np.zeros((frames, players, 6), np.uint8)
    money = np.zeros((frames, players), "<u2")
    sections, blobs, offset = [], [], 0
    for name, arr, dtype in (("pos", pos, "float32"), ("ang", ang, "int16"), ("u8", u8, "uint8"), ("money", money, "uint16")):
        raw = arr.tobytes()
        sections.append({"name": name, "dtype": dtype, "offset": offset, "bytes": len(raw)})
        blobs.append(raw)
        offset += len(raw)
        pad = (-offset) % 8
        blobs.append(b"\0" * pad)
        offset += pad
    meta["frames"] = {"startTick": 0, "endTick": 98, "step": 2, "count": frames, "players": players,
                      "u8Fields": ["health", "armor", "flags", "weapon", "duck", "place"], "sections": sections}
    meta["id"] = demo_id
    meta["scoreboard"] = []
    meta["highlights"] = detect_highlights(meta)
    out = storage.parsed_dir(demo_id)
    out.mkdir(parents=True)
    (out / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (out / "frames.bin.gz").write_bytes(gzip.compress(b"".join(blobs)))
    return demo_id


def real_demo_path() -> Path | None:
    env = os.environ.get("CS2DEMO_TEST_DEMO")
    if env and Path(env).is_file():
        return Path(env)
    found = sorted((Path(__file__).parent / "fixtures").glob("*.dem"))
    return found[0] if found else None
