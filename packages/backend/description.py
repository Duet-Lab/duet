"""INDEX.md frontmatter of a workspace, and the legacy Markdown description extractor."""

import logging
import re
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

_FRONTMATTER = re.compile(
    r"\A\ufeff?---[ \t]*\r?\n(.*?)^---[ \t]*(?:\r?\n|\Z)", re.S | re.M
)


def frontmatter_block(text: str) -> str | None:
    """The raw YAML between the `---` lines at the top of `text`, or None."""
    match = _FRONTMATTER.match(text)
    return match.group(1) if match else None


def read_frontmatter(path: Path) -> dict | None:
    """Parse the YAML frontmatter of a Markdown file.

    Returns the mapping, or None when the file has no frontmatter.

    Raises:
        FileNotFoundError: the file is missing.
        OSError, UnicodeError: the file can't be read as UTF-8.
        ValueError: the frontmatter is not valid YAML or not a mapping.
    """
    block = frontmatter_block(path.read_text(encoding="utf-8"))
    if block is None:
        return None
    try:
        fields = yaml.safe_load(block)
    except yaml.YAMLError as exc:
        raise ValueError(f"invalid YAML: {exc}") from exc
    if fields is None:
        return {}
    if not isinstance(fields, dict):
        raise ValueError("the frontmatter is not a mapping of fields")
    return fields


def read_workspace_description(folder: Path) -> str | None:
    """Read a workspace's explicit description, without legacy fallbacks.

    Args:
        folder: The workspace folder containing INDEX.md.

    Returns:
        A nonempty string from YAML frontmatter, normalized to one line,
        or None when absent or invalid. Never reads README or the manifest.
    """
    path = folder / "INDEX.md"
    try:
        fields = read_frontmatter(path)
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as exc:
        logger.warning("Cannot read workspace description in %s: %s", path, exc)
        return None
    except ValueError:
        logger.warning("Invalid workspace frontmatter in %s", path)
        return None
    if not fields:
        return None
    value = fields.get("description")
    return (" ".join(value.split()) or None) if isinstance(value, str) else None


def extract_description(file_path: Path) -> str | None:
    """Extract description from a markdown file.

    Algorithm:
    1. Find first # heading (not ##)
    2. Skip empty lines after heading
    3. If next content is a plain paragraph -> first sentence of first line
    4. Else (##, table, list, code block, blockquote, etc.) -> H1 text itself
    5. File doesn't exist or no H1 -> None

    "Plain paragraph" = line starting with letter/digit/quote character.
    First sentence = text up to first `. `, `! `, `? ` or end of line.
    Only the first line of a multi-line paragraph is considered.
    """
    try:
        text = file_path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return None

    lines = text.splitlines()
    h1_text = None
    h1_index = None

    # Find first # heading (not ## or deeper)
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("# ") and not stripped.startswith("## "):
            h1_text = stripped[2:].strip()
            h1_index = i
            break

    if h1_text is None:
        return None

    # Find first non-empty line after H1
    for i in range(h1_index + 1, len(lines)):
        line = lines[i].strip()
        if not line:
            continue

        # Check if it's a plain paragraph (starts with letter/digit/quote/bracket)
        if re.match(
            r'^[a-zA-Z\u00C0-\u024F'       # Latin + extended Latin
            r'\u0400-\u04FF'                  # Cyrillic
            r'\u0600-\u06FF'                  # Arabic
            r'\u4E00-\u9FFF'                  # CJK
            r'0-9'                            # digits
            r'"\u201c\u201d\u00ab\u00bb'      # quotes: " " " « »
            r"'\u2018\u2019"                  # single quotes: ' '
            r'\[\('                           # brackets: [ (
            r']',
            line,
        ):
            return _extract_first_sentence(line)

        # Structural element -> use H1 text
        return h1_text

    # No content after H1
    return h1_text


def _extract_first_sentence(text: str) -> str:
    """Extract first sentence from text.

    Splits on sentence-ending punctuation (. ! ?) followed by space or end.
    ASCII sentence-enders only — sufficient for Latin/Cyrillic content.
    Note: splits on abbreviations like "Dr. " or "e.g. " — acceptable
    for README/spec descriptions which don't start with abbreviations.
    """
    # Limit input to prevent regex backtracking on very long lines
    text = text[:500]
    match = re.match(r'^(.+?[.!?])(?:\s|$)', text)
    if match:
        return match.group(1)
    # No sentence ending found -> return whole line
    return text.strip()
