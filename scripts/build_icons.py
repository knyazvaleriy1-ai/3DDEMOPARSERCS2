"""Generate cs2demo/web/js/icons.js from game-icons.net SVGs.

    git clone --depth 1 https://github.com/game-icons/icons game-icons
    pip install svgelements
    python scripts/build_icons.py path/to/game-icons

Icons are rotated so that weapons point right (towards the victim in the
killfeed), cropped to their outline and stored as SVG path strings that the
viewer draws with Path2D. The icons are licensed CC BY 3.0 by their authors
(see ICON_CREDITS in the generated file and README).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from svgelements import Matrix, Path as SvgPath

# key: (source icon, rotation in degrees (clockwise), mirror horizontally)
ICONS: dict[str, tuple[str, float, bool]] = {
    # rifles
    "ak47": ("skoll/ak47", 45, False),
    "galil": ("skoll/ak47u", 45, False),
    "m4": ("skoll/fn-fal", 45, False),
    "famas": ("skoll/famas", 45, False),
    "aug": ("skoll/steyr-aug", 45, False),
    "sniper": ("skoll/lee-enfield", 45, False),
    "auto_sniper": ("skoll/fn-fal", 45, False),
    # pistols
    "glock": ("skoll/glock", 0, False),
    "usp": ("skoll/walther-ppk", 0, False),
    "pistol": ("skoll/colt-m1911", 0, False),
    "deagle": ("skoll/desert-eagle", 0, False),
    "revolver": ("skoll/revolver", 0, False),
    "tec9": ("skoll/tec-9", 0, False),
    "cz75": ("skoll/c96", 0, False),
    # smgs / heavy
    "mac10": ("skoll/mac-10", 0, False),
    "mp9": ("delapouite/uzi", 0, False),
    "mp7": ("skoll/mp5k", 0, False),
    "mp5": ("skoll/mp5", 45, False),
    "ump": ("skoll/thompson-m1", 45, False),
    "p90": ("skoll/p90", 45, False),
    "bizon": ("skoll/mp-40", 45, False),
    "shotgun": ("skoll/winchester-rifle", 45, False),
    "sawedoff": ("delapouite/sawed-off-shotgun", 45, False),
    "lmg": ("skoll/thompson-m1928", 45, False),
    # other weapons
    "knife": ("skoll/bowie-knife", 135, False),
    "taser": ("sbed/electric", 0, False),
    "he": ("lorc/grenade", 0, False),
    "flash": ("lorc/flash-grenade", 0, False),
    "smoke": ("darkzaitzev/smoke-bomb", 0, False),
    "molotov": ("lorc/molotov", 0, False),
    "decoy": ("sbed/grenade", 0, False),
    "c4": ("lorc/time-bomb", 0, False),
    "world": ("lorc/skull-crossed-bones", 0, False),
    # killfeed modifiers
    "headshot": ("skoll/headshot", 0, False),
    "wallbang": ("delapouite/broken-wall", 0, False),
    "noscope": ("delapouite/crosshair", 0, False),
    "thrusmoke": ("lorc/dust-cloud", 0, False),
    "blind": ("skoll/sight-disabled", 0, False),
    "air": ("delapouite/jump-across", 0, False),
    "assist": ("lorc/flash-grenade", 0, False),
}

AUTHORS = {
    "skoll": "Skoll",
    "lorc": "Lorc",
    "delapouite": "Delapouite",
    "sbed": "Sbed",
    "darkzaitzev": "DarkZaitzev",
}


# Rifles that get a scope drawn on top (the source icons have none).
SCOPED = {"sniper", "auto_sniper"}


def add_scope(d: str, w: float, h: float) -> tuple[str, float]:
    """Shift the gun down and draw a scope with two mounts above the receiver."""
    lift = 0.32 * h
    moved = SvgPath(d) * Matrix(f"translate(0, {lift})")
    moved.reify()
    sx0, sx1 = 0.36 * w, 0.62 * w
    tube = 0.2 * h
    r = tube / 2
    scope = (
        f"M{sx0 + r:.1f} 0H{sx1 - r:.1f}A{r:.1f} {r:.1f} 0 0 1 {sx1 - r:.1f} {tube:.1f}"
        f"H{sx0 + r:.1f}A{r:.1f} {r:.1f} 0 0 1 {sx0 + r:.1f} 0Z"
        f"M{sx0 - 0.03 * w:.1f} {-0.02 * h:.1f}h{0.05 * w:.1f}v{tube + 0.04 * h:.1f}h{-0.05 * w:.1f}Z"
        f"M{sx1 - 0.02 * w:.1f} {-0.02 * h:.1f}h{0.05 * w:.1f}v{tube + 0.04 * h:.1f}h{-0.05 * w:.1f}Z"
    )
    for x in (0.42 * w, 0.54 * w):
        scope += f"M{x:.1f} {tube:.1f}h{0.025 * w:.1f}v{lift - tube + 0.06 * h:.1f}h{-0.025 * w:.1f}Z"
    shifted = SvgPath(scope) * Matrix(f"translate(0, {0.02 * h})")
    shifted.reify()
    return moved.d() + shifted.d(), h + lift


def load_path(svg_file: Path) -> SvgPath:
    text = svg_file.read_text(encoding="utf-8")
    # Skip the full-square background path every icon starts with.
    paths = [d for d in re.findall(r'<path[^>]*\sd="([^"]+)"', text) if d.strip() != "M0 0h512v512H0z"]
    if not paths:
        raise ValueError(f"no path in {svg_file}")
    return SvgPath(" ".join(paths))


def build(root: Path) -> dict[str, dict]:
    out = {}
    for key, (src, angle, mirror) in ICONS.items():
        path = load_path(root / f"{src}.svg")
        m = Matrix()
        if mirror:
            m *= Matrix("scale(-1, 1) translate(-512, 0)")
        if angle:
            m *= Matrix(f"rotate({angle} 256 256)")
        path = path * m
        path.reify()
        x0, y0, x1, y1 = path.bbox()
        path = path * Matrix(f"translate({-x0}, {-y0})")
        path.reify()
        w, h = x1 - x0, y1 - y0
        d = path.d()
        if key in SCOPED:
            d, h = add_scope(d, w, h)
        d = re.sub(r"-?\d+\.\d+", lambda mt: f"{float(mt.group()):.1f}".rstrip("0").rstrip("."), d)
        out[key] = {"w": round(w, 1), "h": round(h, 1), "d": d}
    return out


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "game-icons")
    icons = build(root)
    credits = sorted({f"{AUTHORS.get(src.split('/')[0], src.split('/')[0])}: {src.split('/')[1]}"
                      for src, _a, _m in ICONS.values()})
    target = Path(__file__).resolve().parents[1] / "cs2demo" / "web" / "js" / "icons.js"
    body = ",\n".join(f"  {k}: {json.dumps(v, separators=(',', ':'))}" for k, v in icons.items())
    target.write_text(
        "// Generated by scripts/build_icons.py - do not edit by hand.\n"
        "// Icons from https://game-icons.net, licensed CC BY 3.0 by their authors:\n"
        f"// {', '.join(credits)}\n"
        "// Paths were rotated and cropped; each icon is {w, h, d} in its own units.\n"
        f"export const ICONS = {{\n{body},\n}};\n",
        encoding="utf-8",
    )
    print(f"{len(icons)} icons -> {target} ({target.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
