import subprocess

import pytest

from cs2demo import media
from cs2demo.montage import concat, match_label, select


def _meta(highlights, clans=("Team A", "Team B")):
    players = [{"name": f"p{i}", "startSide": "T" if i < 5 else "CT", "clan": clans[0] if i < 5 else clans[1]}
               for i in range(10)]
    return {"map": "de_test", "players": players, "highlights": highlights}


def _h(hid, score, start=0):
    return {"id": hid, "score": score, "start": start, "duration": 5.0, "title": hid}


def test_select_countdown_and_include():
    metas = {
        "a": _meta([_h("r01-x-3k", 50), _h("r02-y-clutch1v5", 20), _h("r03-z-4k", 80)]),
        "b": _meta([_h("r01-q-2k", 30), _h("r05-w-ace", 120)]),
    }
    picked = select(metas, top=3, include=["clutch1v5"])
    ids = [h["id"] for _d, h in picked]
    assert "r02-y-clutch1v5" in ids            # forced in despite its low score
    assert ids[-1] == "r05-w-ace"               # best moment closes the cut
    assert [h["score"] for _d, h in picked] == sorted(h["score"] for _d, h in picked)
    assert len(select(metas, top=10, per_demo=1)) == 2


def test_match_label():
    assert match_label(_meta([], ("9z", "PV"))) == "9z vs PV · de_test"
    assert match_label({"map": "de_x", "players": []}) == "T vs CT · de_x"


FFMPEG = media.ffmpeg_exe()


@pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not available")
def test_concat_with_intro(tmp_path):
    clips = []
    for i, color in enumerate(("red", "blue")):
        out = tmp_path / f"c{i}.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", f"color={color}:s=96x64:d=1.5:r=30",
                        "-f", "lavfi", "-i", "sine=d=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-shortest", str(out)], check=True)
        clips.append(out)
    intro = tmp_path / "intro.jpg"
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=black:s=96x64", "-frames:v", "1", str(intro)],
                   check=True)
    dest = concat(clips, tmp_path / "montage.mp4", intro=intro, intro_seconds=1.0)
    info = subprocess.run([FFMPEG, "-i", str(dest)], capture_output=True, text=True).stderr
    assert "Video: h264" in info and "Audio: aac" in info
    assert "Duration: 00:00:03.9" in info or "Duration: 00:00:04.0" in info
