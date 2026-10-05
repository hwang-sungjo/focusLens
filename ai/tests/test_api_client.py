from focuslens_ai.api_client import to_focus_log_payload
from focuslens_ai.models import MinuteScore


def test_converts_internal_score_to_backend_payload() -> None:
    score = MinuteScore(gaze=85.5, blink=72.0, head=90.0, total=82.8, face_detected=True)
    assert to_focus_log_payload(score).to_dict() == {
        "gaze": 85.5,
        "blink": 72.0,
        "head": 90.0,
        "total": 82.8,
        "face_detected": True,
    }
