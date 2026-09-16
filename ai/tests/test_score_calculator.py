from focuslens_ai.score_calculator import calculate_total_score, clamp_score, round_score


def test_calculates_backend_weighted_total() -> None:
    assert calculate_total_score(85.5, 72.0, 90.0) == 82.8


def test_clamps_score_to_api_range() -> None:
    assert clamp_score(-10) == 0
    assert clamp_score(120) == 100


def test_rounds_to_two_decimal_places() -> None:
    assert round_score(82.345) == 82.35
