from pathlib import Path
from shutil import copyfile


ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = (
    ROOT
    / "docs"
    / "manual-source"
    / "ai-investment-decision-assistant-product-introduction.pdf"
)
OUTPUT_PATH = ROOT / "public" / "manual" / "invest-agent-user-manual.pdf"


def publish_pdf():
    if not SOURCE_PATH.exists():
        raise FileNotFoundError(f"Official manual PDF not found: {SOURCE_PATH}")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    copyfile(SOURCE_PATH, OUTPUT_PATH)


if __name__ == "__main__":
    publish_pdf()
