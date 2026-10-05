from __future__ import annotations

import httpx

from .models import FocusLogPayload, MinuteScore


class FocusLogApiError(RuntimeError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def to_focus_log_payload(score: MinuteScore) -> FocusLogPayload:
    return FocusLogPayload(
        gaze=score.gaze,
        blink=score.blink,
        head=score.head,
        total=score.total,
        face_detected=score.face_detected,
    )


class FocusLogApiClient:
    def __init__(self, base_url: str, token: str, timeout: float = 10.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout

    def send_focus_log(self, session_id: str, score: MinuteScore) -> None:
        response = httpx.post(
            f"{self._base_url}/api/sessions/{session_id}/log",
            headers={"Authorization": f"Bearer {self._token}"},
            json=to_focus_log_payload(score).to_dict(),
            timeout=self._timeout,
        )
        if response.is_success:
            return

        try:
            message = response.json().get("error")
        except (ValueError, AttributeError):
            message = None
        raise FocusLogApiError(message or "집중도 로그 전송에 실패했습니다.", response.status_code)
