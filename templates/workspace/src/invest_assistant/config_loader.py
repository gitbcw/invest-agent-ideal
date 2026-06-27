from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


class ConfigError(RuntimeError):
    pass


def project_root() -> Path:
    return Path.cwd()


def read_yaml(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"Missing config file: {p}")
    data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ConfigError(f"Config file must be a mapping: {p}")
    return data


def read_paths(root: Path | None = None) -> dict[str, Any]:
    base = root or project_root()
    return read_yaml(base / "config" / "paths.yaml")


def resolve(root: Path, relative_path: str) -> Path:
    return (root / relative_path).resolve()
