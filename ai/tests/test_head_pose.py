import numpy as np

from focuslens_ai.head_pose import HeadPose, extract_head_pose


def test_identity_matrix_is_forward_pose() -> None:
    pose = extract_head_pose(np.identity(4))
    assert pose == HeadPose(yaw=-0.0, pitch=0.0, roll=0.0)


def test_invalid_matrix_returns_none() -> None:
    assert extract_head_pose(np.identity(2)) is None
