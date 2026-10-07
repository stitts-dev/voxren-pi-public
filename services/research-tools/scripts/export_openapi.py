"""Write openapi.json from the live app. Run after changing a route or a model: uv run python scripts/export_openapi.py"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402

if __name__ == "__main__":
    Path(__file__).resolve().parent.parent.joinpath("openapi.json").write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
