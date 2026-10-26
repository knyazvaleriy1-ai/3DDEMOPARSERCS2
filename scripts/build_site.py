"""Build the server-less web version (GitHub Pages) into a directory.

    python scripts/build_site.py site/            # every map in the awpy-data release
    python scripts/build_site.py site/ --maps de_mirage de_inferno

The result is plain static files: the viewer (cs2demo/web) with STATIC = true,
the WebAssembly demo parser (cs2demo/web/vendor/demoparser, built by
wasm/build.sh), and per-map assets downloaded from awpy-data:

    assets/maps/<map>/info.json      world -> radar transform (like /api/maps/<map>/info)
    assets/maps/<map>/radar.png      (+ radar_lower.png on two-level maps)
    assets/maps/<map>/mesh.bin.gz    collision mesh, gzipped (Pages won't compress it)
    assets/models/                   player model + index.json (like /api/models)

Map assets belong to Valve and are only fetched at build time, never committed.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cs2demo import maps, models  # noqa: E402

WEB = ROOT / "cs2demo" / "web"


def build(out: Path, map_names: list[str] | None) -> dict[str, str]:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(WEB, out, ignore=shutil.ignore_patterns("card.html", "__pycache__"))
    if not (out / "vendor" / "demoparser" / "cs2wasm_bg.wasm").exists():
        raise SystemExit("WebAssembly parser missing: run wasm/build.sh first")

    config = out / "js" / "config.js"
    text, n = re.subn(r"export const STATIC = false;", "export const STATIC = true;", config.read_text())
    if n != 1:
        raise SystemExit("could not switch js/config.js to STATIC")
    config.write_text(text)
    (out / ".nojekyll").write_text("")

    status: dict[str, str] = {}
    names = map_names or sorted(maps.map_data())
    for name in names:
        dest = out / "assets" / "maps" / name
        dest.mkdir(parents=True, exist_ok=True)
        info = maps.map_info(name)
        (dest / "info.json").write_text(json.dumps(info, ensure_ascii=False))
        parts = []
        try:
            raw = maps.mesh_path(name).read_bytes()
            (dest / "mesh.bin.gz").write_bytes(gzip.compress(raw, 9, mtime=0))
            parts.append(f"mesh {len(raw) >> 20} MB")
        except Exception as exc:  # noqa: BLE001 - no geometry: the viewer shows the radar
            parts.append(f"no mesh ({exc.__class__.__name__})")
        for lower in (False, True):
            if lower and not info.get("lower"):
                continue
            try:
                shutil.copyfile(maps.radar_path(name, lower=lower), dest / f"radar{'_lower' if lower else ''}.png")
                parts.append("radar_lower" if lower else "radar")
            except Exception:  # noqa: BLE001
                pass
        status[name] = ", ".join(parts)

    mdir = out / "assets" / "models"
    mdir.mkdir(parents=True, exist_ok=True)
    index = {}
    for side in models.SIDES:
        path = models.model_for(side)
        shutil.copyfile(path, mdir / path.name)
        index[side] = {"file": path.name, "custom": path.name != models.DEFAULT_NAME}
    (mdir / "index.json").write_text(json.dumps(index))
    return status


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", type=Path)
    ap.add_argument("--maps", nargs="*", help="only these maps (default: all)")
    args = ap.parse_args()
    status = build(args.out, args.maps)
    for name, s in status.items():
        print(f"{name:20s} {s}")
    size = sum(p.stat().st_size for p in args.out.rglob("*") if p.is_file())
    print(f"site: {args.out} ({size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
