import gzip
import json

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(data_dir):
    from cs2demo.server import create_app

    with TestClient(create_app()) as c:
        yield c


def test_status_and_index(client):
    assert client.get("/api/status").json()["version"]
    page = client.get("/")
    assert page.status_code == 200 and "CS2 Demo Viewer" in page.text
    assert client.get("/js/app.js").status_code == 200


def test_demo_list_meta_and_frames(client, parsed_demo):
    demos = client.get("/api/demos").json()
    assert [d["id"] for d in demos] == [parsed_demo]
    assert demos[0]["map"] == "de_test" and demos[0]["highlights"] == 1
    meta = client.get(f"/api/demos/{parsed_demo}/meta").json()
    assert meta["id"] == parsed_demo
    res = client.get(f"/api/demos/{parsed_demo}/frames", headers={"Accept-Encoding": "gzip"})
    assert res.status_code == 200
    total = sum(s["bytes"] for s in meta["frames"]["sections"])
    assert len(res.content) >= total


def test_recompute_highlights(client, parsed_demo):
    res = client.post(f"/api/demos/{parsed_demo}/highlights", json={"min_score": 1000})
    assert res.json() == []
    res = client.post(f"/api/demos/{parsed_demo}/highlights", json={"pre": 1, "save": True})
    (h,) = res.json()
    meta = client.get(f"/api/demos/{parsed_demo}/meta").json()
    assert meta["highlights"][0]["start"] == h["start"]


def test_rejects_bad_ids_and_non_demos(client, parsed_demo):
    assert client.get("/api/demos/..%2F..%2Fetc/meta").status_code in (400, 404)
    assert client.get("/api/demos/BAD ID/meta").status_code == 400
    res = client.post("/api/demos", files={"file": ("x.dem", b"not a demo at all", "application/octet-stream")})
    assert res.status_code == 400
    res = client.post("/api/demos", files={"file": ("x.txt", b"PBDEMS2\0", "text/plain")})
    assert res.status_code == 400
    assert client.get("/api/maps/../info").status_code in (400, 404)


def test_clip_upload_list_delete(client, parsed_demo):
    info = {"title": "3K — player0", "pov": "first", "codec": "avc"}
    res = client.post(
        f"/api/demos/{parsed_demo}/clips",
        files={"file": ("clip.mp4", b"\0\0\0\x18ftypisom", "video/mp4")},
        data={"name": "r01-player0-3k-first", "info": json.dumps(info)},
    )
    assert res.status_code == 200
    clips = client.get(f"/api/clips?demo={parsed_demo}").json()
    assert len(clips) == 1 and clips[0]["title"] == "3K — player0" and clips[0]["source"] == "browser"
    assert client.get(clips[0]["url"]).status_code == 200
    bad = client.post(f"/api/demos/{parsed_demo}/clips", files={"file": ("a", b"x", "video/mp4")},
                      data={"name": "../escape"})
    assert bad.status_code == 400
    assert client.delete(f"/api/clips/{parsed_demo}/r01-player0-3k-first.mp4").status_code == 200
    assert client.get(f"/api/clips?demo={parsed_demo}").json() == []


def test_delete_demo(client, parsed_demo):
    assert client.delete(f"/api/demos/{parsed_demo}").status_code == 200
    assert client.get("/api/demos").json() == []


def test_frames_without_gzip(client, parsed_demo):
    from cs2demo import storage

    raw = gzip.decompress((storage.parsed_dir(parsed_demo) / "frames.bin.gz").read_bytes())
    res = client.get(f"/api/demos/{parsed_demo}/frames", headers={"Accept-Encoding": "identity"})
    assert res.content == raw


def test_models_and_sounds(client, data_dir):
    from cs2demo import models

    fake = models.models_dir() / models.DEFAULT_NAME
    fake.write_bytes(b"glTF-binary-placeholder")
    info = client.get("/api/models").json()
    assert info["t"]["file"] == models.DEFAULT_NAME and info["ct"]["custom"] is False
    (models.models_dir() / "player_ct.glb").write_bytes(b"custom")
    info = client.get("/api/models").json()
    assert info["ct"] == {"file": "player_ct.glb", "custom": True} and info["t"]["file"] == models.DEFAULT_NAME
    assert client.get("/api/models/file/player_ct.glb").content == b"custom"
    assert client.get("/api/models/file/..%2Fsecret.glb").status_code in (400, 404)
    assert client.get("/api/models/file/notes.txt").status_code == 400

    sounds = data_dir / "sounds"
    sounds.mkdir(exist_ok=True)
    (sounds / "ak47.wav").write_bytes(b"RIFF....WAVE")
    (sounds / "readme.txt").write_text("ignored")
    listed = client.get("/api/sounds").json()
    assert listed == [{"name": "ak47", "file": "ak47.wav", "url": "/sounds/ak47.wav"}]


def test_montage_validation(client, parsed_demo):
    assert client.post("/api/montage", json={"clips": [{"demo": parsed_demo, "file": "x.mp4"}]}).status_code in (400, 404)
    bad = client.post("/api/montage", json={"clips": [{"demo": "../etc", "file": "a.mp4"}, {"demo": "x", "file": "b.mp4"}]})
    assert bad.status_code == 400
