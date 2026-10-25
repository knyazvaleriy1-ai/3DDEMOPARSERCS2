"""Find clip-worthy moments in a parsed demo.

Works only on the parsed ``meta`` dict (kills, rounds, players), so it can be
re-run with different settings without touching the demo file again.

Highlight kinds:

* ``multikill`` – several kills by one player in a round, close in time
  (2K/3K/4K/ACE);
* ``clutch``    – a won 1vX situation (merged with the clutcher's kills);
* ``kill``      – a single kill that is special enough on its own (noscope,
  knife, zeus, blind kill, wallbang through smoke, ...).
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from typing import Any

DEFAULTS: dict[str, float] = {
    "pre": 3.0,  # seconds before the first kill
    "post": 2.5,  # seconds after the last kill
    "max_gap": 15.0,  # kills further apart than this start a new clip
    "max_span": 40.0,  # longest stretch of kills kept in one clip
    "max_clip": 75.0,  # hard cap on clip length
    "min_score": 20.0,  # drop anything scoring lower
}

WEAPON_NAMES = {
    "ak47": "AK-47",
    "m4a1": "M4A4",
    "m4a1_silencer": "M4A1-S",
    "m4a1_silencer_off": "M4A1-S",
    "awp": "AWP",
    "deagle": "Desert Eagle",
    "usp_silencer": "USP-S",
    "usp_silencer_off": "USP-S",
    "glock": "Glock-18",
    "hkp2000": "P2000",
    "p250": "P250",
    "tec9": "Tec-9",
    "fiveseven": "Five-SeveN",
    "cz75a": "CZ75-Auto",
    "elite": "Dual Berettas",
    "revolver": "R8 Revolver",
    "mac10": "MAC-10",
    "mp9": "MP9",
    "mp7": "MP7",
    "mp5sd": "MP5-SD",
    "ump45": "UMP-45",
    "p90": "P90",
    "bizon": "PP-Bizon",
    "famas": "FAMAS",
    "galilar": "Galil AR",
    "sg556": "SG 553",
    "aug": "AUG",
    "ssg08": "SSG 08",
    "scar20": "SCAR-20",
    "g3sg1": "G3SG1",
    "nova": "Nova",
    "xm1014": "XM1014",
    "mag7": "MAG-7",
    "sawedoff": "Sawed-Off",
    "m249": "M249",
    "negev": "Negev",
    "hegrenade": "HE",
    "inferno": "Molotov",
    "molotov": "Molotov",
    "incgrenade": "Incendiary",
    "taser": "Zeus x27",
    "world": "мир",
    "planted_c4": "C4",
}

SNIPERS = {"awp", "ssg08", "scar20", "g3sg1"}

MULTI_BASE = {1: 6, 2: 22, 3: 45, 4: 70, 5: 100}
CLUTCH_BONUS = {1: 18, 2: 40, 3: 60, 4: 80, 5: 100}


def weapon_name(raw: str) -> str:
    raw = (raw or "").replace("weapon_", "")
    if is_knife(raw):
        return "Нож"
    return WEAPON_NAMES.get(raw, raw.upper() if len(raw) <= 4 else raw.capitalize())


def is_knife(raw: str) -> bool:
    raw = (raw or "").lower()
    return raw.startswith("knife") or raw.startswith("bayonet") or "knife" in raw


def _kill_extras(k: dict[str, Any]) -> tuple[int, list[str]]:
    score = 0
    tags: list[str] = []
    weapon = (k.get("weapon") or "").lower()
    if k.get("noscope") and weapon in SNIPERS:
        score += 14
        tags.append("ноускоп")
    if k.get("smoke"):
        score += 8
        tags.append("через дым")
    if k.get("penetrated"):
        score += 8
        tags.append("прострел")
    if k.get("blind"):
        score += 12
        tags.append("ослеплён")
    if k.get("air"):
        score += 12 if weapon in SNIPERS else 8
        tags.append("в прыжке")
    if is_knife(weapon):
        score += 20
        tags.append("нож")
    elif weapon == "taser":
        score += 15
        tags.append("зевс")
    if (k.get("distance") or 0) >= 40:
        score += 4
        tags.append("дальний")
    return score, tags


def score_kills(kills: list[dict[str, Any]], tick_rate: float) -> tuple[int, list[str]]:
    n = len(kills)
    if n == 0:
        return 0, []
    score = MULTI_BASE.get(n, 100 + 20 * (n - 5))
    tags: list[str] = []
    if n >= 5:
        tags.append("ACE")
    elif n >= 2:
        tags.append(f"{n}K")
    hs = sum(1 for k in kills if k.get("headshot"))
    score += 2 * hs
    if hs >= 2 and hs == n:
        tags.append(f"HS ×{hs}")
    elif hs == 1 and n == 1:
        tags.append("HS")
    extra_tags: Counter[str] = Counter()
    for k in kills:
        s, t = _kill_extras(k)
        score += s
        extra_tags.update(t)
    if n >= 2:
        span = (kills[-1]["tick"] - kills[0]["tick"]) / tick_rate
        if span <= 2.5:
            score += 15
            tags.append("молниеносно")
        elif span <= 6:
            score += 8
            tags.append("быстро")
    for tag, count in extra_tags.items():
        tags.append(tag if count == 1 else f"{tag} ×{count}")
    return int(score), tags


def _split_segments(ticks: list[int], rate: float, max_gap: float, max_span: float) -> list[list[int]]:
    """Split sorted kill ticks into groups (returns positions into ``ticks``)."""
    if not ticks:
        return []
    groups: list[list[int]] = [[0]]
    for i in range(1, len(ticks)):
        if (ticks[i] - ticks[i - 1]) / rate > max_gap:
            groups.append([i])
        else:
            groups[-1].append(i)

    def split_long(group: list[int]) -> list[list[int]]:
        if len(group) < 2 or (ticks[group[-1]] - ticks[group[0]]) / rate <= max_span:
            return [group]
        gaps = [(ticks[group[j + 1]] - ticks[group[j]], j) for j in range(len(group) - 1)]
        _, cut = max(gaps)
        return split_long(group[: cut + 1]) + split_long(group[cut + 1 :])

    out: list[list[int]] = []
    for g in groups:
        out.extend(split_long(g))
    return out


def detect_clutches(meta: dict[str, Any]) -> list[dict[str, Any]]:
    """Return 1vX situations (won or lost) per round."""
    rounds = meta.get("rounds", [])
    kills = meta.get("kills", [])
    by_round: dict[int, list[int]] = defaultdict(list)
    for i, k in enumerate(kills):
        if k.get("round", -1) >= 0:
            by_round[k["round"]].append(i)

    out = []
    for r_idx, r in enumerate(rounds):
        start_alive = r.get("alive") or {}
        alive = {"T": set(start_alive.get("T", [])), "CT": set(start_alive.get("CT", []))}
        if not alive["T"] or not alive["CT"]:
            continue
        clutch = None
        for ki in sorted(by_round.get(r_idx, []), key=lambda i: kills[i]["tick"]):
            k = kills[ki]
            if k["tick"] < r.get("freezeEnd", r["start"]):
                continue
            for side in ("T", "CT"):
                alive[side].discard(k["victim"])
            if clutch is not None:
                continue
            for side, other in (("T", "CT"), ("CT", "T")):
                if len(alive[side]) == 1 and len(alive[other]) >= 1:
                    # When both sides hit 1 on the same kill it's a plain 1v1:
                    # the killer's side is the "clutcher".
                    if len(alive[other]) == 1 and k.get("attackerSide") != side:
                        continue
                    clutch = {
                        "round": r_idx,
                        "player": next(iter(alive[side])),
                        "side": side,
                        "vs": len(alive[other]),
                        "startTick": k["tick"],
                    }
                    break
        if clutch is None:
            continue
        clutch["won"] = r.get("winner") == clutch["side"]
        clutch["kills"] = [
            i
            for i in by_round.get(r_idx, [])
            if kills[i]["attacker"] == clutch["player"]
            and kills[i]["tick"] >= clutch["startTick"]
            and not kills[i].get("teamkill")
            and kills[i]["victim"] != clutch["player"]
        ]
        out.append(clutch)
    return out


def _slug(text: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text.encode("ascii", "ignore").decode()).strip("-").lower()
    return text[:24] or "player"


def detect_highlights(meta: dict[str, Any], **options: float) -> list[dict[str, Any]]:
    opts = {**DEFAULTS, **{k: float(v) for k, v in options.items() if v is not None}}
    rate = float(meta.get("tickRate") or 64.0)
    rounds = meta.get("rounds", [])
    kills = meta.get("kills", [])
    players = meta.get("players", [])

    groups: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, k in enumerate(kills):
        a = k.get("attacker", -1)
        if a < 0 or a == k["victim"] or k.get("teamkill") or k.get("round", -1) < 0:
            continue
        groups[(k["round"], a)].append(i)

    candidates: list[dict[str, Any]] = []
    for (r_idx, p), idxs in groups.items():
        idxs.sort(key=lambda i: kills[i]["tick"])
        ticks = [kills[i]["tick"] for i in idxs]
        for seg in _split_segments(ticks, rate, opts["max_gap"], opts["max_span"]):
            seg_kills = [idxs[j] for j in seg]
            candidates.append(
                {
                    "kind": "multikill" if len(seg_kills) >= 2 else "kill",
                    "round": r_idx,
                    "player": p,
                    "kills": seg_kills,
                    "roundKills": len(idxs),
                    "clutch": None,
                }
            )

    for c in detect_clutches(meta):
        if not c["won"]:
            continue
        # Fold the clutcher's overlapping kill segments into one clutch clip,
        # unless that would make it longer than the clip cap.
        overlapping = [
            cand
            for cand in candidates
            if cand["round"] == c["round"]
            and cand["player"] == c["player"]
            and set(cand["kills"]) & set(c["kills"])
        ]
        union = set(c["kills"])
        for cand in overlapping:
            union |= set(cand["kills"])
        merged = sorted(union, key=lambda i: kills[i]["tick"])
        if merged and (kills[merged[-1]]["tick"] - kills[merged[0]]["tick"]) / rate > opts["max_clip"]:
            merged = sorted(c["kills"], key=lambda i: kills[i]["tick"])
            overlapping = [cand for cand in overlapping if set(cand["kills"]) <= set(merged)]
        candidates = [cand for cand in candidates if all(cand is not o for o in overlapping)]
        candidates.append(
            {
                "kind": "clutch",
                "round": c["round"],
                "player": c["player"],
                "kills": merged,
                "roundKills": len(groups.get((c["round"], c["player"]), [])),
                "clutch": c,
            }
        )

    out = []
    for cand in candidates:
        h = _finalise(cand, meta, rounds, kills, players, rate, opts)
        if h and h["score"] >= opts["min_score"]:
            out.append(h)

    out.sort(key=lambda h: h["start"])
    used: Counter[str] = Counter()
    for h in out:
        used[h["id"]] += 1
        if used[h["id"]] > 1:
            h["id"] = f"{h['id']}-{used[h['id']]}"
    return out


def _finalise(cand, meta, rounds, kills, players, rate, opts) -> dict[str, Any] | None:
    r = rounds[cand["round"]] if 0 <= cand["round"] < len(rounds) else None
    ks = [kills[i] for i in cand["kills"]]
    clutch = cand.get("clutch")
    if not ks and not clutch:
        return None

    score, tags = score_kills(ks, rate)
    pre, post = int(opts["pre"] * rate), int(opts["post"] * rate)
    if ks:
        start, end = ks[0]["tick"] - pre, ks[-1]["tick"] + post
    else:
        start, end = clutch["startTick"] - pre, clutch["startTick"] + post
    if clutch:
        score += CLUTCH_BONUS.get(clutch["vs"], 100)
        tags.insert(0, f"клатч 1v{clutch['vs']}")
        start = min(start, clutch["startTick"] - int(2 * rate))
        if r and r.get("reason") in ("bomb_defused", "target_bombed", "bomb_exploded"):
            end = max(end, r["end"] + int(1.5 * rate))
    if r:
        start = max(start, r["start"])
        end = min(end, r.get("next", r["end"]))
    max_clip = int(opts["max_clip"] * rate)
    if end - start > max_clip:
        start = end - max_clip
    if end <= start:
        return None

    p = cand["player"]
    pname = players[p]["name"] if 0 <= p < len(players) else "?"
    weapons = Counter(weapon_name(k.get("weapon", "")) for k in ks)
    weapon = weapons.most_common(1)[0][0] if weapons else ""
    n = len(ks)
    if cand["kind"] == "clutch":
        label = f"Клатч 1v{clutch['vs']}"
        if n >= 2:
            label += f" + {'ACE' if n >= 5 else f'{n}K'}"
        short = f"clutch1v{clutch['vs']}"
    elif n >= 2:
        label = "ACE" if n >= 5 else f"{n}K"
        short = "ace" if n >= 5 else f"{n}k"
    else:
        special = [t for t in tags if t not in ("HS",)]
        label = special[0].capitalize() if special else "Килл"
        short = "kill"
    if cand.get("roundKills", n) > n and cand["kind"] != "clutch":
        tags.append(f"за раунд: {cand['roundKills']}K")
    side = (ks[0].get("attackerSide") if ks else None) or (clutch or {}).get("side")
    round_num = r["num"] if r else cand["round"] + 1
    title = f"{label} — {pname}" + (f" ({weapon})" if weapon else "")
    return {
        "id": f"r{round_num:02d}-{_slug(pname)}-{short}",
        "kind": cand["kind"],
        "player": p,
        "playerName": pname,
        "side": side,
        "round": round_num,
        "roundIndex": cand["round"],
        "start": int(start),
        "end": int(end),
        "duration": round((end - start) / rate, 2),
        "kills": cand["kills"],
        "killTicks": [k["tick"] for k in ks],
        "score": int(score),
        "title": title,
        "label": label,
        "weapon": weapon,
        "tags": tags,
        "clutch": (
            {"vs": clutch["vs"], "startTick": clutch["startTick"]} if clutch else None
        ),
    }
