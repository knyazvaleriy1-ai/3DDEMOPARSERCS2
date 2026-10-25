import struct
import subprocess
import wave

import pytest

from cs2demo import media

FFMPEG = media.ffmpeg_exe()
pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not available")


def _jpeg(color: str) -> bytes:
    return subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", f"color={color}:s=64x48", "-frames:v", "1",
         "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
        capture_output=True, check=True,
    ).stdout


def _streams(path) -> str:
    return subprocess.run([FFMPEG, "-i", str(path)], capture_output=True, text=True).stderr


def _wav(path, seconds=1.0, rate=48000):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<hh", 1000, -1000) for _ in range(int(rate * seconds))))


def test_frame_encoder_with_audio(tmp_path):
    wav = tmp_path / "a.wav"
    _wav(wav)
    enc = media.FrameEncoder(tmp_path / "clip.mp4", fps=10, audio=wav)
    frame = _jpeg("red")
    for _ in range(10):
        enc.write(frame)
    out = enc.close()
    info = _streams(out)
    assert "Video: h264" in info and "Audio: aac" in info


def test_transcode_webm_to_h264_aac(tmp_path):
    src = tmp_path / "in.webm"
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc=s=64x48:d=1", "-f", "lavfi", "-i", "sine=d=1",
         "-c:v", "libvpx-vp9", "-c:a", "libopus", "-shortest", str(src)],
        check=True,
    )
    dest = tmp_path / "out.mp4"
    assert media.transcode_to_mp4(src, dest)
    info = _streams(dest)
    assert "Video: h264" in info and "Audio: aac" in info
