"""Demos packed in archives: HLTV serves matches as ``.rar`` with one ``.dem``
per map. Unpacked with whatever is on the system: ``unrar``, 7-Zip, ``bsdtar``
(the ``tar`` of Windows 10+ and macOS reads RAR), ``unar``, or, failing those,
Node.js with the WebAssembly UnRAR of the web version (``unrar_cli.mjs``).

FACEIT serves one compressed demo, ``.dem.zst`` (Zstandard; older ones
``.dem.gz``): decompressed with ``compression.zstd`` (Python 3.14+), the
``zstandard`` package, or the ``zstd`` command.
"""

from __future__ import annotations

import gzip
import os
import shutil
import subprocess
from pathlib import Path

# A single compressed .dem (FACEIT)
COMPRESSED_SUFFIXES = (".zst", ".gz")
ARCHIVE_SUFFIXES = (".rar", *COMPRESSED_SUFFIXES)
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
GZIP_MAGIC = b"\x1f\x8b"
DEMO_MAGIC = b"PBDEMS2"

_NODE_SCRIPT = Path(__file__).with_name("unrar_cli.mjs")


class ArchiveError(RuntimeError):
    pass


def is_archive(path: Path) -> bool:
    return path.suffix.lower() in ARCHIVE_SUFFIXES


def is_compressed(path: Path) -> bool:
    return path.suffix.lower() in COMPRESSED_SUFFIXES


def demo_name(name: str) -> str:
    """'match.dem.zst' / 'match.zst' -> 'match.dem'."""
    base = Path(name).name
    for suffix in COMPRESSED_SUFFIXES:
        if base.lower().endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base if base.lower().endswith(".dem") else f"{base}.dem"


def _copy_zstd(src, out) -> None:
    try:
        from compression import zstd  # Python 3.14+

        with zstd.ZstdFile(src) as fh:
            shutil.copyfileobj(fh, out, 1 << 20)
        return
    except ImportError:
        pass
    try:
        import zstandard

        zstandard.ZstdDecompressor().copy_stream(src, out, read_size=1 << 20, write_size=1 << 20)
        return
    except ImportError:
        pass
    exe = shutil.which("zstd") or shutil.which("unzstd")
    if not exe:
        raise ArchiveError("Для .zst нужен пакет zstandard (pip install zstandard) или программа zstd")
    out.flush()
    proc = subprocess.run([exe, "-d", "-c", "-q"], stdin=src, stdout=out, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0:
        raise ArchiveError(f"zstd: {proc.stderr.decode(errors='replace').strip() or proc.returncode}")


def decompress_demo(src: Path, dest: Path) -> Path:
    """Unpack a compressed demo (FACEIT .dem.zst / .dem.gz) into ``dest``."""
    dest.mkdir(parents=True, exist_ok=True)
    out_path = dest / demo_name(src.name)
    with src.open("rb") as fh:
        magic = fh.read(4)
        fh.seek(0)
        try:
            with out_path.open("wb") as out:
                if magic.startswith(ZSTD_MAGIC):
                    _copy_zstd(fh, out)
                elif magic.startswith(GZIP_MAGIC):
                    with gzip.GzipFile(fileobj=fh) as gz:
                        shutil.copyfileobj(gz, out, 1 << 20)
                else:
                    raise ArchiveError(f"{src.name}: это не архив .zst / .gz")
        except ArchiveError:
            out_path.unlink(missing_ok=True)
            raise
        except Exception as exc:  # noqa: BLE001 - corrupt or truncated file
            out_path.unlink(missing_ok=True)
            raise ArchiveError(f"Не удалось распаковать {src.name}: {exc}") from exc
    with out_path.open("rb") as fh:
        if fh.read(len(DEMO_MAGIC)) != DEMO_MAGIC:
            out_path.unlink(missing_ok=True)
            raise ArchiveError(f"В {src.name} не демо CS2")
    return out_path


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
    if is_compressed(archive):
        return [decompress_demo(archive, dest)]
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
