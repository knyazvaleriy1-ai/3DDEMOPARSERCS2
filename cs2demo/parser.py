"""Parse a CS2 ``.dem`` file into the compact format the 3D viewer consumes.

Output (see ``write_parsed``):

* ``meta.json``  – header, players, rounds, kills, shots, grenades, effects,
  bomb timeline, scoreboard snapshots and auto-detected highlights.
* ``frames.bin`` – per-player state sampled every ``step`` ticks, stored as
  little-endian sections (offsets are listed in ``meta["frames"]``):

  ``pos``   float32[F][P][3]  world X, Y, Z (Hammer units, Z up)
  ``ang``   int16[F][P][2]    yaw, pitch in centi-degrees
  ``u8``    uint8[F][P][6]    health, armor, flags, weapon, duck, place
  ``money`` uint16[F][P]      account balance
  ``keys``  uint16[F][P]      keys held (``KEY_NAMES``) for the on-screen keyboard

  and the voice chat recorded in the demo (FACEIT, ESEA, local POV demos;
  ``meta["voice"]`` lists who speaks):

  ``voice``     uint32[N][3]  tick, player, byte length of each packet
  ``voiceData`` uint8[...]    the packets (Opus frames) back to back

Flags: see the ``FLAG_*`` constants below.
"""

from __future__ import annotations

import json
import math
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable

import numpy as np

from . import __version__

FORMAT_VERSION = 1

FLAG_PRESENT = 1
FLAG_ALIVE = 2
FLAG_CT = 4
FLAG_SCOPED = 8
FLAG_DEFUSING = 16
FLAG_HELMET = 32
FLAG_DEFUSER = 64
FLAG_AIRBORNE = 128

# On-screen keyboard: bit i of the "keys" section is KEY_NAMES[i], i.e. bit
# KEY_BUTTONS[i][1] of the game's button mask (m_nButtonDownMaskPrev).
KEY_BUTTONS = [
    ("W", 3), ("A", 9), ("S", 4), ("D", 10), ("SPACE", 1), ("CTRL", 2), ("SHIFT", 16),
    ("LMB", 0), ("RMB", 11), ("R", 13), ("E", 5), ("TAB", 33), ("F", 35),
]  # fmt: skip
KEY_SPACE = 4
# A jump with the jump button never held was bound to the mouse wheel: a scroll
# presses and releases +jump within one tick, so the mask never shows it.
KEY_WHEEL = 13
KEY_NAMES = [name for name, _bit in KEY_BUTTONS] + ["WHEEL"]
# demoparser2's single-button props -> bit of the mask. (Its raw "buttons"
# column is missing in some demos; these come from the same mask.)
BUTTON_PROPS = {
    "FORWARD": 3, "LEFT": 9, "BACK": 4, "RIGHT": 10, "JUMP": 1, "DUCK": 2, "WALK": 16,
    "FIRE": 0, "RIGHTCLICK": 11, "RELOAD": 13, "USE": 5, "SCOREBOARD": 33, "INSPECT": 35,
}  # fmt: skip
# Not every demoparser2 has all of them: 0.42.0 lacks JUMP and DUCK, and WALK
# never comes out (mapped to "IN_WALK"; fixed in the WebAssembly build), so
# meta["frames"]["keysKnown"] lists the keys there is data for.

U8_FIELDS = ["health", "armor", "flags", "weapon", "duck", "place"]

TICK_PROPS = [
    "X",
    "Y",
    "Z",
    "yaw",
    "pitch",
    "health",
    "armor_value",
    "team_num",
    "is_alive",
    "active_weapon_name",
    "balance",
    "has_helmet",
    "has_defuser",
    "is_scoped",
    "is_defusing",
    "duck_amount",
    "last_place_name",
    "game_time",
    "is_airborne",
]

SCOREBOARD_PROPS = [
    "kills_total",
    "deaths_total",
    "assists_total",
    "damage_total",
    "team_rounds_total",
    "mvps",
    "score",
    "team_clan_name",
]

EVENTS = [
    "begin_new_match",
    "round_start",
    "round_freeze_end",
    "round_end",
    "round_officially_ended",
    "player_death",
    "player_hurt",
    "player_blind",
    "weapon_fire",
    "bomb_pickup",
    "bomb_dropped",
    "bomb_beginplant",
    "bomb_planted",
    "bomb_begindefuse",
    "bomb_defused",
    "bomb_exploded",
    "smokegrenade_detonate",
    "smokegrenade_expired",
    "inferno_startburn",
    "inferno_expire",
    "flashbang_detonate",
    "hegrenade_detonate",
    "decoy_started",
    "decoy_detonate",
]

GRENADE_TYPES = {
    "CSmokeGrenadeProjectile": "smoke",
    "CFlashbangProjectile": "flash",
    "CHEGrenadeProjectile": "he",
    "CMolotovProjectile": "molotov",
    "CIncendiaryGrenadeProjectile": "molotov",
    "CDecoyProjectile": "decoy",
}

SMOKE_SECONDS = 20.0
INFERNO_SECONDS = 7.0
DECOY_SECONDS = 15.0

ProgressFn = Callable[[float, str], None]


class DemoParseError(RuntimeError):
    pass


def _noop_progress(_fraction: float, _message: str) -> None:
    pass


def _is_missing(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    try:
        import pandas as pd

        return bool(pd.isna(value))
    except (TypeError, ValueError, ImportError):
        return False


def _sid(value: Any) -> str | None:
    """Normalise a steamid column value to a string (or None)."""
    if _is_missing(value):
        return None
    if isinstance(value, str):
        value = value.strip()
        if value.endswith(".0"):
            value = value[:-2]
        return value or None
    if isinstance(value, float):
        return str(int(value))
    return str(int(value))


def _str(value: Any) -> str:
    return "" if _is_missing(value) else str(value)


def _bool(value: Any) -> bool:
    if _is_missing(value):
        return False
    if isinstance(value, str):
        return value.lower() in ("true", "1")
    return bool(value)


def _num(value: Any, default: float = 0.0) -> float:
    if _is_missing(value):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _player_key(steamid: Any, name: Any) -> str:
    sid = _sid(steamid)
    if not sid or sid == "0":
        return f"bot:{_str(name)}"
    return sid


class _Players:
    """Maps steamids / bot names from events to player indices."""

    def __init__(self, keys: list[str], names: list[str]):
        self.index = {k: i for i, k in enumerate(keys)}
        self.by_name = {}
        for i, n in enumerate(names):
            self.by_name.setdefault(n, i)

    def get(self, steamid: Any, name: Any = None) -> int:
        key = _player_key(steamid, name)
        if key in self.index:
            return self.index[key]
        if name is not None and _str(name) in self.by_name:
            return self.by_name[_str(name)]
        return -1


def _events(parser: Any) -> dict[str, Any]:
    # Not filtered by list_game_events(): demoparser2 synthesises some events
    # (round_start / round_end) that the demo's event list doesn't contain.
    # Missing names are simply absent from the result.
    try:
        return dict(parser.parse_events(EVENTS))
    except Exception:  # noqa: BLE001 - fall back to one pass per event
        out = {}
        for name in EVENTS:
            try:
                out[name] = parser.parse_event(name)
            except Exception:  # noqa: BLE001
                continue
        return out


def _rows(events: dict[str, Any], name: str) -> list[dict[str, Any]]:
    df = events.get(name)
    if df is None or len(df) == 0:
        return []
    return df.sort_values("tick", kind="stable").to_dict("records")


def _detect_tick_rate(df: Any) -> float:
    try:
        sub = df[["tick", "game_time"]].drop_duplicates("tick").sort_values("tick")
        if len(sub) < 2:
            return 64.0
        dt = float(sub["game_time"].iloc[-1] - sub["game_time"].iloc[0])
        dtick = float(sub["tick"].iloc[-1] - sub["tick"].iloc[0])
        if dt <= 0:
            return 64.0
        rate = dtick / dt
        for candidate in (64.0, 128.0, 32.0):
            if abs(rate - candidate) / candidate < 0.05:
                return candidate
        return round(rate, 3)
    except Exception:  # noqa: BLE001
        return 64.0


def parse_demo(
    path: str | Path,
    step: int | None = None,
    progress: ProgressFn | None = None,
) -> tuple[dict[str, Any], bytes]:
    """Parse ``path`` and return ``(meta, frames_bytes)``."""
    from demoparser2 import DemoParser  # imported lazily: heavy native module

    progress = progress or _noop_progress
    path = Path(path)
    started = time.time()
    progress(0.02, "Чтение заголовка")
    try:
        parser = DemoParser(str(path))
        header = parser.parse_header()
    except Exception as exc:  # noqa: BLE001
        raise DemoParseError(f"Не удалось открыть демо: {exc}") from exc

    progress(0.08, "Игровые события")
    events = _events(parser)
    last_event_tick = 0
    for df in events.values():
        if len(df):
            last_event_tick = max(last_event_tick, int(df["tick"].max()))

    if step is None:
        step = 2
    step = max(1, int(step))

    progress(0.2, "Позиции игроков")
    tick_list = list(range(0, last_event_tick + 64 * 300, step))
    df = parser.parse_ticks(TICK_PROPS + list(BUTTON_PROPS), ticks=tick_list)
    if df is None or len(df) == 0:
        raise DemoParseError("В демо нет данных об игроках")
    tick_rate = _detect_tick_rate(df)

    progress(0.45, "Сборка кадров")
    df = df[df["team_num"].isin([2, 3])]
    keys = [_player_key(s, n) for s, n in zip(df["steamid"].tolist(), df["name"].tolist(), strict=True)]
    df = df.assign(_key=keys)
    alive = df["is_alive"].astype(bool)
    # Coaches and casters can be "alive" during warmup only: count life after match start.
    match_starts = [int(t) for t in events["begin_new_match"]["tick"]] if "begin_new_match" in events else []
    if match_starts:
        after = alive & (df["tick"] > max(match_starts))
        if after.any():
            alive = after
    # ...and some coach slots sit "alive" in one spot (teleported between halves)
    # for the whole match: require real walking, not just one jump.
    alive_rows = df.loc[alive, ["_key", "tick", "X", "Y"]].sort_values(["_key", "tick"])
    step_len = np.hypot(alive_rows.groupby("_key")["X"].diff(), alive_rows.groupby("_key")["Y"].diff())
    walking = ((step_len > 0.5) & (step_len < 200)).groupby(alive_rows["_key"]).sum()
    alive_keys = set(walking.index[walking >= 20])
    df = df[df["_key"].isin(alive_keys)]
    if len(df) == 0:
        raise DemoParseError("В демо не найдено живых игроков")

    t0 = int(df["tick"].min())
    t1 = int(df["tick"].max())
    t0 -= t0 % step
    frame_count = (t1 - t0) // step + 1

    # Player list: ordered by starting side, then name.
    info: dict[str, dict[str, Any]] = {}
    for key, grp in df.groupby("_key", sort=False):
        alive = grp[grp["is_alive"].astype(bool)]
        first = alive.iloc[0] if len(alive) else grp.iloc[0]
        names = grp["name"].astype(str)
        info[key] = {
            "key": key,
            "steamid": "" if key.startswith("bot:") else key,
            "name": names.iloc[-1],
            "bot": key.startswith("bot:"),
            "startSide": "CT" if int(first["team_num"]) == 3 else "T",
        }
    order = sorted(info, key=lambda k: (info[k]["startSide"] != "T", info[k]["name"].lower()))
    players = [info[k] for k in order]
    pindex = {k: i for i, k in enumerate(order)}
    player_count = len(players)
    lookup = _Players(order, [p["name"] for p in players])

    weapons = [""] + sorted({w for w in df["active_weapon_name"].dropna().astype(str).unique() if w})[:255]
    weapon_idx = {w: i for i, w in enumerate(weapons)}
    places = [""] + sorted({p for p in df["last_place_name"].dropna().astype(str).unique() if p})[:255]
    place_idx = {p: i for i, p in enumerate(places)}

    fi = ((df["tick"].to_numpy() - t0) // step).astype(np.int64)
    pi = df["_key"].map(pindex).to_numpy().astype(np.int64)

    pos = np.zeros((frame_count, player_count, 3), dtype="<f4")
    ang = np.zeros((frame_count, player_count, 2), dtype="<i2")
    u8 = np.zeros((frame_count, player_count, len(U8_FIELDS)), dtype=np.uint8)
    money = np.zeros((frame_count, player_count), dtype="<u2")
    keys = np.zeros((frame_count, player_count), dtype="<u2")

    pos[fi, pi, 0] = df["X"].to_numpy(dtype=np.float32, na_value=0)
    pos[fi, pi, 1] = df["Y"].to_numpy(dtype=np.float32, na_value=0)
    pos[fi, pi, 2] = df["Z"].to_numpy(dtype=np.float32, na_value=0)
    yaw = df["yaw"].to_numpy(dtype=np.float64, na_value=0)
    yaw = (yaw + 180.0) % 360.0 - 180.0
    pitch = np.clip(df["pitch"].to_numpy(dtype=np.float64, na_value=0), -90, 90)
    ang[fi, pi, 0] = np.round(yaw * 100).astype(np.int16)
    ang[fi, pi, 1] = np.round(pitch * 100).astype(np.int16)

    def col_bool(name: str) -> np.ndarray:
        if name not in df:
            return np.zeros(len(df), dtype=bool)
        return df[name].fillna(False).astype(bool).to_numpy()

    flags = np.full(len(df), FLAG_PRESENT, dtype=np.uint8)
    flags |= np.where(col_bool("is_alive"), FLAG_ALIVE, 0).astype(np.uint8)
    flags |= np.where(df["team_num"].to_numpy() == 3, FLAG_CT, 0).astype(np.uint8)
    flags |= np.where(col_bool("is_scoped"), FLAG_SCOPED, 0).astype(np.uint8)
    flags |= np.where(col_bool("is_defusing"), FLAG_DEFUSING, 0).astype(np.uint8)
    flags |= np.where(col_bool("has_helmet"), FLAG_HELMET, 0).astype(np.uint8)
    flags |= np.where(col_bool("has_defuser"), FLAG_DEFUSER, 0).astype(np.uint8)
    flags |= np.where(col_bool("is_airborne"), FLAG_AIRBORNE, 0).astype(np.uint8)

    u8[fi, pi, 0] = np.clip(df["health"].fillna(0).to_numpy(), 0, 255).astype(np.uint8)
    u8[fi, pi, 1] = np.clip(df["armor_value"].fillna(0).to_numpy(), 0, 255).astype(np.uint8)
    u8[fi, pi, 2] = flags
    u8[fi, pi, 3] = (
        df["active_weapon_name"].map(weapon_idx).fillna(0).to_numpy(dtype=np.int64).clip(0, 255).astype(np.uint8)
    )
    u8[fi, pi, 4] = np.clip(df["duck_amount"].fillna(0).to_numpy() * 255, 0, 255).astype(np.uint8)
    u8[fi, pi, 5] = (
        df["last_place_name"].map(place_idx).fillna(0).to_numpy(dtype=np.int64).clip(0, 255).astype(np.uint8)
    )
    money[fi, pi] = np.clip(df["balance"].fillna(0).to_numpy(), 0, 65535).astype(np.uint16)
    masks, keys_known = _button_masks(df, col_bool)
    keys[fi, pi] = keys_from_buttons(masks)
    if "SPACE" in keys_known and "is_airborne" in df:
        mark_wheel_jumps(keys, u8[:, :, 2], pos[:, :, 2], step)
        keys_known.append("WHEEL")

    def frame_of(tick: int) -> int:
        return int(min(max((tick - t0) // step, 0), frame_count - 1))

    def state(tick: int, p: int) -> tuple[int, list[float]]:
        f = frame_of(tick)
        return int(u8[f, p, 2]), [round(float(v), 1) for v in pos[f, p]]

    def side(tick: int, p: int) -> str | None:
        if p < 0:
            return None
        flags_ = int(u8[frame_of(tick), p, 2])
        if not flags_ & FLAG_PRESENT:
            return None
        return "CT" if flags_ & FLAG_CT else "T"

    progress(0.6, "Раунды и события")
    rounds = _build_rounds(events, t0, t1)
    _attach_alive(rounds, u8, frame_of, player_count)

    def round_of(tick: int) -> int:
        for i, r in enumerate(rounds):
            if r["start"] <= tick <= r["next"]:
                return i
        return -1

    kills = []
    for row in _rows(events, "player_death"):
        tick = int(row["tick"])
        a = lookup.get(row.get("attacker_steamid"), row.get("attacker_name"))
        v = lookup.get(row.get("user_steamid"), row.get("user_name"))
        if v < 0:
            continue
        asst = lookup.get(row.get("assister_steamid"), row.get("assister_name"))
        a_side, v_side = side(tick, a), side(tick, v)
        kills.append(
            {
                "tick": tick,
                "round": round_of(tick),
                "attacker": a,
                "victim": v,
                "assister": asst,
                "weapon": _str(row.get("weapon")),
                "headshot": _bool(row.get("headshot")),
                "penetrated": int(_num(row.get("penetrated"))),
                "noscope": _bool(row.get("noscope")),
                "smoke": _bool(row.get("thrusmoke")),
                "blind": _bool(row.get("attackerblind")),
                "air": _bool(row.get("attackerinair")),
                "flashAssist": _bool(row.get("assistedflash")),
                "distance": round(_num(row.get("distance")), 1),
                "attackerSide": a_side,
                "victimSide": v_side,
                "teamkill": a >= 0 and a != v and a_side is not None and a_side == v_side,
                "pos": state(tick, v)[1],
                "attackerPos": state(tick, a)[1] if a >= 0 else None,
            }
        )

    shots = []
    for row in _rows(events, "weapon_fire"):
        p = lookup.get(row.get("user_steamid"), row.get("user_name"))
        if p >= 0:
            shots.append([int(row["tick"]), p, _str(row.get("weapon")).replace("weapon_", "")])
    mark_knife_rounds(rounds, kills, shots)

    hurts = []
    for row in _rows(events, "player_hurt"):
        v = lookup.get(row.get("user_steamid"), row.get("user_name"))
        if v < 0:
            continue
        a = lookup.get(row.get("attacker_steamid"), row.get("attacker_name"))
        hurts.append(
            [
                int(row["tick"]),
                a,
                v,
                int(_num(row.get("dmg_health"))),
                int(_num(row.get("health"))),
                _str(row.get("hitgroup")),
                _str(row.get("weapon")),
            ]
        )

    blinds = []
    for row in _rows(events, "player_blind"):
        v = lookup.get(row.get("user_steamid"), row.get("user_name"))
        if v < 0:
            continue
        a = lookup.get(row.get("attacker_steamid"), row.get("attacker_name"))
        blinds.append([int(row["tick"]), v, a, round(_num(row.get("blind_duration")), 2)])

    round_starts = sorted(r["start"] for r in rounds)

    def next_round_start(tick: int) -> int:
        for s in round_starts:
            if s > tick:
                return s
        return t1

    effects = _build_effects(events, lookup, tick_rate, next_round_start)

    bomb = []
    bomb_types = {
        "bomb_pickup": "pickup",
        "bomb_dropped": "drop",
        "bomb_beginplant": "beginplant",
        "bomb_planted": "plant",
        "bomb_begindefuse": "begindefuse",
        "bomb_defused": "defuse",
        "bomb_exploded": "explode",
    }
    for ev, kind in bomb_types.items():
        for row in _rows(events, ev):
            tick = int(row["tick"])
            p = lookup.get(row.get("user_steamid"), row.get("user_name"))
            entry = {"tick": tick, "type": kind, "player": p}
            if p >= 0:
                entry["pos"] = state(tick, p)[1]
            bomb.append(entry)
    bomb.sort(key=lambda e: (e["tick"], list(bomb_types.values()).index(e["type"])))

    progress(0.7, "Траектории гранат")
    grenades = _build_grenades(parser, lookup, step)

    progress(0.75, "Голосовой чат")
    voice, voice_data = _build_voice(parser, lookup)

    progress(0.8, "Статистика")
    scoreboard = _build_scoreboard(parser, rounds, lookup, players)
    _attach_places(bomb, kills, u8, places, frame_of)

    meta: dict[str, Any] = {
        "format": FORMAT_VERSION,
        "generator": f"cs2demo {__version__}",
        "file": path.name,
        "map": _str(header.get("map_name")) or "unknown",
        "server": _str(header.get("server_name")),
        "client": _str(header.get("client_name")),
        "build": _str(header.get("patch_version")),
        "tickRate": tick_rate,
        "parsedAt": int(time.time()),
        "parseSeconds": None,
        "players": players,
        "weapons": weapons,
        "places": places,
        "rounds": rounds,
        "kills": kills,
        "shots": shots,
        "hurts": hurts,
        "blinds": blinds,
        "bomb": bomb,
        "grenades": grenades,
        "effects": effects,
        "scoreboard": scoreboard,
        "voice": {"packets": len(voice), "speakers": sorted({int(p) for p in voice[:, 1]})},
    }

    sections = []
    offset = 0
    blobs = []
    for name, arr, dtype in (
        ("pos", pos, "float32"),
        ("ang", ang, "int16"),
        ("u8", u8, "uint8"),
        ("money", money, "uint16"),
        ("keys", keys, "uint16"),
        ("voice", voice, "uint32"),
        ("voiceData", voice_data, "uint8"),
    ):
        raw = arr.tobytes(order="C")
        sections.append({"name": name, "dtype": dtype, "offset": offset, "bytes": len(raw)})
        blobs.append(raw)
        offset += len(raw)
        pad = (-offset) % 8
        if pad:
            blobs.append(b"\0" * pad)
            offset += pad
    meta["frames"] = {
        "startTick": t0,
        "endTick": t1,
        "step": step,
        "count": frame_count,
        "players": player_count,
        "u8Fields": U8_FIELDS,
        "keys": KEY_NAMES,
        "keysKnown": keys_known,
        "sections": sections,
    }

    progress(0.9, "Поиск хайлайтов")
    from .highlights import detect_highlights

    meta["highlights"] = detect_highlights(meta)
    meta["parseSeconds"] = round(time.time() - started, 2)
    progress(1.0, "Готово")
    return meta, b"".join(blobs)


def _button_masks(df: Any, col_bool: Callable[[str], np.ndarray]) -> tuple[np.ndarray, list[str]]:
    """Game button mask per row from the single-button columns, and the
    on-screen keyboard keys those columns cover."""
    masks = np.zeros(len(df), dtype=np.uint64)
    for name, bit in BUTTON_PROPS.items():
        masks |= np.where(col_bool(name), np.uint64(1 << bit), np.uint64(0))
    bits = {bit for name, bit in BUTTON_PROPS.items() if name in df}
    return masks, [key for key, bit in KEY_BUTTONS if bit in bits]


def keys_from_buttons(masks: np.ndarray) -> np.ndarray:
    """Game button masks (uint64) -> bits of the "keys" section (uint16)."""
    masks = np.asarray(masks, dtype=np.uint64)
    out = np.zeros(masks.shape, dtype=np.uint16)
    for i, (_name, bit) in enumerate(KEY_BUTTONS):
        out |= ((masks >> np.uint64(bit)) & np.uint64(1)).astype(np.uint16) << np.uint16(i)
    return out


def mark_wheel_jumps(keys: np.ndarray, flags: np.ndarray, z: np.ndarray, step: int) -> None:
    """Set KEY_WHEEL around jumps made without the jump button ([F][P] arrays).

    A jump: on the ground, then airborne and at least 8 units higher 6 ticks
    later. If Space wasn't held from 12 ticks before to 4 ticks after the
    take-off, the jump came from the mouse wheel; mark it for 8 ticks."""
    frames = keys.shape[0]
    rise, back, ahead, mark = max(1, 6 // step), max(1, 12 // step), max(1, 4 // step), max(1, 8 // step)
    if frames <= rise + 1:
        return
    air = (flags & FLAG_AIRBORNE) != 0
    alive = (flags & FLAG_ALIVE) != 0
    space = (keys & (1 << KEY_SPACE)) != 0
    zz = z.astype(np.float64)
    f = np.arange(1, frames - rise)
    takeoff = ~air[f - 1] & air[f] & alive[f - 1] & alive[f] & (zz[f + rise] - zz[f - 1] > 8.0)
    for i, p in zip(*np.nonzero(takeoff), strict=True):
        t = int(f[i])
        if space[max(0, t - back) : t + ahead + 1, p].any():
            continue
        keys[max(0, t - 1) : t - 1 + mark, p] |= 1 << KEY_WHEEL


def _build_rounds(events: dict[str, Any], t0: int, t1: int) -> list[dict[str, Any]]:
    starts = sorted({int(r["tick"]) for r in _rows(events, "round_start")})
    freezes = sorted({int(r["tick"]) for r in _rows(events, "round_freeze_end")})
    officials = sorted({int(r["tick"]) for r in _rows(events, "round_officially_ended")})
    match_starts = [int(r["tick"]) for r in _rows(events, "begin_new_match")]
    ends = []
    seen = set()
    for row in _rows(events, "round_end"):
        tick = int(row["tick"])
        # demoparser2 emits a synthetic round_end (no winner, no reason) at the
        # start of some recordings; it is not a played round.
        if tick in seen or (_is_missing(row.get("winner")) and _is_missing(row.get("reason"))):
            continue
        seen.add(tick)
        ends.append(row)
    if match_starts:
        ms = match_starts[-1]
        kept = [e for e in ends if int(e["tick"]) > ms]
        if kept:
            ends = kept

    rounds: list[dict[str, Any]] = []
    prev_end = t0
    for i, row in enumerate(ends):
        end = int(row["tick"])
        cands = [s for s in starts if prev_end <= s <= end]
        start = cands[-1] if cands else prev_end
        fcands = [f for f in freezes if start <= f <= end]
        freeze_end = fcands[0] if fcands else start
        winner = _str(row.get("winner")).upper()
        if winner in ("TERRORIST", "2"):
            winner = "T"
        elif winner in ("3",):
            winner = "CT"
        if winner not in ("T", "CT"):
            winner = None
        rounds.append(
            {
                "num": i + 1,
                "start": start,
                "freezeEnd": freeze_end,
                "end": end,
                "winner": winner,
                "reason": _str(row.get("reason")),
            }
        )
        prev_end = end

    # A round still in progress when the recording stopped.
    tail = [s for s in starts if s > prev_end]
    if tail and t1 - tail[-1] > 64 * 5:
        start = tail[-1]
        fcands = [f for f in freezes if f >= start]
        rounds.append(
            {
                "num": len(rounds) + 1,
                "start": start,
                "freezeEnd": fcands[0] if fcands else start,
                "end": t1,
                "winner": None,
                "reason": "",
            }
        )

    if not rounds:
        rounds.append(
            {"num": 1, "start": t0, "freezeEnd": t0, "end": t1, "winner": None, "reason": ""}
        )

    # "next": when the following round starts (end of the after-round period).
    for i, r in enumerate(rounds):
        if i + 1 < len(rounds):
            r["next"] = rounds[i + 1]["start"]
        else:
            later = [o for o in officials if o >= r["end"]]
            r["next"] = min(t1, later[0]) if later else t1
        r["next"] = max(r["next"], r["end"])
    return rounds


def _attach_alive(rounds, u8, frame_of, player_count) -> None:
    """Who is alive on each side when the freeze time ends (clutch detection)."""
    for r in rounds:
        f = frame_of(r["freezeEnd"] + 32)
        alive: dict[str, list[int]] = {"T": [], "CT": []}
        for p in range(player_count):
            flags = int(u8[f, p, 2])
            if flags & FLAG_PRESENT and flags & FLAG_ALIVE:
                alive["CT" if flags & FLAG_CT else "T"].append(p)
        r["alive"] = alive


# Weapons that say nothing about the kind of round (falls, the bomb).
NEUTRAL_WEAPONS = ("", "world", "c4", "planted_c4")


def _is_knife(weapon: str) -> bool:
    w = weapon.lower()
    return "knife" in w or "bayonet" in w


def mark_knife_rounds(rounds: list[dict[str, Any]], kills: list[dict[str, Any]], shots: list[list[Any]]) -> None:
    """Flag knife rounds (sides picked by a knife fight: not part of the match,
    no stats or highlights) with ``knife: True`` and number the other rounds
    from 1 (knife rounds get 0). A knife round comes before the match: knives
    were used and nothing else was fired or killed with."""
    for i, r in enumerate(rounds):
        knife = other = 0
        for tick, _p, weapon in shots:
            if r["start"] <= tick <= r["end"]:
                if _is_knife(weapon):
                    knife += 1
                elif weapon not in NEUTRAL_WEAPONS:
                    other += 1
        for k in kills:
            if k["round"] == i:
                if _is_knife(k["weapon"]):
                    knife += 1
                elif k["weapon"] not in NEUTRAL_WEAPONS:
                    other += 1
        if not knife or other:
            break
        r["knife"] = True
    num = 0
    for r in rounds:
        if r.get("knife"):
            r["num"] = 0
        else:
            num += 1
            r["num"] = num


def _build_effects(events, lookup: _Players, tick_rate: float, next_round_start) -> dict[str, list]:
    def thrower(row) -> int:
        return lookup.get(row.get("user_steamid"), row.get("user_name"))

    def xyz(row) -> list[float]:
        return [round(_num(row.get(k)), 1) for k in ("x", "y", "z")]

    def paired(start_ev: str, end_ev: str, default_seconds: float) -> list[dict[str, Any]]:
        ends_by_entity: dict[Any, list[int]] = defaultdict(list)
        for row in _rows(events, end_ev):
            ends_by_entity[row.get("entityid")].append(int(row["tick"]))
        out = []
        for row in _rows(events, start_ev):
            start = int(row["tick"])
            limit = start + int(default_seconds * 2 * tick_rate)
            cands = [t for t in ends_by_entity.get(row.get("entityid"), []) if start < t <= limit]
            end = cands[0] if cands else start + int(default_seconds * tick_rate)
            end = min(end, next_round_start(start))
            out.append({"start": start, "end": end, "pos": xyz(row), "thrower": thrower(row)})
        return out

    def points(ev: str) -> list[dict[str, Any]]:
        return [
            {"tick": int(row["tick"]), "pos": xyz(row), "thrower": thrower(row)}
            for row in _rows(events, ev)
        ]

    return {
        "smokes": paired("smokegrenade_detonate", "smokegrenade_expired", SMOKE_SECONDS),
        "infernos": paired("inferno_startburn", "inferno_expire", INFERNO_SECONDS),
        "decoys": paired("decoy_started", "decoy_detonate", DECOY_SECONDS),
        "flashes": points("flashbang_detonate"),
        "hes": points("hegrenade_detonate"),
    }


def _build_grenades(parser, lookup: _Players, step: int) -> list[dict[str, Any]]:
    try:
        df = parser.parse_grenades()
    except Exception:  # noqa: BLE001
        return []
    if df is None or len(df) == 0:
        return []
    df = df[df["grenade_type"].isin(GRENADE_TYPES.keys())]
    df = df.dropna(subset=["x", "y", "z"])
    if len(df) == 0:
        return []
    df = df.sort_values(["grenade_entity_id", "tick"], kind="stable")
    out = []
    for (_ent, gtype), grp in df.groupby(["grenade_entity_id", "grenade_type"], sort=False):
        ticks = grp["tick"].to_numpy()
        # Entity ids are recycled: split wherever the tick sequence has a gap.
        breaks = np.where(np.diff(ticks) > 16)[0] + 1
        for seg in np.split(np.arange(len(grp)), breaks):
            if len(seg) < 2:
                continue
            part = grp.iloc[seg]
            first = part.iloc[0]
            sampled = part[(part["tick"] - int(first["tick"])) % step == 0]
            if len(sampled) < 2 or int(sampled["tick"].iloc[-1]) != int(part["tick"].iloc[-1]):
                sampled = part.iloc[[*range(0, len(part), step), len(part) - 1]].drop_duplicates("tick")
            pts = np.round(sampled[["x", "y", "z"]].to_numpy(dtype=np.float64), 1).ravel().tolist()
            out.append(
                {
                    "type": GRENADE_TYPES[gtype],
                    "thrower": lookup.get(first.get("steamid"), first.get("name")),
                    "ticks": [int(t) for t in sampled["tick"].tolist()],
                    "pts": pts,
                }
            )
    out.sort(key=lambda g: g["ticks"][0])
    return out


def _build_voice(parser, lookup: _Players) -> tuple[np.ndarray, np.ndarray]:
    """Voice packets of known players: rows of (tick, player, length) and their
    bytes. Demos without voice (most GOTV / HLTV demos) give empty arrays."""
    try:
        packets = parser.parse_voice()
    except Exception:  # noqa: BLE001 - older demoparser2 or a broken demo
        packets = []
    rows, blobs = [], []
    for packet in packets:
        data = bytes(packet["bytes"])
        p = lookup.get(packet["steamid"])
        if p < 0 and len(data) >= 18 and data[8] == 0x0B:
            # Steam's voice format (before 2024) starts with the speaker's steamid.
            p = lookup.get(int.from_bytes(data[:8], "little"))
        if p < 0:
            continue
        rows.append((int(packet["tick"]), p, len(data)))
        blobs.append(data)
    order = sorted(range(len(rows)), key=lambda i: rows[i][0])
    voice = np.array([rows[i] for i in order], dtype="<u4").reshape(-1, 3)
    data = np.frombuffer(b"".join(blobs[i] for i in order), dtype=np.uint8)
    return voice, data


def _build_scoreboard(parser, rounds, lookup: _Players, players) -> list[dict[str, Any]]:
    """Per-round snapshots of the scoreboard, taken just after each round ends."""
    snap_ticks = []
    for r in rounds:
        snap_ticks.append(min(r["end"] + 64, r["next"]) if r["next"] > r["end"] else r["end"])
    if not snap_ticks:
        return []
    try:
        df = parser.parse_ticks(SCOREBOARD_PROPS, ticks=sorted(set(snap_ticks)))
    except Exception:  # noqa: BLE001
        return []
    by_tick: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in df.to_dict("records"):
        by_tick[int(row["tick"])].append(row)
    clans: dict[int, Counter] = defaultdict(Counter)
    out = []
    for r, tick in zip(rounds, snap_ticks, strict=True):
        stats: list[list[int] | None] = [None] * len(players)
        for row in by_tick.get(tick, []):
            p = lookup.get(row.get("steamid"), row.get("name"))
            if p < 0:
                continue
            stats[p] = [
                int(_num(row.get("kills_total"))),
                int(_num(row.get("deaths_total"))),
                int(_num(row.get("assists_total"))),
                int(_num(row.get("damage_total"))),
                int(_num(row.get("team_rounds_total"))),
                int(_num(row.get("mvps"))),
                int(_num(row.get("score"))),
            ]
            clan = _str(row.get("team_clan_name"))
            if clan:
                clans[p][clan] += 1
        out.append({"round": r["num"], "tick": tick, "stats": stats})
    for p, counter in clans.items():
        players[p]["clan"] = counter.most_common(1)[0][0]
    return out


def _attach_places(bomb, kills, u8, places, frame_of) -> None:
    def place(tick: int, p: int) -> str:
        if p < 0:
            return ""
        return places[int(u8[frame_of(tick), p, 5])] if places else ""

    for k in kills:
        k["place"] = place(k["tick"], k["victim"])
    for b in bomb:
        if b["type"] == "plant":
            b["place"] = place(b["tick"], b["player"])


def write_parsed(meta: dict[str, Any], frames: bytes, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp_frames = out_dir / "frames.bin.part"
    tmp_frames.write_bytes(frames)
    tmp_frames.replace(out_dir / "frames.bin")
    tmp_meta = out_dir / "meta.json.part"
    tmp_meta.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp_meta.replace(out_dir / "meta.json")


def load_meta(out_dir: Path) -> dict[str, Any]:
    return json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
