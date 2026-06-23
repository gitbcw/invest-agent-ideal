#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
required = [
    "SKILL.md",
    "references/skeleton.md",
    "references/instances/default.md",
    "references/review.md",
    "references/screening.md",
    "references/alerts.md",
    "references/evolution.md",
]

missing = [path for path in required if not (ROOT / path).exists()]
if missing:
    raise SystemExit("Missing required files: " + ", ".join(missing))

skeleton = (ROOT / "references/skeleton.md").read_text(encoding="utf-8")
if "Single-user instances must not edit this file" not in skeleton:
    raise SystemExit("skeleton.md must declare single-user write protection")

print("middle-trend strategy skill OK")
