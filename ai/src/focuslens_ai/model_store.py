from __future__ import annotations

from pathlib import Path
from urllib.request import urlopen

from .config import MODEL_URL


def ensure_model(model_path: Path, model_url: str = MODEL_URL) -> Path:
    """모델이 없으면 임시 파일로 받은 뒤 원자적으로 이동한다."""
    path = model_path.expanduser().resolve()
    if path.is_file() and path.stat().st_size > 0:
        return path

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(f"{path.suffix}.part")
    try:
        with urlopen(model_url, timeout=60) as response:
            with temporary_path.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        temporary_path.replace(path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    return path
