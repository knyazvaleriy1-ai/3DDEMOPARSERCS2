"""Knife rounds (no stats or highlights), voice chat in the Steam packet format, the sound engine and smoke lineups."""

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from conftest import RATE, make_kill, make_meta

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="node not available")


def run_js(code: str, payload=None):
    res = subprocess.run([NODE, "--input-type=module", "-e", code], input=json.dumps(payload),
                         capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(res.stdout)


# -- knife rounds ------------------------------------------------------------------------


def knife_case():
    """Round 0: knives only (sides picked); round 1: the match; round 2: a knife kill and
    nothing else, but the match is under way."""
    rounds = [
        {"num": 1, "start": 0, "freezeEnd": 64 * 5, "end": 64 * 60, "next": 64 * 65,
         "alive": {"T": [0, 1, 2, 3, 4], "CT": [5, 6, 7, 8, 9]}},
        {"num": 2, "start": 64 * 65, "freezeEnd": 64 * 80, "end": 64 * 180, "next": 64 * 187,
         "alive": {"T": [0, 1, 2, 3, 4], "CT": [5, 6, 7, 8, 9]}},
        {"num": 3, "start": 64 * 187, "freezeEnd": 64 * 202, "end": 64 * 300, "next": 64 * 307,
         "alive": {"T": [0, 1, 2, 3, 4], "CT": [5, 6, 7, 8, 9]}},
    ]
    kills = [make_kill(64 * (10 + i), 1, 5 + i, round_idx=0, weapon="knife_karambit") for i in range(4)]
    kills += [make_kill(64 * 100, 2, 6, round_idx=1), make_kill(64 * 101, 2, 7, round_idx=1)]
    kills += [make_kill(64 * 220, 3, 8, round_idx=2, weapon="knife")]
    shots = [[64 * 9, 1, "knife_karambit"], [64 * 10, 5, "knife"], [64 * 20, 0, "c4"],
             [64 * 99, 2, "ak47"], [64 * 219, 3, "knife"]]
    return rounds, kills, shots


def test_mark_knife_rounds():
    from cs2demo.parser import mark_knife_rounds

    rounds, kills, shots = knife_case()
    mark_knife_rounds(rounds, kills, shots)
    assert [r.get("knife", False) for r in rounds] == [True, False, False]
    assert [r["num"] for r in rounds] == [0, 1, 2]


@needs_node
def test_js_mark_knife_rounds_matches_python():
    from cs2demo.parser import mark_knife_rounds

    rounds, kills, shots = knife_case()
    out = run_js("""
    const { markKnifeRounds } = await import('./cs2demo/web/js/parse/parser.js');
    let s = ''; for await (const c of process.stdin) s += c;
    const { rounds, kills, shots } = JSON.parse(s);
    markKnifeRounds(rounds, kills, shots);
    console.log(JSON.stringify(rounds));
    """, {"rounds": rounds, "kills": kills, "shots": shots})
    mark_knife_rounds(rounds, kills, shots)
    assert out == rounds


def test_knife_round_has_no_highlights():
    from cs2demo.highlights import detect_clutches, detect_highlights
    from cs2demo.parser import mark_knife_rounds

    rounds, kills, shots = knife_case()
    mark_knife_rounds(rounds, kills, shots)
    # a 1v4 in the knife round as well
    rounds[0]["alive"] = {"T": [1], "CT": [5, 6, 7, 8]}
    meta = make_meta(kills, rounds)
    hs = detect_highlights(meta)
    assert hs and all(h["round"] != 0 for h in hs)  # the later knife kill is a highlight, the knife round isn't
    assert all(c["round"] != 0 for c in detect_clutches(meta))


@needs_node
def test_js_stats_skip_knife_round():
    rounds, kills, _shots = knife_case()
    rounds[0]["knife"] = True
    out = run_js("""
    const { DemoData } = await import('./cs2demo/web/js/demo.js');
    let s = ''; for await (const c of process.stdin) s += c;
    const { rounds, kills } = JSON.parse(s);
    const fake = Object.create(DemoData.prototype);
    Object.assign(fake, { rounds, kills, P: 10, players: Array.from({ length: 10 }, () => ({})),
      scoreboard: [{ round: 0, tick: 64 * 60, stats: [] }, { round: 1, tick: 64 * 180, stats: [[0, 0, 0, 200]] }] });
    const st = fake.statsAt(64 * 200);
    console.log(JSON.stringify({ k: st.map((x) => x.k), d: st.map((x) => x.d), adr: st[0].adr }));
    """, {"rounds": rounds, "kills": kills})
    assert out["k"][1] == 0 and out["k"][2] == 2  # the knife round's 4 kills don't count
    assert out["d"][5:] == [0, 1, 1, 0, 0]
    assert out["adr"] == 200  # damage over 1 round played, not 2


# -- voice: Steam packet format --------------------------------------------------------------


def steam_packet(steamid: int, frames: list[bytes]) -> bytes:
    body = b"".join(len(f).to_bytes(2, "little") + i.to_bytes(2, "little") + f for i, f in enumerate(frames))
    body += (0xFFFF).to_bytes(2, "little")
    head = steamid.to_bytes(8, "little") + b"\x0b" + (24000).to_bytes(2, "little") + b"\x06" + len(body).to_bytes(2, "little")
    return head + body + b"\0\0\0\0"


class FakeVoiceParser:
    def __init__(self, packets):
        self.packets = packets

    def parse_voice(self):
        return self.packets


def test_build_voice_finds_the_speaker_in_a_steam_packet():
    from cs2demo import parser as P

    lookup = P._Players(["76561198000000001", "76561198000000002"], ["a", "b"])
    pk = steam_packet(76561198000000002, [b"\x78\x01\x02"])
    rows, _ = P._build_voice(FakeVoiceParser([{"tick": 5, "steamid": 0, "bytes": pk}]), lookup)
    assert rows.tolist() == [[5, 1, len(pk)]]


@needs_node
def test_js_opus_frames_of_both_formats():
    pk = list(steam_packet(76561198000000002, [b"\x78\x01\x02", b"\x70\x09"]))
    out = run_js("""
    const { opusFrames, opusSeconds, isSteamVoice } = await import('./cs2demo/web/js/voice.js');
    let s = ''; for await (const c of process.stdin) s += c;
    const steam = new Uint8Array(JSON.parse(s));
    const plain = new Uint8Array([0x78, 1, 2, 3]);
    const silence = steam.slice(); silence[11] = 0;
    console.log(JSON.stringify({
      steam: isSteamVoice(steam), plain: isSteamVoice(plain),
      frames: opusFrames(steam).map((f) => [...f]), single: opusFrames(plain).map((f) => [...f]),
      silence: opusFrames(silence).length, seconds: opusFrames(steam).map(opusSeconds),
    }));
    """, pk)
    assert out["steam"] is True and out["plain"] is False
    assert out["frames"] == [[0x78, 1, 2], [0x70, 9]]
    assert out["single"] == [[0x78, 1, 2, 3]] and out["silence"] == 0
    assert out["seconds"] == [0.02, 0.01]


@needs_node
def test_js_voice_parity_with_steamid_fallback():
    """The JS parser maps a Steam packet to its speaker like the Python one."""
    pk = list(steam_packet(76561198000000002, [b"\x78\x01\x02"]))
    out = run_js("""
    const { buildVoice } = await import('./cs2demo/web/js/parse/parser.js');
    let s = ''; for await (const c of process.stdin) s += c;
    const bytes = new Uint8Array(JSON.parse(s));
    const lookup = { get: (id) => ({ '76561198000000001': 0, '76561198000000002': 1 }[String(id)] ?? -1) };
    const wasm = { voice: () => ({ ticks: [5], steamids: ['0'], lengths: [bytes.length], data: bytes }) };
    const { voice } = buildVoice(wasm, lookup);
    console.log(JSON.stringify([...voice]));
    """, pk)
    assert out == [5, 1, len(pk)]


# -- sound -------------------------------------------------------------------------------


@needs_node
def test_js_synthesised_sounds_are_levelled_and_vary():
    out = run_js("""
    const A = await import('./cs2demo/web/js/audio.js');
    const sr = 48000, res = {};
    for (const n of A.SOUND_NAMES) {
      const a = A.synthesize(n, sr, 0), b = A.synthesize(n, sr, 1);
      let pk = 0, st = 0, finite = true, diff = 0;
      for (let i = 0; i < a.length; i++) { pk = Math.max(pk, Math.abs(a[i])); finite &&= Number.isFinite(a[i]); diff += Math.abs(a[i] - (b[i] || 0)); }
      for (let i = 0; i < a.length; i += 600) { let e = 0; for (let j = i; j < Math.min(a.length, i + 2400); j++) e += a[j] ** 2; st = Math.max(st, Math.sqrt(e / 2400)); }
      res[n] = { len: a.length / sr, peak: pk, loud: 20 * Math.log10(st), finite, differs: diff > 1 || n === 'bomb_beep' };
    }
    console.log(JSON.stringify({ res, samples: A.SAMPLES }));
    """)
    res = out["res"]
    for name, r in res.items():
        assert r["finite"] and 0.05 < r["len"] < 4 and 0 < r["peak"] <= 1, name
        assert r["differs"], f"{name}: takes are identical"
    for gun in ("rifle", "ak47", "m4", "pistol", "smg", "deagle", "sniper", "shotgun", "lmg"):
        assert -15 < res[gun]["loud"] < -7, gun
    assert res["silenced"]["loud"] < res["pistol"]["loud"] - 2
    assert res["he"]["loud"] > res["ak47"]["loud"]
    for files in out["samples"].values():
        for f in files:
            wav = ROOT / "cs2demo/web/audio" / f"{f}.wav"
            assert wav.is_file() and wav.stat().st_size > 1000, f


@needs_node
def test_js_grenade_bounces_and_spatial():
    out = run_js("""
    const A = await import('./cs2demo/web/js/audio.js');
    // a grenade thrown at 8 u/tick sideways, 6 up from 100 units; sv_gravity 800 at 64 tick
    const rate = 64, g = 800 / rate / rate;
    let x = 0, z = 100, vx = 8, vz = 6, impact = null;
    const ticks = [], pts = [];
    for (let t = 0; t < 200; t++) {
      if (t % 4 === 0) { ticks.push(t); pts.push(x, 0, z); }
      x += vx; vz -= g; z += vz;
      if (z < 0) { z = 0; vz = -vz * 0.45; vx *= 0.6; impact ??= t; }
    }
    const demo = { tickRate: rate, grenades: [{ type: 'he', ticks, pts }] };
    const bounces = A.grenadeBounces(demo).map((b) => b[0]);
    const L = { x: 0, y: 0, z: 0, yaw: 0 };
    const gains = [50, 500, 1500, 3000, 5000, 6000].map((d) => A.spatial(L, [d, 0, 0], 'ak47')?.gain ?? null);
    const left = A.spatial(L, [0, 300, 0], 'ak47').pan;
    const farStep = A.spatial(L, [2000, 0, 0], 'step');
    console.log(JSON.stringify({ impact, bounces, gains, left, farStep }));
    """)
    assert out["bounces"] and abs(out["bounces"][0] - out["impact"]) <= 8
    assert all(b >= out["impact"] - 8 for b in out["bounces"])  # nothing during the free flight
    gains = [g for g in out["gains"] if g is not None]
    assert gains == sorted(gains, reverse=True) and out["gains"][-1] is None
    assert out["left"] < 0  # yaw 0 looks along +x: +y is on the left
    assert out["farStep"] is None


@needs_node
def test_js_hit_sounds_follow_helmet_and_prefs():
    out = run_js("""
    const A = await import('./cs2demo/web/js/audio.js');
    const demo = { tickRate: 64, startTick: 0, shots: [], effects: {}, grenades: [], bomb: [],
      hurts: [[10, 0, 1, 27, 'ak47', 'head'], [20, 0, 2, 27, 'ak47', 'head'], [30, 0, 1, 20, 'ak47', 'chest']],
      state: (p, t, out = {}) => Object.assign(out, { x: 0, y: 0, z: 0, helmet: p === 1 }) };
    const names = () => A.collectEvents(demo, 0, 100, -1, { footsteps: false }).map((e) => e.name);
    const on = names();
    A.setSoundPref('hits', false);
    const off = names();
    A.setSoundPref('hits', true);
    console.log(JSON.stringify({ on, off }));
    """)
    assert out["on"] == ["helmet", "headshot", "hit"]
    assert out["off"] == []


def test_audio_files_are_packaged():
    text = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert '"web/audio/*"' in text
    assert (ROOT / "cs2demo/web/audio/LICENSE.txt").read_text(encoding="utf-8").count("CC0") >= 1
    assert np.all([p.suffix in (".wav", ".txt") for p in (ROOT / "cs2demo/web/audio").iterdir()])
    assert RATE == 64


# -- smoke lineups -------------------------------------------------------------------------

LINEUP_DEMO = """
const { DemoData, FLAG } = await import('./cs2demo/web/js/demo.js');
// 2 players, 64 tick, a frame every 2 ticks. Player 0 (T) stands in T spawn,
// holds the left button, jumps and releases a smoke at tick 300 that lands
// 1500 units away (where player 1 stands, on the bombsite); player 1 drops a
// smoke at their feet at tick 600.
const rate = 64, step = 2, count = 450, P = 2, U = 6;
const KEYS = ['W', 'A', 'S', 'D', 'SPACE', 'CTRL', 'SHIFT', 'LMB', 'RMB', 'R', 'E', 'TAB', 'F', 'WHEEL'];
const sizes = { pos: count * P * 12, ang: count * P * 4, u8: count * P * U, money: count * P * 2, keys: count * P * 2 };
let off = 0;
const sections = Object.entries(sizes).map(([name, bytes]) => { const s = { name, offset: off, bytes }; off += bytes; return s; });
const buf = new ArrayBuffer(off);
const at = Object.fromEntries(sections.map((s) => [s.name, s]));
const pos = new Float32Array(buf, at.pos.offset, count * P * 3), ang = new Int16Array(buf, at.ang.offset, count * P * 2);
const u8 = new Uint8Array(buf, at.u8.offset, count * P * U), keys = new Uint16Array(buf, at.keys.offset, count * P);
for (let f = 0; f < count; f++) {
  const tick = f * step;
  for (let p = 0; p < P; p++) {
    const i = f * P + p;
    pos.set(p === 0 ? [0, 0, tick >= 302 && tick < 340 ? 40 : 0] : [1500, 60, 0], i * 3);
    ang.set(p === 0 ? [0, -1500] : [18000, 0], i * 2); // yaw 0, pitch -15
    let flags = FLAG.PRESENT | FLAG.ALIVE | (p === 1 ? FLAG.CT : 0);
    if (p === 0 && tick >= 302 && tick < 340) flags |= FLAG.AIRBORNE;
    u8.set([100, 100, flags, 0, 0, p === 0 ? 2 : 1], i * U);
    if (p === 0 && tick >= 200 && tick < 300) keys[i] = 1 << KEYS.indexOf('LMB');
    if (p === 0 && tick >= 296 && tick < 304) keys[i] |= 1 << KEYS.indexOf('SPACE');
  }
}
const line = (from, to, t0, t1) => { const ticks = [], pts = [];
  for (let t = t0; t <= t1; t += 4) { const k = (t - t0) / (t1 - t0); ticks.push(t); pts.push(from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k + 300 * Math.sin(Math.PI * k)); }
  return { ticks, pts }; };
const meta = {
  map: 'de_test', tickRate: rate, players: [{ name: 'thrower' }, { name: 'ct' }],
  rounds: [{ num: 1, start: 0, freezeEnd: 100, end: 880, next: 900 }], kills: [],
  grenades: [{ type: 'smoke', thrower: 0, ...line([0, 0, 64], [1500, 0, 0], 300, 500) },
             { type: 'smoke', thrower: 1, ...line([1500, 60, 64], [1560, 60, 0], 600, 640) },
             { type: 'flash', thrower: 0, ...line([0, 0, 64], [500, 0, 0], 700, 760) }],
  effects: { smokes: [{ start: 520, end: 1600, pos: [1500, 0, 0], thrower: 0 }, { start: 660, end: 1700, pos: [1560, 60, 0], thrower: 1 }] },
  places: ['', 'BombsiteA', 'TSpawn'], weapons: [''],
  frames: { startTick: 0, endTick: (count - 1) * step, step, count, players: P, u8Fields: ['health', 'armor', 'flags', 'weapon', 'duck', 'place'],
    sections, keys: KEYS, keysKnown: KEYS },
};
const demo = new DemoData(meta, buf);
"""


@needs_node
def test_js_smoke_lineups():
    out = run_js(LINEUP_DEMO + """
    const L = await import('./cs2demo/web/js/lineups.js');
    const { throws, lineups } = L.findSmokes(demo);
    const pick = (l) => ({ title: l.title, technique: l.technique, click: l.click, distance: l.distance, interesting: l.interesting,
      player: l.player, land: l.land, flight: l.flight, from: l.from, setpos: L.setposCommand(l), tags: l.tags });
    console.log(JSON.stringify({ n: throws.length, lineups: lineups.map(pick), place: L.placeName('TopofMid') }));
    """)
    assert out["n"] == 2  # the flash isn't a smoke
    best, feet = out["lineups"]
    assert best["title"] == "Bombsite A ← T Spawn" and best["player"] == 0
    assert best["technique"] == "jump" and best["click"] == "left"
    assert best["distance"] == 1500 and best["interesting"] and best["land"] == 520 and best["flight"] == 3.44
    assert best["from"] == [0, 0, 0]  # where the jump started, on the ground
    assert best["setpos"] == "setpos 0.00 0.00 0.00; setang -15.00 0.00 0"
    assert best["tags"][:2] == ["джампсроу", "ЛКМ"]
    assert feet["technique"] == "stand" and not feet["interesting"] and feet["distance"] < 100
    assert out["place"] == "Top of Mid"


def test_cli_smokes_command():
    from cs2demo.cli import build_parser

    args = build_parser().parse_args(["smokes", "demo1", "--ids", "a,b", "--top", "3", "--voice", "off"])
    assert args.func.__name__ == "cmd_smokes" and args.ids == "a,b" and args.top == 3 and args.voice == "off"
    assert build_parser().parse_args(["smokes", "demo1", "--list"]).list is True


def test_render_smokes_validates_voice():
    from cs2demo.recorder import render_smokes

    with pytest.raises(ValueError):
        render_smokes("x", base_url="http://127.0.0.1:1", voice="loud")


@needs_node
def test_js_bomb_beeps_stop_with_the_round():
    """All CTs dead after the plant: the round ends, the bomb never explodes and must
    not beep on into later rounds (until some other bomb's explosion)."""
    out = run_js("""
    const A = await import('./cs2demo/web/js/audio.js');
    const rate = 64, s = (x) => x * rate;
    const demo = { tickRate: rate, startTick: 0, endTick: s(400), shots: [], hurts: [], effects: {}, grenades: [],
      rounds: [{ start: 0, end: s(100), next: s(107) }, { start: s(107), end: s(200), next: s(207) }, { start: s(207), end: s(300), next: s(307) }],
      bomb: [{ tick: s(80), type: 'plant', pos: [0, 0, 0] },                 // round 1: CTs die, no explosion
             { tick: s(250), type: 'plant', pos: [0, 0, 0] }, { tick: s(291), type: 'explode' }],  // round 3: explodes
      state: (p, t, out = {}) => Object.assign(out, { x: 0, y: 0, z: 0 }) };
    const ev = A.collectEvents(demo, -1, s(400), -1, { footsteps: false });
    const beeps = ev.filter((e) => e.name === 'bomb_beep').map((e) => e.tick / rate);
    console.log(JSON.stringify({ timers: A.bombTimers(demo).map((c) => [c.plant / rate, c.end / rate, c.how]),
      round2: beeps.filter((t) => t >= 107 && t < 207).length, last1: Math.max(...beeps.filter((t) => t < 107)),
      names: [...new Set(ev.map((e) => e.name))].sort() }));
    """)
    assert out["timers"] == [[80, 107, None], [250, 291, "explode"]]
    assert out["round2"] == 0 and out["last1"] < 107
    assert out["names"] == ["bomb_beep", "bomb_planted", "c4_explode"]
