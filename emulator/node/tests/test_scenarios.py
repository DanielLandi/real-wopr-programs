"""The finale strategy list is a transcription — guard its shape, not its taste."""

from app.scenarios import SCENARIOS, montage_text


def test_the_full_sourced_sweep_is_present_in_screen_order():
    # 157 entries: 22 screens of seven plus a final screen of three.
    assert len(SCENARIOS) == 157
    assert SCENARIOS[0] == "U.S. FIRST STRIKE"
    assert SCENARIOS[6] == "USSR CHINA ATTACK"      # end of screen 1
    assert SCENARIOS[-1] == "CASPIAN DEFENCE"
    # Pinned downstream (real-wopr evals/scenarios/e04, tests/test_gtw.py).
    assert "GABON REBELLION" in SCENARIOS


def test_names_are_teletype_shaped():
    for name in SCENARIOS:
        assert name == name.upper()
        assert name.isascii()
        assert name.strip() == name
        assert len(name) <= 22   # the table's column width, truncations restored


def test_montage_prints_every_scenario_between_its_banners():
    lines = montage_text().split("\n")
    assert lines[1] == "RUNNING ALL STRATEGIES..."
    assert lines[-1] == "WINNER: NONE"
    body = lines[3:3 + len(SCENARIOS)]
    assert body == list(SCENARIOS)
    assert "*** ALL SCENARIOS EXHAUSTED ***" in lines
