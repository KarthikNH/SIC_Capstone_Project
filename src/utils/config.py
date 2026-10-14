"""
Configuration loader and validator for the power grid cascading failure project.
"""

from pathlib import Path
from typing import Any, Dict
import yaml


def load_config(config_path: str = "config.yaml") -> Dict[str, Any]:
    """
    Load and parse configuration YAML file.

    Args:
        config_path (str): Relative or absolute path to the configuration YAML file.

    Returns:
        Dict[str, Any]: Dictionary containing hierarchical configuration parameters.
    """
    path = Path(config_path)
    if not path.is_file():
        raise FileNotFoundError(f"Configuration file not found at: {config_path}")

    with open(path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    return config
