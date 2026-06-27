from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class MemoryWriteError(RuntimeError):
    pass


class JsonlStore:
    def __init__(self, root: Path, schema_dir: Path | None = None) -> None:
        self.root = root
        self.schema_dir = schema_dir or root / "schemas" / "jsonl"

    def append(self, relative_path: str, record: dict[str, Any], schema_name: str | None = None) -> dict[str, Any]:
        normalized = self._normalize(record)
        if schema_name:
            self._validate(normalized, schema_name)
        target = self.root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(normalized, ensure_ascii=False, sort_keys=True)
        try:
            with target.open("a", encoding="utf-8", newline="\n") as f:
                f.write(line + "\n")
        except OSError as exc:
            raise MemoryWriteError(f"Failed to append memory file {target}: {exc}") from exc
        return normalized

    def read_all(self, relative_path: str) -> list[dict[str, Any]]:
        target = self.root / relative_path
        if not target.exists():
            return []
        rows: list[dict[str, Any]] = []
        for line_no, line in enumerate(target.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise MemoryWriteError(f"Invalid JSONL at {target}:{line_no}: {exc}") from exc
        return rows

    def _normalize(self, record: dict[str, Any]) -> dict[str, Any]:
        out = dict(record)
        out.setdefault("id", str(uuid.uuid4()))
        out.setdefault("created_at", datetime.now(timezone.utc).isoformat())
        return out

    def _validate(self, record: dict[str, Any], schema_name: str) -> None:
        schema_path = self.schema_dir / f"{schema_name}.schema.json"
        if not schema_path.exists():
            raise MemoryWriteError(f"Missing schema: {schema_path}")
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        required = schema.get("required", [])
        missing = [key for key in required if key not in record]
        if missing:
            raise MemoryWriteError(f"Record for {schema_name} missing required fields: {', '.join(missing)}")
        properties = schema.get("properties", {})
        for key, value in record.items():
            expected = properties.get(key, {}).get("type")
            if expected and not self._matches_type(value, expected):
                raise MemoryWriteError(f"Record field {key} should be {expected}, got {type(value).__name__}")

    @staticmethod
    def _matches_type(value: Any, expected: str | list[str]) -> bool:
        types = expected if isinstance(expected, list) else [expected]
        for t in types:
            if t == "null" and value is None:
                return True
            if t == "string" and isinstance(value, str):
                return True
            if t == "boolean" and isinstance(value, bool):
                return True
            if t == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
                return True
            if t == "integer" and isinstance(value, int) and not isinstance(value, bool):
                return True
            if t == "object" and isinstance(value, dict):
                return True
            if t == "array" and isinstance(value, list):
                return True
        return False
