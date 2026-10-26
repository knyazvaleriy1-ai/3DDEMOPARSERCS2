"""Demos packed in archives: HLTV serves matches as ``.rar`` with one ``.dem``
per map. Unpacked with whatever is on the system: ``unrar``, 7-Zip, ``bsdtar``
(the ``tar`` of Windows 10+ and macOS reads RAR), ``unar``, or, failing those,
Node.js with the WebAssembly UnRAR of the web version (``unrar_cli.mjs``).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

ARCHIVE_SUFFIXES = (".rar",)

_NODE_SCRIPT = Path(__file__).with_name("unrar_cli.mjs")


class ArchiveError(RuntimeError):
    pass


def is_archive(path: Path) -> bool:
    return path.suffix.lower() in ARCHIVE_SUFFIXES


def _is_bsdtar(exe: str) -> bool:
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    return "bsdtar" in out.stdout or "libarchive" in out.stdout


def _windows_7zip() -> str | None:
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if base and (Path(base) / "7-Zip" / "7z.exe").is_file():
            return str(Path(base) / "7-Zip" / "7z.exe")
    return None


def extract_command(archive: Path, dest: Path) -> list[str] | None:
    """Command that unpacks ``archive`` into ``dest`` with the first tool found."""
    if exe := shutil.which("unrar"):
        return [exe, "x", "-o+", "-idq", str(archive), f"{dest}{os.sep}"]
    for name in ("7zz", "7z"):
        if exe := shutil.which(name) or (name == "7z" and _windows_7zip()):
            return [exe, "x", "-y", "-bd", f"-o{dest}", str(archive)]
    for name in ("bsdtar", "tar"):
        if (exe := shutil.which(name)) and _is_bsdtar(exe):
            return [exe, "-xf", str(archive), "-C", str(dest)]
    if exe := shutil.which("unar"):
        return [exe, "-q", "-f", "-o", str(dest), str(archive)]
    if exe := shutil.which("node"):
        return [exe, str(_NODE_SCRIPT), str(archive), str(dest)]
    return None


def extract_demos(archive: Path, dest: Path) -> list[Path]:
    """Unpack the ``.dem`` files of ``archive`` into ``dest`` (sorted paths)."""
    dest.mkdir(parents=True, exist_ok=True)
    cmd = extract_command(archive, dest)
    if cmd is None:
        raise ArchiveError(
            "Нечем распаковать .rar: установите unrar, 7-Zip или bsdtar (libarchive-tools), "
            "либо Node.js — или распакуйте архив сами. В веб-версии архивы распаковываются в браузере."
        )
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout).strip().splitlines()
        raise ArchiveError(f"Не удалось распаковать {archive.name} ({Path(cmd[0]).name}): {msg[-1] if msg else proc.returncode}")
    demos = sorted(p for p in dest.rglob("*") if p.suffix.lower() == ".dem" and p.is_file())
    if not demos:
        raise ArchiveError(f"В архиве {archive.name} нет демо (.dem)")
    return demos
