"""RAR archives (HLTV): tool selection, unpacking, and the browser's streaming UnRAR."""

import json
import os
import shutil
import struct
import subprocess
import time
import zlib
from pathlib import Path

import pytest

from cs2demo import archives, storage

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


def write_rar(path: Path, files: dict[str, bytes]) -> Path:
    """A RAR 4 archive with ``files`` stored uncompressed (enough for UnRAR)."""

    def block(htype: int, flags: int, body: bytes) -> bytes:
        rest = struct.pack("<BHH", htype, flags, 7 + len(body)) + body
        return struct.pack("<H", zlib.crc32(rest) & 0xFFFF) + rest

    lt = time.localtime()
    dos = ((lt.tm_year - 1980) << 25) | (lt.tm_mon << 21) | (lt.tm_mday << 16) | (lt.tm_hour << 11)
    out = bytearray(b"Rar!\x1a\x07\x00") + block(0x73, 0, struct.pack("<HI", 0, 0))
    for name, data in files.items():
        raw = name.replace("/", "\\").encode()
        head = struct.pack("<IIBIIBBHI", len(data), len(data), 2, zlib.crc32(data), dos, 20, 0x30, len(raw), 0x20)
        out += block(0x74, 0x8000, head + raw) + data
    out += block(0x7B, 0x4000, b"")
    path.write_bytes(bytes(out))
    return path


FILES = {
    "match-m1-mirage.dem": os.urandom(9 << 20),  # crosses the 4 MB read-ahead window twice
    "notes.txt": b"not a demo",
    "maps/match-m2-inferno.dem": b"DEMO" * 1000,
}


def test_extract_command_prefers_installed_tools(monkeypatch, tmp_path):
    found = {}
    monkeypatch.setattr(archives.shutil, "which", lambda name: found.get(name))
    monkeypatch.setattr(archives, "_is_bsdtar", lambda exe: exe == "/usr/bin/bsdtar")
    monkeypatch.setattr(archives, "_windows_7zip", lambda: None)
    rar, dest = tmp_path / "m.rar", tmp_path / "out"
    assert archives.extract_command(rar, dest) is None
    found["node"] = "/usr/bin/node"
    assert archives.extract_command(rar, dest)[1].endswith("unrar_cli.mjs")
    found["tar"] = "/usr/bin/tar"  # GNU tar can't read RAR
    assert archives.extract_command(rar, dest)[0] == "/usr/bin/node"
    found["bsdtar"] = "/usr/bin/bsdtar"
    assert archives.extract_command(rar, dest) == ["/usr/bin/bsdtar", "-xf", str(rar), "-C", str(dest)]
    found["7z"] = "/usr/bin/7z"
    assert archives.extract_command(rar, dest)[:2] == ["/usr/bin/7z", "x"]
    found["unrar"] = "/usr/bin/unrar"
    assert archives.extract_command(rar, dest)[:2] == ["/usr/bin/unrar", "x"]


def test_extract_without_tools_explains(monkeypatch, tmp_path):
    monkeypatch.setattr(archives, "extract_command", lambda a, d: None)
    with pytest.raises(archives.ArchiveError, match="Нечем распаковать"):
        archives.extract_demos(tmp_path / "m.rar", tmp_path / "out")


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_node_fallback_unpacks_demos(monkeypatch, tmp_path):
    monkeypatch.setattr(archives.shutil, "which", lambda name: NODE if name == "node" else None)
    monkeypatch.setattr(archives, "_windows_7zip", lambda: None)
    rar = write_rar(tmp_path / "match.rar", FILES)
    demos = archives.extract_demos(rar, tmp_path / "out")
    assert [p.name for p in demos] == ["match-m1-mirage.dem", "match-m2-inferno.dem"]
    assert demos[0].read_bytes() == FILES["match-m1-mirage.dem"]
    assert demos[1].read_bytes() == FILES["maps/match-m2-inferno.dem"]


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_cli_imports_every_demo_of_an_archive(monkeypatch, data_dir, tmp_path):
    from cs2demo import cli

    monkeypatch.setattr(archives.shutil, "which", lambda name: NODE if name == "node" else None)
    parsed = []
    monkeypatch.setattr(cli, "_ensure_parsed", lambda demo_id, dem, name, step: parsed.append((demo_id, name)))
    rar = write_rar(tmp_path / "match.rar", FILES)
    ids = cli._resolve_demos(str(rar))
    assert [n for _i, n in parsed] == ["match-m1-mirage.dem", "match-m2-inferno.dem"]
    assert ids == [i for i, _n in parsed]
    stored = sorted(p.name for p in storage.demos_dir().iterdir())
    assert stored == sorted([f"{i}.dem" for i in ids] + [f"{i}.name" for i in ids])  # temp dir gone
    assert (storage.demos_dir() / f"{ids[0]}.dem").read_bytes() == FILES["match-m1-mirage.dem"]


JS_RUNNER = """
const fs = await import('node:fs');
const { openRar } = await import(process.argv[1]);
const [archive, wasm] = process.argv.slice(2);
const data = fs.readFileSync(archive);
let reads = 0;
const rar = await openRar({
  size: data.length,
  readAt: (pos, len) => { reads++; return data.subarray(pos, pos + len); },
  wasmBinary: fs.readFileSync(wasm),
});
const out = { list: rar.list(), files: {} };
for (const e of out.list) {
  const parts = [];
  let last = 0;
  rar.extract(e.name, (chunk, done) => { parts.push(Buffer.from(chunk)); last = done; });
  out.files[e.name] = [Buffer.concat(parts).toString('base64'), last];
}
out.reads = reads;
try { rar.extract('missing.dem', () => {}); } catch (err) { out.missing = err.message; }
console.log(JSON.stringify(out));
"""


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_browser_unrar_streams_archive(tmp_path):
    import base64

    rar = write_rar(tmp_path / "match.rar", FILES)
    module = (ROOT / "cs2demo/web/js/parse/rar.js").as_uri()
    wasm = ROOT / "cs2demo/web/vendor/unrar/unrar.wasm"
    res = subprocess.run([NODE, "--input-type=module", "-e", JS_RUNNER, module, str(rar), str(wasm)],
                         capture_output=True, text=True, check=True)
    out = json.loads(res.stdout)
    names = [e["name"].replace("\\", "/") for e in out["list"]]
    assert names == list(FILES)
    assert [e["size"] for e in out["list"]] == [len(v) for v in FILES.values()]
    for (name, (b64, done)), expected in zip(out["files"].items(), FILES.values(), strict=True):
        assert base64.b64decode(b64) == expected, name
        assert done == len(expected)
    assert out["reads"] < 20  # read in slices, not byte by byte
    assert "missing.dem" in out["missing"]
