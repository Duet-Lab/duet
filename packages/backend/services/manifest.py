"""Strict reader of a workspace's declarations: `context.json` (v4) and `INDEX.md`.

A workspace is a folder with `context.json`. Its declarations live in two files:

- `context.json`, schema v4: `meta`, `git_repos`, `reference_repos`,
  `description`, and the deployment declarations `skills` (a list of
  @-paths) and `system_prompt` (a single @-path). All migration of this file
  (legacy v1 `business.json` / `stream.json` / `product.json`, v2→v3
  `git_url` → `git_repos`, v3→v4 drop of `workspace_config`) is owned by Host.
- the YAML frontmatter of the workspace's `INDEX.md`: `name` (required),
  `icon`, and `ticket-code` — a three-letter code of the workspace's own
  tickets (`DUE`), `inherit` (the workspace works on the tickets of its
  nearest ancestor that has a code of its own), or absent (no tickets).

`name`, `icon` and `ticket_code` are no longer read from `context.json`.
Backend never writes either file.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from description import read_frontmatter


MANIFEST_FILENAME = "context.json"
INDEX_FILENAME = "INDEX.md"
TARGET_VERSION = 4

# A workspace's own ticket code: exactly three uppercase Latin letters (`DUE`).
TICKET_CODE_RE = re.compile(r"[A-Z]{3}")
# `ticket-code: inherit`: the workspace's tickets are those of its nearest
# ancestor with a code of its own.
INHERIT = "inherit"


@dataclass
class Manifest:
    version: int
    name: str
    icon: str | None = None
    meta: bool = False
    git_repos: dict[str, str] | None = None
    reference_repos: dict[str, str] | None = None
    description: str | None = None
    skills: list[str] | None = None
    system_prompt: str | None = None
    # `ticket-code` as written: a code (`DUE`), `inherit`, or None.
    ticket_code: str | None = None

    @property
    def own_ticket_code(self) -> str | None:
        """The workspace's own ticket code; None for `inherit` or no code."""
        return self.ticket_code if self.ticket_code and self.ticket_code != INHERIT else None

    @property
    def inherits_tickets(self) -> bool:
        return self.ticket_code == INHERIT


def read_manifest(
    folder: Path | str | None,
    errors: list[dict] | None = None,
) -> Manifest | None:
    """Read a workspace's declarations: `context.json` and the frontmatter of `INDEX.md`.

    Returns:
        Manifest when `context.json` is a valid v4 manifest and `INDEX.md`
        names the workspace.
        None when `context.json` is absent (not an error: the folder is not a
        workspace), invalid, of another version, or when `INDEX.md` gives no
        `name`.

    Errors (when `errors` list provided):
        - `invalid_manifest`: `context.json` present but not parseable as JSON
          or of the wrong shape.
        - `unrecognized_manifest_version`: `version` is not 4.
        - `missing_workspace_name`: the folder has `context.json`, but its
          `INDEX.md` is missing, has no frontmatter, or its frontmatter has
          no `name`.
        - `invalid_workspace_index`: the frontmatter of `INDEX.md` can't be
          read, or `name` / `icon` has the wrong type. A bad `icon` is
          dropped and the workspace stays registered.
        - `invalid_ticket_code`: `ticket-code` is neither three uppercase
          Latin letters nor `inherit`. Only the field is dropped, because a
          typo in the code must not unregister the whole workspace.

    Backend never writes manifests; upgrades happen in Host.
    """
    if not folder:
        return None

    manifest_path = Path(folder) / MANIFEST_FILENAME
    try:
        text = manifest_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as e:
        if errors is not None:
            errors.append({
                "path": str(manifest_path),
                "reason_code": "invalid_manifest",
                "description": f"Cannot read context.json at {folder}: {e}",
            })
        return None

    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        if errors is not None:
            errors.append({
                "path": str(manifest_path),
                "reason_code": "invalid_manifest",
                "description": f"Invalid JSON in context.json at {folder}: {e}",
            })
        return None

    if not isinstance(data, dict):
        _record_invalid(errors, manifest_path, folder, "must be a JSON object")
        return None

    version = data.get("version")
    if version != TARGET_VERSION:
        if errors is not None:
            errors.append({
                "path": str(manifest_path),
                "reason_code": "unrecognized_manifest_version",
                "description": (
                    f"context.json at {folder} has version={version!r}; "
                    f"backend only reads version={TARGET_VERSION}"
                ),
            })
        return None

    meta_raw = data.get("meta", False)
    if not isinstance(meta_raw, bool):
        _record_invalid(
            errors, manifest_path, folder,
            f"`meta` must be a boolean when present, got {type(meta_raw).__name__}",
        )
        return None

    description = data.get("description")
    if description is not None and not isinstance(description, str):
        _record_invalid(
            errors, manifest_path, folder,
            f"`description` must be a string when present, got {type(description).__name__}",
        )
        return None

    ref_repos_raw = data.get("reference_repos")
    ref_repos: dict[str, str] | None
    if ref_repos_raw is None:
        ref_repos = None
    elif isinstance(ref_repos_raw, dict):
        for k, v in ref_repos_raw.items():
            if not isinstance(k, str) or not k.strip():
                _record_invalid(
                    errors, manifest_path, folder,
                    f"`reference_repos` keys must be non-empty strings, got {k!r}",
                )
                return None
            if not isinstance(v, str) or not v.strip():
                _record_invalid(
                    errors, manifest_path, folder,
                    f"`reference_repos[{k!r}]` must be a non-empty string, got {v!r}",
                )
                return None
        ref_repos = dict(ref_repos_raw) if ref_repos_raw else None
    else:
        _record_invalid(
            errors, manifest_path, folder,
            f"`reference_repos` must be an object when present, got {type(ref_repos_raw).__name__}",
        )
        return None

    git_repos_raw = data.get("git_repos")
    git_repos: dict[str, str] | None
    if git_repos_raw is None:
        git_repos = None
    elif not isinstance(git_repos_raw, dict):
        _record_invalid(
            errors, manifest_path, folder,
            "git_repos must be an object when present",
        )
        return None
    elif not git_repos_raw:
        _record_invalid(
            errors, manifest_path, folder,
            "git_repos must be non-empty when present",
        )
        return None
    else:
        for alias, url in git_repos_raw.items():
            if not isinstance(alias, str) or not alias.strip():
                _record_invalid(
                    errors, manifest_path, folder,
                    "git_repos keys must be non-empty strings",
                )
                return None
            if not isinstance(url, str) or not url.strip():
                _record_invalid(
                    errors, manifest_path, folder,
                    f"git_repos[{alias!r}] must be a non-empty string",
                )
                return None
        # Shared-namespace check: alias must not overlap with reference_repos.
        if ref_repos:
            overlap = set(git_repos_raw).intersection(ref_repos)
            if overlap:
                alias = next(iter(overlap))
                _record_invalid(
                    errors, manifest_path, folder,
                    f"alias '{alias}' is in both git_repos and reference_repos",
                )
                return None
        # Preserve insertion order (Python 3.7+ dict invariant): repos are
        # listed to agents in the order keys appeared in the manifest.
        git_repos = dict(git_repos_raw)

    skills, ok = _read_at_path_list(data, "skills", errors, manifest_path, folder)
    if not ok:
        return None

    system_prompt, ok = _read_at_path_string(data, "system_prompt", errors, manifest_path, folder)
    if not ok:
        return None

    fields = _read_index_fields(Path(folder), errors)
    if fields is None:
        return None
    name, icon, ticket_code = fields

    return Manifest(
        version=version,
        name=name,
        icon=icon,
        meta=meta_raw,
        git_repos=git_repos,
        reference_repos=ref_repos,
        description=description,
        skills=skills,
        system_prompt=system_prompt,
        ticket_code=ticket_code,
    )


def _record_invalid(
    errors: list[dict] | None,
    manifest_path: Path,
    folder: Path | str,
    detail: str,
) -> None:
    if errors is None:
        return
    errors.append({
        "path": str(manifest_path),
        "reason_code": "invalid_manifest",
        "description": f"context.json at {folder}: {detail}",
    })


def _read_at_path_list(
    data: dict,
    key: str,
    errors: list[dict] | None,
    manifest_path: Path,
    folder: Path | str,
) -> tuple[list[str] | None, bool]:
    """Parse an optional list-of-@-paths field (`skills`).

    @-path *resolution* happens later (deploy); here we only
    validate shape — a list of non-empty strings. Returns (value_or_None, ok).
    """
    raw = data.get(key)
    if raw is None:
        return None, True
    if not isinstance(raw, list):
        _record_invalid(
            errors, manifest_path, folder,
            f"`{key}` must be a list when present, got {type(raw).__name__}",
        )
        return None, False
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            _record_invalid(
                errors, manifest_path, folder,
                f"`{key}` entries must be non-empty strings",
            )
            return None, False
    return list(raw), True


def _read_at_path_string(
    data: dict,
    key: str,
    errors: list[dict] | None,
    manifest_path: Path,
    folder: Path | str,
) -> tuple[str | None, bool]:
    """Parse an optional single-@-path field (`system_prompt`).

    Shape only — a non-empty string. Returns (value_or_None, ok).
    """
    raw = data.get(key)
    if raw is None:
        return None, True
    if isinstance(raw, str) and raw.strip():
        return raw, True
    _record_invalid(
        errors, manifest_path, folder,
        f"`{key}` must be a non-empty string when present",
    )
    return None, False


def _read_index_fields(
    folder: Path,
    errors: list[dict] | None,
) -> tuple[str, str | None, str | None] | None:
    """(name, icon, ticket-code) from the frontmatter of the workspace's `INDEX.md`.

    None when there is no usable `name`: a strict reader must not fall back
    to the folder name and register a workspace nobody named.
    """
    index_path = folder / INDEX_FILENAME

    def report(reason_code: str, detail: str) -> None:
        if errors is not None:
            errors.append({
                "path": str(index_path),
                "reason_code": reason_code,
                "description": f"INDEX.md of the workspace at {folder}: {detail}",
            })

    try:
        fields = read_frontmatter(index_path)
    except FileNotFoundError:
        report("missing_workspace_name",
               "the file is missing; a folder with context.json needs an INDEX.md "
               "whose frontmatter gives the workspace's `name`")
        return None
    except (OSError, UnicodeError, ValueError) as e:
        report("invalid_workspace_index", f"the frontmatter can't be read: {e}")
        return None
    if fields is None:
        report("missing_workspace_name",
               "no frontmatter; it must give the workspace's `name`")
        return None

    name = fields.get("name")
    if name is None:
        report("missing_workspace_name", "the frontmatter has no `name`")
        return None
    if not isinstance(name, str) or not name.strip():
        report("invalid_workspace_index",
               f"`name` must be a non-empty string, got {name!r}")
        return None

    icon = fields.get("icon")
    if icon is not None and not isinstance(icon, str):
        report("invalid_workspace_index",
               f"`icon` must be a string when present, got {icon!r}; field ignored")
        icon = None

    ticket_code = fields.get("ticket-code")
    if ticket_code is not None and not (
        isinstance(ticket_code, str)
        and (TICKET_CODE_RE.fullmatch(ticket_code) or ticket_code == INHERIT)
    ):
        report("invalid_ticket_code",
               f"`ticket-code` must be three uppercase Latin letters or `{INHERIT}`, "
               f"got {ticket_code!r}; field ignored")
        ticket_code = None

    return name, icon or None, ticket_code


def read_reference_repos(folder: Path | str | None) -> dict[str, str] | None:
    """Return `{name: url}` from the workspace's manifest, or None if absent."""
    manifest = read_manifest(folder)
    if not manifest or not manifest.reference_repos:
        return None
    return dict(manifest.reference_repos)


def read_git_repos(folder: Path | str | None) -> dict[str, str] | None:
    """Return `{alias: url}` from the workspace's manifest, or None if absent."""
    manifest = read_manifest(folder)
    if not manifest or not manifest.git_repos:
        return None
    return dict(manifest.git_repos)
