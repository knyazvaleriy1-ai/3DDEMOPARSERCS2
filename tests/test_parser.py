"""Parser tests on a real demo. Put a CS2 .dem into tests/fixtures/ or set
CS2DEMO_TEST_DEMO=/path/to/demo.dem; otherwise these tests are skipped."""

import numpy as np
import pytest

from conftest import real_demo_path

DEMO = real_demo_path()
pytestmark = pytest.mark.skipif(DEMO is None, reason="no CS2 demo available (see module docstring)")


@pytest.fixture(scope="module")
def parsed():
    from cs2demo.parser import parse_demo

    return parse_demo(DEMO)


def test_structure(parsed):
    meta, frames = parsed
    assert meta["map"].startswith(("de_", "cs_", "ar_"))
    assert meta["tickRate"] in (64.0, 128.0)
    assert 2 <= len(meta["players"]) <= 12
    assert meta["rounds"] and all(r["start"] <= r["freezeEnd"] <= r["end"] <= r["next"] for r in meta["rounds"])
    f = meta["frames"]
    assert sum(s["bytes"] for s in f["sections"]) <= len(frames)
    for s in f["sections"]:
        assert s["offset"] % 8 == 0


def test_frames_decode(parsed):
    meta, frames = parsed
    f = meta["frames"]
    sec = {s["name"]: s for s in f["sections"]}
    count, players = f["count"], f["players"]
    pos = np.frombuffer(frames, "<f4", sec["pos"]["bytes"] // 4, sec["pos"]["offset"]).reshape(count, players, 3)
    u8 = np.frombuffer(frames, np.uint8, sec["u8"]["bytes"], sec["u8"]["offset"]).reshape(count, players, 6)
    alive = (u8[:, :, 2] & 2) > 0
    assert alive.any()
    # Players that are alive stay inside a sane world box.
    assert np.abs(pos[alive]).max() < 20000
    assert (u8[:, :, 0][alive] <= 100).all()


def test_kills_reference_players(parsed):
    meta, _ = parsed
    n = len(meta["players"])
    for k in meta["kills"]:
        assert 0 <= k["victim"] < n and -1 <= k["attacker"] < n
    ticks = [k["tick"] for k in meta["kills"]]
    assert ticks == sorted(ticks)


def test_highlights_are_inside_rounds(parsed):
    meta, _ = parsed
    for h in meta["highlights"]:
        r = meta["rounds"][h["roundIndex"]]
        assert r["start"] <= h["start"] < h["end"] <= r["next"]
