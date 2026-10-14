"""
Random seed utilities for reproducibility across numpy, python, and torch.
"""

import os
import random
import numpy as np


def set_seed(seed: int = 42) -> None:
    """
    Set fixed random seeds across all libraries.

    Args:
        seed (int): The random seed to apply.
    """
    random.seed(seed)
    np.random.seed(seed)
    os.environ["PYTHONHASHSEED"] = str(seed)
    try:
        import torch
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed(seed)
            torch.cuda.manual_seed_all(seed)
            torch.backends.cudnn.deterministic = True
            torch.backends.cudnn.benchmark = False
    except (ImportError, OSError):
        pass
