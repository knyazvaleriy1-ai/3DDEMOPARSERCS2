"""FACEIT matches by link: the match page link (or its id, ``1-<uuid>``) is
resolved through FACEIT's Data API (match -> ``demo_url``), the Downloads API
turns that into a signed link, and the demo (``.dem.zst``) is downloaded and
unpacked.

Needs a server-side FACEIT API key (https://developers.faceit.com) in
``FACEIT_API_KEY``. FACEIT only hands out demos through its Downloads API,
which a key can use after FACEIT approves an application (see
https://docs.faceit.com/getting-started/Guides/download-api/, about 30 days);
if the approved access comes as a separate token, put it in
``FACEIT_DOWNLOADS_TOKEN``. FACEIT keeps demos for about 30 days after a match.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from .archives import ArchiveError, extract_demos

API_URL = os.environ.get("FACEIT_API_URL", "https://open.faceit.com")
DOCS_URL = "https://docs.faceit.com/getting-started/Guides/download-api/"
MATCH_RE = re.compile(r"\b1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE)
TIMEOUT = 30

ProgressFn = Callable[[float, str], None]


class FaceitError(RuntimeError):
    pass


def match_id(text: str) -> str | None:
    """The match id in a FACEIT link (…/cs2/room/1-…/scoreboard) or the id itself."""
    m = MATCH_RE.search(text or "")
    return m.group(0).lower() if m else None


def api_key() -> str:
    return os.environ.get("FACEIT_API_KEY", "").strip()


def downloads_token() -> str:
    return os.environ.get("FACEIT_DOWNLOADS_TOKEN", "").strip() or api_key()


def configured() -> bool:
    return bool(api_key())


def _call(method: str, path: str, token: str, body: dict | None = None, *, what: str) -> dict[str, Any]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API_URL}{path}", data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        **({"Content-Type": "application/json"} if data else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as exc:
        raise FaceitError(_explain(exc.code, what)) from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise FaceitError(f"FACEIT недоступен ({what}): {exc}") from exc


def _explain(status: int, what: str) -> str:
    if what == "download" and status in (401, 403):
        return (
            "FACEIT не отдал ссылку на демо: ключу не открыт доступ к Downloads API. Его выдают по заявке "
            f"({DOCS_URL}, рассматривают около 30 дней). Пока можно скачать демо на странице матча "
            "(кнопка Watch demo) и открыть файл .dem.zst здесь."
        )
    if status == 401:
        return "FACEIT отклонил ключ API: проверьте FACEIT_API_KEY"
    if status == 403:
        return "FACEIT запретил доступ к матчу для этого ключа"
    if status == 404:
        return "Матч не найден на FACEIT"
    if status == 429:
        return "Слишком много запросов к FACEIT, попробуйте через минуту"
    return f"Ошибка FACEIT API ({status})"


def fetch_match(mid: str) -> dict[str, Any]:
    if not configured():
        raise FaceitError("Не задан ключ FACEIT: укажите FACEIT_API_KEY (developers.faceit.com)")
    return _call("GET", f"/data/v4/matches/{mid}", api_key(), what="match")


def match_info(match: dict[str, Any]) -> dict[str, Any]:
    """What the UI shows: title, map, finish time and the demo resource URLs."""
    teams = match.get("teams") or {}
    names = [str((teams.get(f) or {}).get("name") or "?") for f in ("faction1", "faction2")]
    picks = ((match.get("voting") or {}).get("map") or {}).get("pick") or []
    return {
        "id": match.get("match_id"),
        "title": " vs ".join(names),
        "map": picks[0] if picks else "",
        "finishedAt": match.get("finished_at"),
        "status": match.get("status"),
        "demos": [u for u in (match.get("demo_url") or []) if u],
    }


def signed_url(resource_url: str) -> str:
    """A temporary download link for a demo's resource URL (Downloads API)."""
    res = _call("POST", "/download/v2/demos/download", downloads_token(), {"resource_url": resource_url},
                what="download")
    url = (res.get("payload") or {}).get("download_url")
    if not url:
        raise FaceitError("FACEIT не вернул ссылку на демо")
    return url


def _slug(text: str) -> str:
    return re.sub(r"[^0-9a-zA-Z_.-]+", "-", text).strip("-")[:80] or "faceit"


def file_name(info: dict[str, Any], url: str, index: int = 0) -> str:
    """'faceit-de_mirage-team_a-vs-team_b.dem.zst' (suffix from the URL)."""
    path = urlparse(url).path.lower()
    suffix = ".dem.zst" if path.endswith(".zst") else ".dem.gz" if path.endswith(".gz") else ".dem"
    teams = info["title"].replace(" vs ", "-vs-")
    base = _slug(f"faceit-{info['map']}-{teams}" if info["map"] else f"faceit-{info['id']}")
    return f"{base}{f'-{index + 1}' if index else ''}{suffix}"


def download(link: str, dest: Path, progress: ProgressFn | None = None) -> tuple[dict[str, Any], list[Path]]:
    """Download and unpack the demo(s) of a FACEIT match into ``dest``:
    (match info, .dem paths)."""
    progress = progress or (lambda f, m: None)
    mid = match_id(link)
    if not mid:
        raise FaceitError("Не похоже на ссылку на матч FACEIT (нужен id вида 1-xxxxxxxx-xxxx-…)")
    progress(0.01, "Матч на FACEIT")
    info = match_info(fetch_match(mid))
    if not info["demos"]:
        raise FaceitError(
            "У матча нет демо: оно ещё не загружено (появляется через несколько минут после матча) "
            "или уже удалено — FACEIT хранит демо около 30 дней"
        )
    dest.mkdir(parents=True, exist_ok=True)
    demos: list[Path] = []
    n = len(info["demos"])
    for i, resource in enumerate(info["demos"]):
        share = (i / n, (i + 1) / n)
        progress(share[0] + 0.02 / n, "Ссылка на демо")
        url = signed_url(resource)
        packed = dest / file_name(info, resource, i)
        _fetch_file(url, packed, lambda f, s=share: progress(s[0] + (s[1] - s[0]) * 0.9 * f, "Скачивание демо"))
        progress(share[0] + (share[1] - share[0]) * 0.92, "Распаковка")
        try:
            demos += extract_demos(packed, dest) if packed.suffix != ".dem" else [packed]
        except ArchiveError as exc:
            raise FaceitError(str(exc)) from exc
        if packed.suffix != ".dem":
            packed.unlink(missing_ok=True)
    progress(1.0, "Скачано")
    return info, demos


def _fetch_file(url: str, path: Path, progress: Callable[[float], None]) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "cs2demo"})
    tmp = path.with_name(path.name + ".part")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res, tmp.open("wb") as out:
            total = int(res.headers.get("Content-Length") or 0)
            done = 0
            while chunk := res.read(1 << 20):
                out.write(chunk)
                done += len(chunk)
                if total:
                    progress(min(1.0, done / total))
    except urllib.error.HTTPError as exc:
        tmp.unlink(missing_ok=True)
        raise FaceitError(f"Не удалось скачать демо (HTTP {exc.code}): ссылка устарела или демо удалено") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        tmp.unlink(missing_ok=True)
        raise FaceitError(f"Не удалось скачать демо: {exc}") from exc
    shutil.move(str(tmp), path)
