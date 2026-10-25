import struct
import zipfile

from cs2demo import maps, storage


def test_slugify_and_ids(tmp_path):
    assert storage.slugify("Мой матч на mirage") == "moy-match-na-mirage"
    assert storage.slugify("faceit-de_dust2 (2)") == "faceit-de-dust2-2"
    assert storage.slugify("") == "demo"
    assert storage.is_valid_id("mirage-7245d511")
    for bad in ("../x", "a/b", "", "UPPER", "a..b", "x" * 200):
        assert not storage.is_valid_id(bad)
    f = tmp_path / "x.dem"
    f.write_bytes(b"PBDEMS2\0" + b"\1" * 100)
    assert storage.demo_id_for(f) == storage.demo_id_for(f)
    assert storage.demo_id_for(f, "Матч").startswith("match-")


def test_map_name_validation():
    assert maps.valid_map_name("de_mirage")
    assert not maps.valid_map_name("../de_mirage")
    assert not maps.valid_map_name("de mirage")


def test_extract_member_falls_back_to_full_download(tmp_path, monkeypatch):
    mesh = b"AWMH" + struct.pack("<III", 1, 3, 1) + struct.pack("<9f", *range(9)) + struct.pack("<3I", 0, 1, 2)
    archive = tmp_path / "geometry.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("de_test.mesh", mesh)

    def no_ranges(url):
        raise maps.MapAssetError("range requests not supported")

    def fake_download(url, dest):
        dest.write_bytes(archive.read_bytes())
        return dest

    monkeypatch.setattr(maps, "_HttpRangeFile", no_ranges)
    monkeypatch.setattr(maps, "_download", fake_download)
    out = maps._extract_member("https://example.invalid/geometry.zip", "de_test.mesh", tmp_path / "de_test.mesh")
    assert out.read_bytes() == mesh
