"""FACEIT: compressed demos (.dem.zst / .dem.gz) and downloading a match by link
(against a mock of FACEIT's Data and Downloads APIs)."""

import gzip
import itertools
import json
import os
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from cs2demo import archives, faceit

zstandard = pytest.importorskip("zstandard")

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
MATCH = "1-1a2b3c4d-1111-2222-3333-abcdefabcdef"
LINK = f"https://www.faceit.com/ru/cs2/room/{MATCH}/scoreboard"
DEMO = b"PBDEMS2\0" + os.urandom(300_000)


class MockFaceit:
    """open.faceit.com + its file storage. ``demos``: demo_url list of the match;
    ``downloads``: token the Downloads API accepts (None: refuse everyone)."""

    def __init__(self):
        self.demos = [f"https://demos-europe.backblaze.faceit-cdn.net/cs2/{MATCH}-1-1.dem.zst"]
        self.key = "data-key"
        self.downloads = "data-key"
        self.cors = True
        self.calls = []
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                mock.calls.append(("GET", self.path, self.headers.get("Authorization")))
                if self.path.startswith("/data/v4/matches/"):
                    if self.headers.get("Authorization") != f"Bearer {mock.key}":
                        return self._json(401, {"errors": []})
                    if not self.path.endswith(MATCH):
                        return self._json(404, {"errors": []})
                    return self._json(200, {
                        "match_id": MATCH, "status": "FINISHED", "finished_at": 1790000000,
                        "teams": {"faction1": {"name": "team_alpha"}, "faction2": {"name": "team_bravo"}},
                        "voting": {"map": {"pick": ["de_mirage"]}},
                        "demo_url": mock.demos,
                    })
                if self.path.startswith("/files/") and "sig=ok" in self.path:
                    data = zstandard.ZstdCompressor().compress(DEMO)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(data)))
                    if mock.cors:
                        self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(data)
                    return None
                return self._json(404, {})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                mock.calls.append(("POST", self.path, self.headers.get("Authorization"), body))
                if self.path == "/download/v2/demos/download":
                    if mock.downloads is None or self.headers.get("Authorization") != f"Bearer {mock.downloads}":
                        return self._json(403, {"errors": [{"message": "forbidden"}]})
                    name = body["resource_url"].rsplit("/", 1)[-1]
                    return self._json(200, {"payload": {"download_url": f"{mock.url}/files/{name}?sig=ok"}})
                return self._json(404, {})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


@pytest.fixture()
def mock_faceit(monkeypatch):
    mock = MockFaceit()
    monkeypatch.setattr(faceit, "API_URL", mock.url)
    monkeypatch.setenv("FACEIT_API_KEY", "data-key")
    monkeypatch.delenv("FACEIT_DOWNLOADS_TOKEN", raising=False)
    yield mock
    mock.close()


# -- compressed demos ------------------------------------------------------------------


def test_match_id_from_links():
    assert faceit.match_id(LINK) == MATCH
    assert faceit.match_id(f"https://www.faceit.com/en/cs2/room/{MATCH.upper()}") == MATCH
    assert faceit.match_id(MATCH) == MATCH
    assert faceit.match_id("https://www.faceit.com/en/players/someone") is None


@pytest.mark.parametrize("suffix", [".dem.zst", ".zst", ".dem.gz"])
def test_decompress_demo(tmp_path, suffix):
    src = tmp_path / f"match{suffix}"
    if suffix.endswith(".zst"):
        src.write_bytes(zstandard.ZstdCompressor().compress(DEMO))
    else:
        src.write_bytes(gzip.compress(DEMO))
    (out,) = archives.extract_demos(src, tmp_path / "out")
    assert out.name == "match.dem" and out.read_bytes() == DEMO


def test_decompress_rejects_non_demos(tmp_path):
    src = tmp_path / "x.dem.zst"
    src.write_bytes(zstandard.ZstdCompressor().compress(b"hello"))
    with pytest.raises(archives.ArchiveError, match="не демо"):
        archives.extract_demos(src, tmp_path / "out")
    assert not list((tmp_path / "out").iterdir())
    bad = tmp_path / "y.zst"
    bad.write_bytes(b"not compressed")
    with pytest.raises(archives.ArchiveError):
        archives.extract_demos(bad, tmp_path / "out")


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_browser_zstd_decoder_streams(tmp_path):
    packed = zstandard.ZstdCompressor(write_content_size=True).compress(DEMO * 10)
    src = tmp_path / "m.dem.zst"
    src.write_bytes(packed)
    code = """
    const fs = await import('node:fs');
    const { Decompress } = await import(process.argv[1]);
    const data = fs.readFileSync(process.argv[2]);
    const parts = [];
    const d = new Decompress((chunk) => parts.push(Buffer.from(chunk)));
    for (let off = 0; off < data.length; off += 65536) {
      d.push(data.subarray(off, off + 65536), off + 65536 >= data.length);
    }
    process.stdout.write(Buffer.concat(parts).toString('base64'));
    """
    out = subprocess.run([NODE, "--input-type=module", "-e", code, str(ROOT / "cs2demo/web/vendor/fzstd/fzstd.mjs"),
                          str(src)], capture_output=True, text=True, check=True).stdout
    import base64

    assert base64.b64decode(out) == DEMO * 10


# -- downloading by link -----------------------------------------------------------------


def test_download_by_link(mock_faceit, tmp_path):
    steps = []
    info, demos = faceit.download(LINK, tmp_path, progress=lambda f, m: steps.append((f, m)))
    assert info["title"] == "team_alpha vs team_bravo" and info["map"] == "de_mirage"
    assert [p.name for p in demos] == ["faceit-de_mirage-team_alpha-vs-team_bravo.dem"]
    assert demos[0].read_bytes() == DEMO
    assert not list(tmp_path.glob("*.zst")) and not list(tmp_path.glob("*.part"))
    post = [c for c in mock_faceit.calls if c[0] == "POST"]
    assert post[0][3] == {"resource_url": mock_faceit.demos[0]} and post[0][2] == "Bearer data-key"
    assert steps[-1][0] == 1.0 and all(a[0] <= b[0] for a, b in itertools.pairwise(steps))


def test_separate_downloads_token(mock_faceit, tmp_path, monkeypatch):
    mock_faceit.downloads = "dl-token"
    with pytest.raises(faceit.FaceitError, match="Downloads API"):
        faceit.download(MATCH, tmp_path)
    monkeypatch.setenv("FACEIT_DOWNLOADS_TOKEN", "dl-token")
    _info, demos = faceit.download(MATCH, tmp_path)
    assert demos[0].read_bytes() == DEMO


def test_download_errors(mock_faceit, tmp_path, monkeypatch):
    with pytest.raises(faceit.FaceitError, match="не найден"):
        faceit.download("1-00000000-0000-0000-0000-000000000000", tmp_path)
    mock_faceit.demos = []
    with pytest.raises(faceit.FaceitError, match="30 дней"):
        faceit.download(LINK, tmp_path)
    monkeypatch.setenv("FACEIT_API_KEY", "wrong")
    with pytest.raises(faceit.FaceitError, match="FACEIT_API_KEY"):
        faceit.download(LINK, tmp_path)
    monkeypatch.delenv("FACEIT_API_KEY")
    with pytest.raises(faceit.FaceitError, match="FACEIT_API_KEY"):
        faceit.download(LINK, tmp_path)
    with pytest.raises(faceit.FaceitError, match="ссылку"):
        faceit.download("https://www.faceit.com/en/players/x", tmp_path)


@pytest.fixture()
def client(data_dir, monkeypatch):
    from fastapi.testclient import TestClient

    from cs2demo import jobs, server

    parsed = []
    monkeypatch.setattr(jobs.JobRegistry, "submit_parse", lambda self, demo_id, path, step=None: parsed.append(
        (demo_id, path.read_bytes())))
    with TestClient(server.create_app()) as c:
        c.parsed = parsed
        yield c


def test_server_downloads_by_link(client, mock_faceit):
    assert client.get("/api/faceit").json() == {"configured": True}
    assert client.post("/api/faceit", json={"url": "https://faceit.com/x"}).status_code == 400
    job = client.post("/api/faceit", json={"url": LINK}).json()["job"]
    for _ in range(100):
        st = client.get(f"/api/jobs/{job}").json()
        if st["status"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert st["status"] == "done", st
    (demo_id,) = st["result"]["ids"]
    assert st["result"]["match"]["title"] == "team_alpha vs team_bravo"
    assert client.parsed == [(demo_id, DEMO)]
    assert demo_id.startswith("faceit-de-mirage-team-alpha-vs-team-bravo")


def test_server_without_key(client, monkeypatch):
    monkeypatch.delenv("FACEIT_API_KEY", raising=False)
    assert client.get("/api/faceit").json() == {"configured": False}
    assert client.post("/api/faceit", json={"url": LINK}).status_code == 501


def test_server_accepts_compressed_uploads(client):
    packed = zstandard.ZstdCompressor().compress(DEMO)
    res = client.post("/api/demos", files={"file": ("match-123.dem.zst", packed, "application/octet-stream")})
    assert res.status_code == 200, res.text
    assert client.parsed == [(res.json()["id"], DEMO)] and res.json()["id"].startswith("match-123")
    res = client.post("/api/demos", files={"file": ("x.dem.zst", b"junk", "application/octet-stream")})
    assert res.status_code == 400


def test_cli_takes_faceit_links(mock_faceit, data_dir, monkeypatch):
    from cs2demo import cli, storage

    parsed = []
    def ensure_parsed(demo_id, dem, name, step):
        parsed.append((demo_id, dem.read_bytes()))

    monkeypatch.setattr(cli, "_ensure_parsed", ensure_parsed)
    ids = cli._resolve_demos(LINK)
    assert [i for i, _ in parsed] == ids and parsed[0][1] == DEMO
    assert sorted(p.suffix for p in storage.demos_dir().iterdir()) == [".dem", ".name"]


# -- the Vercel function (web version) --------------------------------------------------------

VERCEL_RUNNER = """
const http = await import('node:http');
const { createRequire } = await import('node:module');
const handler = createRequire(import.meta.url)(process.argv[1]);
const server = http.createServer((req, res) => handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/faceit`;
const get = async (q) => {
  const r = await fetch(base + q);
  return [r.status, Buffer.from(await r.arrayBuffer())];
};
const out = {};
let [st, body] = await get('');
out.status = [st, JSON.parse(body)];
[st, body] = await get('?match=' + encodeURIComponent(process.argv[2]));
out.resolve = [st, JSON.parse(body)];
const demo = out.resolve[1].demos?.[0];
if (demo) {
  [st, body] = await get(demo.proxy);
  out.proxy = [st, body.length, body.subarray(0, 4).toString('hex')];
}
[st, body] = await get('?match=nonsense');
out.bad = [st, JSON.parse(body)];
console.log(JSON.stringify(out));
server.close();
"""


def run_vercel(mock_url: str, key: str | None, match: str = LINK) -> dict:
    env = {**os.environ, "FACEIT_API_URL": mock_url}
    env.pop("FACEIT_API_KEY", None)
    env.pop("FACEIT_DOWNLOADS_TOKEN", None)
    if key:
        env["FACEIT_API_KEY"] = key
    res = subprocess.run([NODE, "--input-type=module", "-e", VERCEL_RUNNER, str(ROOT / "api/faceit.js"), match],
                         capture_output=True, text=True, env=env, check=True, timeout=60)
    return json.loads(res.stdout)


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_vercel_function(mock_faceit):
    out = run_vercel(mock_faceit.url, "data-key")
    assert out["status"] == [200, {"configured": True}]
    st, body = out["resolve"]
    assert st == 200 and body["match"]["title"] == "team_alpha vs team_bravo" and body["match"]["map"] == "de_mirage"
    (demo,) = body["demos"]
    assert demo["name"] == "faceit-de_mirage-team_alpha-vs-team_bravo.dem.zst"
    assert demo["url"].startswith(mock_faceit.url) and "sig=ok" in demo["url"]
    assert demo["proxy"] == f"?match={MATCH}&file=0"
    assert out["proxy"][0] == 200 and out["proxy"][2] == "28b52ffd"  # the .zst, streamed through
    assert out["bad"][0] == 400


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_vercel_function_errors(mock_faceit):
    out = run_vercel(mock_faceit.url, None)
    assert out["status"] == [200, {"configured": False}] and out["resolve"][0] == 501
    mock_faceit.downloads = None
    out = run_vercel(mock_faceit.url, "data-key")
    assert out["resolve"][0] == 502 and "Downloads API" in out["resolve"][1]["error"]
    mock_faceit.downloads = "data-key"
    mock_faceit.demos = []
    out = run_vercel(mock_faceit.url, "data-key")
    assert out["resolve"][0] == 404 and "30 дней" in out["resolve"][1]["error"]
