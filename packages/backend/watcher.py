"""Manifest file watcher for auto-rescan.

Watches root workspace folders for changes to workspace declarations:
`context.json` manifests, and the frontmatter of the `INDEX.md` beside them,
which carries a workspace's `name`, `icon` and `ticket-code`. On a change it
debounces 10s, then triggers a rescan.

An `INDEX.md` triggers a rescan only when its folder has `context.json` and
its frontmatter differs from what the last scan read: editing the body of an
entry point, or any ticket's `INDEX.md`, never rescans.

Uses watchfiles (async-native, Rust notify-rs) for OS-level
file system events (FSEvents/inotify/ReadDirectoryChangesW).
"""

import asyncio
import logging
import os
from pathlib import Path
from typing import Awaitable, Callable, Iterable, Mapping

from watchfiles import awatch, Change, DefaultFilter

from description import frontmatter_block
from normalization import normalize_path

logger = logging.getLogger("duet")

MANIFEST_NAME = "context.json"
INDEX_NAME = "INDEX.md"
WATCHED_NAMES = frozenset({MANIFEST_NAME, INDEX_NAME})
DEBOUNCE_SECONDS = 10


class ManifestFilter(DefaultFilter):
    """Filter that only passes manifest and `INDEX.md` changes.

    Inherits DefaultFilter exclusions (.git, __pycache__, node_modules,
    hidden files, temp files) then narrows to the watched filenames. Whether
    an `INDEX.md` change matters is decided later (`needs_rescan`), because
    it takes reading the file.
    """

    def __call__(self, change: Change, path: str) -> bool:
        if not super().__call__(change, path):
            return False
        return Path(path).name in WATCHED_NAMES


def read_index_frontmatter(path: Path) -> str | None:
    """The raw frontmatter block of an `INDEX.md`, or None if it has none or can't be read."""
    try:
        return frontmatter_block(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        return None


def needs_rescan(
    changes: Iterable[tuple[Change, str]],
    frontmatters: Mapping[str, str],
) -> bool:
    """Whether a batch of changes alters any workspace declaration.

    `frontmatters` maps the real path of the `INDEX.md` of every workspace
    the last scan registered to its raw frontmatter. A `context.json` change always
    counts. An `INDEX.md` change counts only when the folder has
    `context.json` (or had one at the last scan) and the frontmatter now
    differs from the one the scan read — including a workspace whose
    `INDEX.md` the scan could not use and that now may name it.
    """
    for _change, raw in changes:
        path = Path(raw)
        if path.name == MANIFEST_NAME:
            return True
        if path.name != INDEX_NAME:
            continue
        # Snapshots are keyed by real path (`Scanner._remember_frontmatter`).
        key = normalize_path(os.path.realpath(path))
        known = frontmatters.get(key)
        if known is None and not (path.parent / MANIFEST_NAME).exists():
            continue
        if read_index_frontmatter(path) != known:
            return True
    return False


class ManifestWatcher:
    """Watches root workspace folders for declaration changes, triggers rescan.

    Usage:
        watcher = ManifestWatcher(on_scan=run_scan_with_cache,
                                  frontmatters=lambda: service.index_frontmatters)
        watcher.start(folders)
        # ... later ...
        watcher.stop()
    """

    def __init__(
        self,
        on_scan: Callable[[], Awaitable[dict] | dict],
        frontmatters: Callable[[], Mapping[str, str]] | None = None,
    ):
        self._on_scan = on_scan
        self._frontmatters = frontmatters or (lambda: {})
        self._task: asyncio.Task | None = None
        self._watched_folders: list[str] = []

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def watched_folders(self) -> list[str]:
        return list(self._watched_folders)

    def start(self, folders: list[str]) -> None:
        """Start watching folders. No-op if already watching same folders."""
        existing = [f for f in folders if Path(f).exists()]
        if not existing:
            logger.info("Watcher: no existing root workspace folders to watch")
            return

        if self.is_running and existing == self._watched_folders:
            return

        self.stop()
        self._watched_folders = existing
        self._task = asyncio.create_task(self._watch_loop(existing))
        logger.info(f"Watcher: started on {len(existing)} folder(s)")

    def stop(self) -> None:
        """Stop watching."""
        if self._task and not self._task.done():
            self._task.cancel()
            logger.info("Watcher: stopped")
        self._task = None
        self._watched_folders = []

    def restart(self, folders: list[str]) -> None:
        """Restart with new folder list."""
        self.stop()
        self.start(folders)

    def maybe_restart(self, folders: list[str]) -> None:
        """Restart only if folder list changed."""
        existing = [f for f in folders if Path(f).exists()]
        if existing != self._watched_folders:
            logger.info("Watcher: root workspace folders changed, restarting")
            self.restart(folders)

    async def _watch_loop(self, folders: list[str]) -> None:
        """Main watch loop with debounce."""
        try:
            async for changes in awatch(
                *folders,
                watch_filter=ManifestFilter(),
                debounce=DEBOUNCE_SECONDS * 1000,  # ms
                recursive=True,
            ):
                # Reading INDEX.md may stall on a cloud drive: keep it off the loop.
                if not await asyncio.to_thread(needs_rescan, changes, self._frontmatters()):
                    continue
                logger.info("Watcher: workspace declaration change detected, running scan")
                try:
                    result = self._on_scan()
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    logger.exception("Watcher: scan failed")
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Watcher: watch loop error")
