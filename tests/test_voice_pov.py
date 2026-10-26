"""Voice chat extraction, POV recordings (planning, sound parts, CLI, server) and the smoke/bullet ray caster."""

import base64
import io
import json
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
JS = ROOT / "cs2demo/web/js"


def run_js(code: str, payload=None):
    res = subprocess.run([NODE, "--input-type=module", "-e", code], input=json.dumps(payload),
                         capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(res.stdout)


# -- voice -----------------------------------------------------------------------------


class FakeVoiceParser:
    def __init__(self, packets):
        self.packets = packets

    def parse_voice(self):
        if isinstance(self.packets, Exception):
            raise self.packets
        return self.packets


def test_build_voice_keeps_known_players_in_tick_order():
    from cs2demo import parser as P

    lookup = P._Players(["76561198000000001", "76561198000000002"], ["a", "b"])
    packets = [
        {"tick": 20, "steamid": 76561198000000002, "bytes": b"\x70bb"},
        {"tick": 10, "steamid": 76561198000000001, "bytes": b"\x70a"},
        {"tick": 15, "steamid": 76561190000000009, "bytes": b"\x70zz"},  # caster: unknown
        {"tick": 20, "steamid": 76561198000000001, "bytes": b"\x70aaa"},
    ]
    rows, data = P._build_voice(FakeVoiceParser(packets), lookup)
    assert rows.dtype == np.dtype("<u4") and rows.tolist() == [[10, 0, 2], [20, 1, 3], [20, 0, 4]]
    assert data.tobytes() == b"\x70a" + b"\x70bb" + b"\x70aaa"


def test_build_voice_without_voice_support():
    from cs2demo import parser as P

    parser = FakeVoiceParser(RuntimeError("old demoparser2"))
    rows, data = P._build_voice(parser, P._Players([], []))
    assert rows.shape == (0, 3) and data.size == 0


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_js_voice_spurts_and_filters():
    code = """
    const { VoiceTrack, voiceFilter } = await import('./cs2demo/web/js/voice.js');
    // player 0: 3 packets of 20 ms (TOC config 15 = hybrid FB 20 ms), a pause, 2 more;
    // player 1: one 10 ms packet (config 14)
    const pk = [[100, 0, 0x78], [101, 0, 0x78], [102, 0, 0x78], [101, 1, 0x70], [180, 0, 0x78], [181, 0, 0x78]];
    const rows = new Uint32Array(pk.flatMap(([t, p]) => [t, p, 3]));
    const data = new Uint8Array(pk.flatMap(([, , toc]) => [toc, 1, 2]));
    const sides = ['T', 'CT'];
    const demo = { tickRate: 64, startTick: 0, voiceRows: rows, voiceData: data,
      state: (p, t, out = {}) => Object.assign(out, { present: true, side: sides[p] }) };
    const tr = new VoiceTrack(demo);
    const out = { spurts: tr.spurts.map((s) => [s.player, s.tick, +s.seconds.toFixed(3), s.packets.length]),
      speakers: tr.speakers, at: tr.speakingAt(101.5), later: tr.speakingAt(102),
      starting: tr.starting(100, 180).map((s) => s.tick) };
    out.team = [0, 1].map((p) => voiceFilter(demo, 'team', 0)(p, 100));
    out.ct = [0, 1].map((p) => voiceFilter(demo, 'CT', 0)(p, 100));
    out.off = voiceFilter(demo, 'off', 0);
    console.log(JSON.stringify(out));
    """
    out = run_js(code)
    assert out["spurts"] == [[0, 100, 0.06, 3], [1, 101, 0.01, 1], [0, 180, 0.04, 2]]
    assert out["speakers"] == [0, 1] and sorted(out["at"]) == [0, 1] and out["later"] == [0]
    assert out["starting"] == [101, 180]
    assert out["team"] == [True, False] and out["ct"] == [False, True] and out["off"] is None


# -- POV -------------------------------------------------------------------------------

POV_DEMO = """
const rate = 64;
// 4 players: 0, 1 = T, 2, 3 = CT. Round 1: player 0 dies at 40 s, teammate 1
// at 60 s; round 2: player 0 survives; round 3: player 0 absent.
const rounds = [
  { num: 1, start: 0, freezeEnd: 15 * rate, end: 100 * rate, next: 107 * rate },
  { num: 2, start: 107 * rate, freezeEnd: 122 * rate, end: 150 * rate, next: 157 * rate },
  { num: 3, start: 157 * rate, freezeEnd: 172 * rate, end: 200 * rate, next: 207 * rate },
];
const kills = [{ tick: 40 * rate, victim: 0, attacker: 2 }, { tick: 60 * rate, victim: 1, attacker: 3 }];
const demo = { tickRate: rate, startTick: 0, endTick: 210 * rate, P: 4, rounds, kills,
  players: ['zero', 'one', 'two', 'three'].map((name) => ({ name })),
  state(p, t, out = {}) {
    const dead = kills.some((k) => k.victim === p && k.tick <= t && t < 107 * rate);
    return Object.assign(out, { present: !(p === 0 && t >= 157 * rate), alive: !dead, side: p < 2 ? 'T' : 'CT',
      x: p * 100, y: 0, z: 0 });
  } };
"""


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_js_pov_plan_fast_forwards_after_death():
    code = POV_DEMO + """
    const { povPlan, DEATH_HOLD } = await import('./cs2demo/web/js/pov.js');
    const plan = povPlan(demo, 0, [0, 1, 2], { fps: 30, ff: 8 });
    const cut = povPlan(demo, 0, [0], { fps: 30, ff: 0 });
    const f = plan.frames;
    const r1 = f.slice(plan.parts[0][0], plan.parts[0][1]);
    const at = (s) => r1.find((x) => x.tick >= s * rate);
    console.log(JSON.stringify({
      parts: plan.parts.map((p) => p[2]),
      first: r1[0].tick / rate, last: r1[r1.length - 1].tick / rate,
      alive: at(30).ff, hold: at(40 + DEATH_HOLD - 0.1).ff, fast: at(50).ff,
      watch: [at(50).focus, at(61).focus, at(30).focus],
      r2: [...new Set(f.slice(plan.parts[1][0], plan.parts[1][1]).map((x) => x.ff))],
      cutLast: cut.frames[cut.frames.length - 1].tick / rate,
      frames: [r1.length, cut.frames.length],
    }));
    """
    out = run_js(code)
    assert out["parts"] == [1, 2]  # round 3: the player isn't there
    assert out["first"] == 13 and 101.9 < out["last"] <= 102
    assert out["alive"] == 1 and out["hold"] == 1 and out["fast"] == 8
    assert out["watch"] == [1, 2, 0]  # teammate, then (no T left) the nearest enemy; alive: own eyes
    assert out["r2"] == [1]
    assert 41.9 < out["cutLast"] <= 42
    # 27 s alive + 2 s death cam at 1x, ~58 s at 8x, 2 s after the round
    assert 30 * 30 < out["frames"][0] < 30 * 42 and abs(out["frames"][1] - 30 * 29) <= 1


def test_parse_rounds():
    from cs2demo.recorder import parse_rounds

    assert parse_rounds(None) is None and parse_rounds("") is None
    assert parse_rounds("3,5,7-9") == [3, 5, 7, 8, 9]
    assert parse_rounds("12-10, 1") == [1, 10, 11, 12]


def _wav(frames: int, value: int) -> str:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(np.full(frames * 2, value, dtype="<i2").tobytes())
    return base64.b64encode(buf.getvalue()).decode()


class FakePage:
    def __init__(self, parts):
        self.parts = parts

    def evaluate(self, _script, arg=None):
        return self.parts[tuple(arg)]


def test_write_sound_joins_parts(tmp_path):
    from cs2demo.recorder import _write_sound

    page = FakePage({(0, 30): _wav(48000, 100), (30, 45): None, (45, 60): _wav(24000, 200)})
    wav = tmp_path / "a.wav"
    assert _write_sound(page, [[0, 30], [30, 45], [45, 60]], 30, wav)
    with wave.open(str(wav)) as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(-1, 2)
    assert len(pcm) == 48000 * 2  # the silent part keeps the rest in step
    assert pcm[0, 0] == 100 and pcm[48000 + 100, 0] == 0 and pcm[-1, 1] == 200
    assert not _write_sound(FakePage({(0, 30): None}), [[0, 30]], 30, tmp_path / "b.wav")


def test_cli_pov_and_render_options():
    from cs2demo.cli import build_parser

    parser = build_parser()
    args = parser.parse_args(
        ["pov", "demo1", "--player", "s1mple", "--rounds", "1-3", "--ff", "0", "--voice", "player"]
    )
    assert (args.player, args.rounds, args.ff, args.voice, args.res) == ("s1mple", "1-3", 0, "player", "1280x720")
    args = parser.parse_args(["render", "demo1", "--player", "s1", "--voice", "off"])
    assert args.player == "s1" and args.voice == "off" and args.pov == "first"


@pytest.fixture()
def client(data_dir, monkeypatch):
    from fastapi.testclient import TestClient

    from cs2demo import server

    monkeypatch.setattr(server, "playwright_available", lambda: True)
    with TestClient(server.create_app()) as c:
        yield c


def test_render_pov_endpoint_validates(client, parsed_demo):
    url = f"/api/demos/{parsed_demo}/render-pov"
    assert client.post(url, json={"player": "nobody"}).status_code == 400
    assert client.post(url, json={"player": "x", "ff": 3}).status_code == 400
    assert client.post("/api/demos/missing-0000/render-pov", json={"player": "x"}).status_code == 404


# -- ray caster ------------------------------------------------------------------------


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_js_raycaster_matches_brute_force():
    code = """
    const { MeshRaycaster } = await import('./cs2demo/web/js/raycast.js');
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const nt = 800, pos = new Float32Array(nt * 9), idx = new Uint32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      const c = [rnd() * 3000 - 1500, rnd() * 400 - 200, rnd() * 3000 - 1500], s = 20 + rnd() * 400;
      for (let k = 0; k < 3; k++) {
        for (let a = 0; a < 3; a++) pos[t * 9 + k * 3 + a] = c[a] + (rnd() - 0.5) * s;
        idx[t * 3 + k] = t * 3 + k;
      }
    }
    const r = new MeshRaycaster(pos, idx, 96);
    let bad = 0, hits = 0, blockedOk = 0;
    for (let i = 0; i < 1500; i++) {
      const o = [rnd() * 4000 - 2000, rnd() * 600 - 300, rnd() * 4000 - 2000];
      let d = i % 13 === 0 ? [0, -1, 0] : [rnd() - 0.5, i % 5 === 0 ? 0 : rnd() - 0.5, rnd() - 0.5];
      const l = Math.hypot(...d); d = d.map((x) => x / l);
      const h = r.cast(...o, ...d, 6000);
      let best = 6000, any = false;
      for (let t = 0; t < nt; t++) {
        const x = r._hit(t, ...o, ...d);
        if (x > 1e-3 && x < best) { best = x; any = true; }
      }
      if (!!h !== any || (h && Math.abs(h.t - best) > 1e-3)) bad++;
      if (any) {
        hits++;
        const n = h.nx * d[0] + h.ny * d[1] + h.nz * d[2];
        const b = o.map((v, k) => v + d[k] * best * 2), a = o.map((v, k) => v + d[k] * best * 0.5);
        const ok = n <= 0 && r.blocked(...o, ...b) && !r.blocked(...o, ...a);
        if (ok) blockedOk++;
      }
    }
    console.log(JSON.stringify({ bad, hits, blockedOk }));
    """
    out = run_js(code)
    assert out["bad"] == 0 and out["hits"] > 100 and out["blockedOk"] == out["hits"]
