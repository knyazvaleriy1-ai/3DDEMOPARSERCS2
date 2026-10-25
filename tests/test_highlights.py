from cs2demo.highlights import detect_clutches, detect_highlights, score_kills, weapon_name
from conftest import RATE, make_kill, make_meta


def test_fast_triple_kill_is_one_clip():
    kills = [make_kill(64 * 30 + i * 64, 1, 5 + i, headshot=True) for i in range(3)]
    hs = detect_highlights(make_meta(kills))
    assert len(hs) == 1
    h = hs[0]
    assert h["kind"] == "multikill"
    assert h["label"] == "3K"
    assert h["kills"] == [0, 1, 2]
    assert "HS ×3" in h["tags"] and "молниеносно" in h["tags"]
    # 3 s pre-roll and 2.5 s post-roll around the kills
    assert h["start"] == kills[0]["tick"] - 3 * RATE
    assert h["end"] == kills[-1]["tick"] + int(2.5 * RATE)
    assert h["id"] == "r01-player1-3k"


def test_kills_far_apart_are_split():
    kills = [make_kill(64 * 20, 2, 5), make_kill(64 * 22, 2, 6), make_kill(64 * 80, 2, 7), make_kill(64 * 83, 2, 8)]
    hs = detect_highlights(make_meta(kills))
    assert [len(h["kills"]) for h in hs] == [2, 2]
    assert all("за раунд: 4K" in h["tags"] for h in hs)
    assert len({h["id"] for h in hs}) == 2


def test_ace_scores_higher_than_double():
    ace, _ = score_kills([make_kill(64 * i, 0, 5 + i) for i in range(5)], RATE)
    double, _ = score_kills([make_kill(64 * i, 0, 5 + i) for i in range(2)], RATE)
    assert ace > double >= 20


def test_plain_single_kill_is_filtered_but_noscope_is_kept():
    kills = [
        make_kill(64 * 20, 0, 5),
        make_kill(64 * 60, 1, 6, weapon="awp", noscope=True, headshot=True),
    ]
    hs = detect_highlights(make_meta(kills))
    assert len(hs) == 1
    assert hs[0]["player"] == 1 and "ноускоп" in hs[0]["tags"]


def test_noscope_flag_on_rifle_is_ignored():
    kills = [make_kill(64 * 60, 1, 6, weapon="ak47", noscope=True)]
    assert detect_highlights(make_meta(kills)) == []


def test_won_clutch_merges_with_kills():
    # A T teamkill leaves 4 T; the CT side then dies down to player 5 alone (1v4),
    # who kills all four and wins the round.
    t = 64 * 30
    kills = [
        make_kill(t, 4, 1, a_side="T", v_side="T", teamkill=True),
        make_kill(t + 64, 0, 6), make_kill(t + 128, 0, 7), make_kill(t + 192, 2, 8), make_kill(t + 256, 2, 9),
    ]
    clutch_kills = [make_kill(t + 64 * 20 + i * 64 * 3, 5, v, a_side="CT", v_side="T") for i, v in enumerate((0, 2, 3))]
    last = make_kill(t + 64 * 40, 5, 4, a_side="CT", v_side="T")
    rounds = [{
        "num": 1, "start": 0, "freezeEnd": 64 * 15, "end": t + 64 * 41, "next": t + 64 * 48,
        "winner": "CT", "reason": "t_killed",
        "alive": {"T": [0, 1, 2, 3, 4], "CT": [5, 6, 7, 8, 9]},
    }]
    meta = make_meta(kills + clutch_kills + [last], rounds=rounds)
    clutches = detect_clutches(meta)
    assert len(clutches) == 1
    c = clutches[0]
    assert c["player"] == 5 and c["side"] == "CT" and c["won"]
    assert c["vs"] == 4  # 4 T alive when player 5 became the last CT
    hs = [h for h in detect_highlights(meta) if h["player"] == 5]
    assert len(hs) == 1
    h = hs[0]
    assert h["kind"] == "clutch"
    assert h["label"].startswith("Клатч 1v4")
    assert len(h["kills"]) == 4
    assert h["start"] <= c["startTick"]


def test_lost_clutch_is_not_a_highlight():
    t = 64 * 30
    kills = [make_kill(t + i * 64, 0, 6 + i) for i in range(4)] + [make_kill(t + 64 * 10, 1, 5)]
    meta = make_meta(kills)  # T wins
    clutches = detect_clutches(meta)
    assert len(clutches) == 1 and not clutches[0]["won"]
    assert all(h["kind"] != "clutch" for h in detect_highlights(meta))


def test_options_change_windows_and_threshold():
    kills = [make_kill(64 * 30, 1, 5), make_kill(64 * 31, 1, 6)]
    meta = make_meta(kills)
    (h,) = detect_highlights(meta, pre=1, post=1)
    assert h["start"] == kills[0]["tick"] - RATE
    assert detect_highlights(meta, min_score=500) == []


def test_clip_is_clamped_to_round():
    kills = [make_kill(10, 1, 5), make_kill(40, 1, 6)]
    rounds = [{"num": 1, "start": 0, "freezeEnd": 0, "end": 100, "next": 120, "winner": "T", "reason": "",
               "alive": {"T": [0, 1, 2, 3, 4], "CT": [5, 6, 7, 8, 9]}}]
    (h,) = detect_highlights(make_meta(kills, rounds=rounds))
    assert h["start"] == 0 and h["end"] == 120


def test_weapon_names():
    assert weapon_name("weapon_ak47") == "AK-47"
    assert weapon_name("knife_karambit") == "Нож"
    assert weapon_name("m4a1_silencer") == "M4A1-S"
