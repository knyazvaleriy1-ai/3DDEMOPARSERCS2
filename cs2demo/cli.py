"""Command line interface: ``python -m cs2demo <command>``."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import tempfile
import time
import webbrowser
from pathlib import Path

from . import __version__, storage
from .archives import ArchiveError, extract_demos, is_archive


def _resolve_demo(arg: str, step: int | None = None) -> str:
    """Accept a parsed demo id or a path to a .dem (imported and parsed on demand)."""
    from .jobs import import_demo, is_parsed, parse_and_store

    path = Path(arg).expanduser()
    if path.is_file():
        demo_id, dem = import_demo(path)
        _ensure_parsed(demo_id, dem, path.name, step)
        return demo_id
    if storage.is_valid_id(arg) and is_parsed(arg):
        return arg
    raise SystemExit(
        f"Не найдено демо: {arg} (укажите путь к .dem / .rar / .dem.zst, ссылку на матч FACEIT "
        "или id из `cs2demo list`)"
    )


def _ensure_parsed(demo_id: str, dem: Path, name: str, step: int | None) -> None:
    from .jobs import is_parsed, parse_and_store

    if not is_parsed(demo_id):
        print(f"Разбор {name} → {demo_id}")
        started = time.time()
        parse_and_store(demo_id, dem, step=step, progress=_progress)
        print(f"\nГотово за {time.time() - started:.1f} с")


def _resolve_demos(arg: str, step: int | None = None) -> list[str]:
    """Like _resolve_demo, but a .rar (HLTV: one demo per map) gives every demo
    inside, a .dem.zst (FACEIT) is unpacked, and a FACEIT match link is downloaded."""
    from . import faceit
    from .jobs import import_demo, is_parsed

    path = Path(arg).expanduser()
    if not path.exists() and faceit.match_id(arg) and not (storage.is_valid_id(arg) and is_parsed(arg)):
        return _faceit_demos(arg, step)
    if not (path.is_file() and is_archive(path)):
        return [_resolve_demo(arg, step)]
    print(f"Распаковка {path.name}…")
    ids = []
    # Unpack next to the stored demos so they are moved, not copied, into place.
    with tempfile.TemporaryDirectory(dir=storage.demos_dir()) as tmp:
        try:
            demos = extract_demos(path, Path(tmp))
        except ArchiveError as exc:
            raise SystemExit(str(exc)) from exc
        for dem in demos:
            demo_id, stored = import_demo(dem, display_name=dem.stem, move=True)
            _ensure_parsed(demo_id, stored, dem.name, step)
            ids.append(demo_id)
    return ids


def _faceit_demos(link: str, step: int | None) -> list[str]:
    from . import faceit
    from .jobs import import_demo

    ids = []
    with tempfile.TemporaryDirectory(dir=storage.demos_dir()) as tmp:
        try:
            info, demos = faceit.download(link, Path(tmp), progress=_progress)
        except faceit.FaceitError as exc:
            raise SystemExit(f"\n{exc}") from exc
        print(f"\nFACEIT: {info['title']} {info['map']}")
        for dem in demos:
            demo_id, stored = import_demo(dem, display_name=dem.stem, move=True)
            _ensure_parsed(demo_id, stored, dem.name, step)
            ids.append(demo_id)
    return ids


def _progress(fraction: float, message: str) -> None:
    print(f"\r[{fraction * 100:5.1f}%] {message:<40}", end="", flush=True)


def _print_highlights(highlights: list[dict]) -> None:
    if not highlights:
        print("Хайлайтов не найдено")
        return
    print(f"{'id':<38} {'очки':>4}  {'раунд':>5}  {'длит.':>6}  описание")
    for h in highlights:
        tags = ", ".join(h.get("tags", []))
        print(f"{h['id']:<38} {h['score']:>4}  {h['round']:>5}  {h['duration']:>5.1f}с  {h['title']}  [{tags}]")


def cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn

    from .server import create_app

    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}"
    print(f"CS2 3D Demo Viewer {__version__}: {url}  (данные: {storage.data_root()})")
    if args.open:
        webbrowser.open(url)
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="warning")


def cmd_parse(args: argparse.Namespace) -> None:
    from .parser import load_meta

    for demo_id in (i for f in args.files for i in _resolve_demos(f, step=args.step)):
        if args.force:
            from .jobs import parse_and_store

            parse_and_store(demo_id, storage.demos_dir() / f"{demo_id}.dem", step=args.step, progress=_progress)
            print()
        meta = load_meta(storage.parsed_dir(demo_id))
        print(f"{demo_id}: {meta['map']}, раундов {len(meta['rounds'])}, киллов {len(meta['kills'])}, "
              f"хайлайтов {len(meta['highlights'])}")


def cmd_list(_args: argparse.Namespace) -> None:
    from .jobs import is_parsed
    from .parser import load_meta

    found = False
    for d in sorted(storage.parsed_dir().iterdir()):
        if d.is_dir() and is_parsed(d.name):
            meta = load_meta(d)
            found = True
            print(f"{d.name:<40} {meta['map']:<14} раундов {len(meta['rounds']):>2}  "
                  f"хайлайтов {len(meta['highlights']):>3}  {meta.get('file', '')}")
    if not found:
        print("Пока нет разобранных демо. `cs2demo parse путь/к/demo.dem`")


def cmd_highlights(args: argparse.Namespace) -> None:
    from .highlights import detect_highlights
    from .parser import load_meta
    from .recorder import pick_highlights

    ids = _resolve_demos(args.demo)
    for demo_id in ids:
        meta = load_meta(storage.parsed_dir(demo_id))
        opts = {k: getattr(args, k) for k in ("pre", "post", "max_gap", "max_clip") if getattr(args, k) is not None}
        if opts or args.min_score is not None:
            meta["highlights"] = detect_highlights(meta, min_score=args.min_score, **opts)
        chosen = pick_highlights(meta, top=args.top, min_score=args.min_score, player=args.player)
        if args.json:
            print(json.dumps(chosen, ensure_ascii=False, indent=1))
            continue
        if len(ids) > 1:
            print(f"\n== {demo_id} ({meta['map']})")
        _print_highlights(chosen)


def _output_opts(args: argparse.Namespace) -> dict:
    try:
        width, height = (int(v) for v in args.res.lower().split("x"))
    except ValueError as exc:
        raise SystemExit("--res в формате 1280x720") from exc
    return {"width": width, "height": height, "fps": args.fps, "hud": not args.no_hud, "sound": not args.no_sound,
            "keys": args.keys, "voice": args.voice, "detail": args.quality}


def _render_opts(args: argparse.Namespace) -> dict:
    return {**_output_opts(args), "pov": args.pov, "slowmo": args.slowmo}


def cmd_render(args: argparse.Namespace) -> None:
    from .recorder import playwright_available, render_demo_cli

    if not playwright_available():
        raise SystemExit("Нужен Playwright: pip install playwright && python -m playwright install chromium")
    clip_ids = [c.strip() for c in args.clips.split(",")] if args.clips else None
    results = []
    for demo_id in _resolve_demos(args.demo):
        results += render_demo_cli(demo_id, top=args.top, min_score=args.min_score, player=args.player,
                                   clip_ids=clip_ids, **_render_opts(args))
    if not results:
        print("Нечего записывать: нет подходящих хайлайтов")
        return
    for r in results:
        print(f"  {r['path']}  ({r['duration']} с, рендер {r['renderSeconds']} с)")


def cmd_watch(args: argparse.Namespace) -> None:
    """Watch a folder (e.g. CS2 replays) and process every new demo automatically."""
    from .recorder import playwright_available, render_demo_cli

    folder = Path(args.folder).expanduser()
    if not folder.is_dir():
        raise SystemExit(f"Нет такой папки: {folder}")
    if args.render and not playwright_available():
        raise SystemExit("Для --render нужен Playwright: pip install playwright && python -m playwright install chromium")
    state_file = storage.data_root() / "watch-state.json"
    try:
        done: dict[str, float] = json.loads(state_file.read_text())
    except (OSError, ValueError):
        done = {}
    sizes: dict[str, int] = {}
    print(f"Слежу за {folder} (Ctrl+C — выход)")
    while True:
        patterns = ("**/*.dem", "**/*.rar", "**/*.zst", "**/*.dem.gz")
        for dem in sorted(p for pattern in patterns for p in folder.glob(pattern)):
            key = str(dem.resolve())
            try:
                stat = dem.stat()
            except OSError:
                continue
            if done.get(key) == stat.st_mtime:
                continue
            # Wait until the file stops growing (CS2 may still be writing it).
            if sizes.get(key) != stat.st_size:
                sizes[key] = stat.st_size
                continue
            print(f"\nНовое демо: {dem.name}")
            try:
                for demo_id in _resolve_demos(str(dem)):
                    if not args.render:
                        continue
                    results = render_demo_cli(demo_id, top=args.top, min_score=args.min_score,
                                              player=args.player, clip_ids=None, **_render_opts(args))
                    for r in results:
                        print(f"  клип: {r['path']}")
            except (Exception, SystemExit) as exc:  # noqa: BLE001 - keep watching
                print(f"  ошибка: {exc}")
            done[key] = stat.st_mtime
            state_file.write_text(json.dumps(done, ensure_ascii=False, indent=1))
        time.sleep(args.interval)


def cmd_montage(args: argparse.Namespace) -> None:
    """Best moments of several demos cut into one video."""
    from .montage import make_montage
    from .recorder import playwright_available

    if not playwright_available():
        raise SystemExit("Нужен Playwright: pip install playwright && python -m playwright install chromium")
    demo_ids = [i for d in args.demos for i in _resolve_demos(d)]
    include = [c.strip() for c in args.include.split(",") if c.strip()] if args.include else None
    result = make_montage(
        demo_ids, Path(args.out) if args.out else None, top=args.top, include=include,
        min_score=args.min_score, per_demo=args.per_demo, title=args.title, jobs=args.jobs,
        progress=_render_progress, **_render_opts(args),
    )
    print(f"\nНарезка: {result['path']} ({result['duration']} с, {len(result['clips'])} моментов)")
    for i, c in enumerate(reversed(result["clips"]), 1):
        print(f"  #{i:<2} {c['title']}  ({c['score']} очк.)")


def cmd_pov(args: argparse.Namespace) -> None:
    """A player's first-person view over whole rounds, fast-forward after their death."""
    from .recorder import (
        BackgroundServer,
        parse_rounds,
        playwright_available,
        render_pov,
    )

    if not playwright_available():
        raise SystemExit("Нужен Playwright: pip install playwright && python -m playwright install chromium")
    try:
        rounds = parse_rounds(args.rounds)
    except ValueError as exc:
        raise SystemExit("--rounds в формате 1-12 или 3,5,7-9") from exc
    opts = _output_opts(args)
    for demo_id in _resolve_demos(args.demo):
        with BackgroundServer() as srv:
            r = render_pov(
                demo_id, args.player, rounds, base_url=srv.url, ff=args.ff, progress=_render_progress, **opts
            )
        rounds_done = f"{r['rounds'][0]}–{r['rounds'][-1]}"
        print(f"\n  {r['path']}  ({r['duration']} с, раунды {rounds_done}, рендер {r['renderSeconds']} с)")


def cmd_smokes(args: argparse.Namespace) -> None:
    """Smoke lineups of a demo: list them, or record replays with the utility camera."""
    from .recorder import BackgroundServer, playwright_available, render_smokes

    if not playwright_available():
        raise SystemExit("Нужен Playwright: pip install playwright && python -m playwright install chromium")
    ids = [x.strip() for x in (args.ids or "").split(",") if x.strip()] or None
    opts = _output_opts(args)
    for demo_id in _resolve_demos(args.demo):
        with BackgroundServer() as srv:
            try:
                res = render_smokes(demo_id, ids, base_url=srv.url, top=args.top, list_only=args.list,
                                    progress=None if args.list else _render_progress, **opts)
            except ValueError as exc:
                raise SystemExit(str(exc)) from exc
        if args.list:
            for lu in res:
                mark = "*" if lu["interesting"] else " "
                print(f"{lu['score']:>4} {mark} {lu['id']:<44} {lu['title']:<34} {' · '.join(lu['tags'])}")
            continue
        print()
        for r in res:
            print(f"  {r['path']}  ({r['duration']} с)  {r['setpos']}")


def _render_progress(fraction: float, message: str) -> None:
    print(f"\r[{fraction * 100:5.1f}%] {message[:110]:<110}", end="", flush=True)


def cmd_maps(args: argparse.Namespace) -> None:
    from . import maps, models

    for name, status in maps.prefetch(args.names).items():
        print(f"{name:<20} {status}")
    try:
        print(f"{'модель игрока':<20} {models.default_model().name}")
    except Exception as exc:  # noqa: BLE001
        print(f"{'модель игрока':<20} ошибка: {exc}")


def _add_render_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--top", type=int, default=None, help="сколько лучших хайлайтов записать")
    p.add_argument("--min-score", type=float, default=None, help="минимальные очки хайлайта")
    p.add_argument("--player", help="только хайлайты игрока (подстрока ника)")
    p.add_argument("--pov", choices=["first", "third", "overview"], default="first",
                   help="камера: от первого лица / от третьего / сверху")
    p.add_argument("--slowmo", action="store_true", help="замедление в момент киллов")
    _add_output_args(p)


def _add_output_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--res", default="1280x720", help="разрешение, например 1920x1080")
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--no-hud", action="store_true", help="без HUD и килфида")
    p.add_argument("--no-sound", action="store_true", help="без звука")
    p.add_argument("--keys", action="store_true", help="экранная клавиатура: какие клавиши жмёт игрок")
    p.add_argument("--voice", choices=["all", "team", "player", "T", "CT", "off"], default="team",
                   help="войс игроков из демо (FACEIT и др.): все / команда игрока / только он / сторона / выкл")
    p.add_argument("--quality", choices=["auto", "low", "high"], default="auto",
                   help="материалы карты: auto — полные на GPU, упрощённые на CPU")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cs2demo", description="3D-просмотр демо CS2, парсер и автозапись клипов")
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--data", help="папка с данными (по умолчанию ./data или $CS2DEMO_DATA)")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("serve", help="запустить веб-просмотрщик")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--open", action="store_true", help="открыть браузер")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("parse", help="разобрать .dem, архивы .rar (HLTV), .dem.zst или ссылки на матчи FACEIT")
    p.add_argument("files", nargs="+")
    p.add_argument("--step", type=int, default=None, help="шаг выборки в тиках (по умолчанию 2)")
    p.add_argument("--force", action="store_true", help="разобрать заново")
    p.set_defaults(func=cmd_parse)

    p = sub.add_parser("list", help="список разобранных демо")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("highlights", help="показать найденные хайлайты")
    p.add_argument("demo", help="id демо, путь к .dem / .rar / .dem.zst или ссылка на матч FACEIT")
    p.add_argument("--json", action="store_true")
    p.add_argument("--top", type=int)
    p.add_argument("--min-score", type=float)
    p.add_argument("--player")
    p.add_argument("--pre", type=float, help="секунд до первого килла")
    p.add_argument("--post", type=float, help="секунд после последнего килла")
    p.add_argument("--max-gap", type=float, help="макс. пауза между киллами в одном клипе, с")
    p.add_argument("--max-clip", type=float, help="макс. длина клипа, с")
    p.set_defaults(func=cmd_highlights)

    p = sub.add_parser("render", help="записать клипы хайлайтов в MP4 (headless Chromium)")
    p.add_argument("demo", help="id демо, путь к .dem / .rar / .dem.zst или ссылка на матч FACEIT")
    p.add_argument("--clips", help="id хайлайтов через запятую")
    _add_render_args(p)
    p.set_defaults(func=cmd_render)

    p = sub.add_parser("pov", help="POV игрока по раундам в один MP4: после смерти раунд ускоряется")
    p.add_argument("demo", help="id демо, путь к .dem / .rar / .dem.zst или ссылка на матч FACEIT")
    p.add_argument("--player", required=True, help="ник игрока (или его часть)")
    p.add_argument("--rounds", help="раунды: 1-12 или 3,5,7-9 (по умолчанию все)")
    p.add_argument("--ff", type=int, choices=[0, 4, 8, 16], default=8,
                   help="во сколько раз ускорять раунд после смерти игрока (0 — вырезать)")
    _add_output_args(p)
    p.set_defaults(func=cmd_pov)

    p = sub.add_parser("smokes", help="лайнапы смоков: список и повторы с камерой гранаты в MP4")
    p.add_argument("demo", help="id демо, путь к .dem / .rar / .dem.zst или ссылка на матч FACEIT")
    p.add_argument("--list", action="store_true", help="только показать найденные смоки (* — лайнап)")
    p.add_argument("--ids", help="id лайнапов через запятую (из --list)")
    p.add_argument("--top", type=int, default=5, help="сколько лучших лайнапов записать (без --ids)")
    _add_output_args(p)
    p.set_defaults(func=cmd_smokes)

    p = sub.add_parser("watch", help="следить за папкой с демо и автоматически записывать клипы")
    p.add_argument("folder")
    p.add_argument("--render", action="store_true", help="сразу записывать клипы")
    p.add_argument("--interval", type=float, default=10.0)
    _add_render_args(p)
    p.set_defaults(func=cmd_watch, top=5)

    p = sub.add_parser("montage", help="нарезка лучших моментов одного или нескольких демо в одно видео")
    p.add_argument("demos", nargs="+", help="id демо, пути к .dem / .rar / .dem.zst или ссылки на матчи FACEIT")
    p.add_argument("--include", help="обязательно включить: подстроки id через запятую, например clutch1v5")
    p.add_argument("--per-demo", type=int, help="не больше N моментов из одного демо")
    p.add_argument("--title", default="CS2 хайлайты", help="заголовок титульной карточки")
    p.add_argument("--out", help="файл MP4 (по умолчанию data/clips/montages/)")
    p.add_argument("--jobs", type=int, default=1, help="сколько клипов рендерить параллельно")
    _add_render_args(p)
    p.set_defaults(func=cmd_montage, top=10)

    p = sub.add_parser("maps", help="заранее скачать 3D-геометрию и радары карт и модель игрока")
    p.add_argument("names", nargs="*", help="например de_mirage de_inferno (по умолчанию все)")
    p.set_defaults(func=cmd_maps)
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(levelname)s %(message)s")
    if args.data:
        import os

        os.environ["CS2DEMO_DATA"] = args.data
    try:
        args.func(args)
    except KeyboardInterrupt:
        print("\nОстановлено")
        sys.exit(130)


if __name__ == "__main__":
    main()
