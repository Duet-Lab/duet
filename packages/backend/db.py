"""SQLite database manager for Duet entities.

Stores three entity kinds:
- `workspace`: folders on Drive with `context.json`, named by the frontmatter
  of their `INDEX.md`. `meta=1` marks the meta workspace; `ticket_code` keeps
  `ticket-code` as written (a code, `inherit`, or NULL). Presence of
  `git_repos` in the manifest means the workspace owns one or more git-backed
  products; workspace discovery still continues below that folder. The
  `git_url` column is never populated on workspace rows.
- `product_repo`: registered once per alias in a workspace's `git_repos` map;
  a repo several workspaces declare is registered by the first of them.
  Entity name = `{alias}.git`, `git_url` = URL from the manifest.
  Path-resolution helper; not shown in tree.
- `reference_repo`: read-only clones declared via `reference_repos` map.

Thread safety: scans run in worker threads (asyncio.to_thread) while HTTP
handlers use the same connection from the event loop thread. The connection
is created with check_same_thread=False and every operation is serialized
through an RLock.
"""

import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from config import get_db_path


EntityType = Literal["workspace", "product_repo", "reference_repo"]


@dataclass
class Entity:
    id: int | None
    type: EntityType
    name: str
    icon: str
    drive_path: str
    parent_id: int | None = None
    git_url: str | None = None
    meta: bool = False
    # `ticket-code` of a workspace as written: a code, `inherit`, or None.
    ticket_code: str | None = None


class DatabaseManager:
    """Manages SQLite database for entity hierarchy."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or get_db_path()
        self.conn: sqlite3.Connection | None = None
        # Serializes all DB access across threads (reentrant: some methods
        # call other locked methods, e.g. get_entity_chain -> get_entity).
        self._lock = threading.RLock()

    def init(self) -> None:
        """Initialize database connection and schema."""
        with self._lock:
            if self.conn:
                return

            self.db_path.parent.mkdir(parents=True, exist_ok=True)

            # check_same_thread=False: connection is shared between the event
            # loop thread and scan worker threads; _lock serializes access.
            self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self.conn.row_factory = sqlite3.Row
            self._init_schema()

    def _init_schema(self) -> None:
        """Create tables and indexes if not exist."""
        if not self.conn:
            raise RuntimeError("Database not initialized")

        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS entities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT,
                name TEXT,
                icon TEXT,
                drive_path TEXT UNIQUE,
                parent_id INTEGER REFERENCES entities(id),
                git_url TEXT
            )
        """)

        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_name ON entities(name)"
        )

        self._migrate_add_column("entities", "meta", "INTEGER DEFAULT 0")
        self._migrate_add_column("entities", "ticket_code", "TEXT")
        # Rows written before DUE063 called a workspace `context`; the next
        # scan rewrites them anyway, this keeps `/workspaces` whole until then.
        self.conn.execute("UPDATE entities SET type = 'workspace' WHERE type = 'context'")

        self.conn.commit()

    def _migrate_add_column(
        self, table: str, column: str, col_type: str
    ) -> None:
        """Add column to table if it doesn't exist (schema migration)."""
        if not self.conn:
            return
        cursor = self.conn.execute(f"PRAGMA table_info({table})")
        columns = {row[1] for row in cursor.fetchall()}
        if column not in columns:
            self.conn.execute(
                f"ALTER TABLE {table} ADD COLUMN {column} {col_type}"
            )

    def close(self) -> None:
        """Close database connection."""
        with self._lock:
            if self.conn:
                self.conn.close()
                self.conn = None

    def clear(self) -> None:
        """Delete all entities from database."""
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")
            self.conn.execute("DELETE FROM entities")
            self.conn.commit()

    def insert_entity(self, entity: Entity) -> int:
        """Insert entity and return its ID.

        Uses INSERT OR IGNORE for idempotency.
        """
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")

            self.conn.execute(
                """INSERT OR IGNORE INTO entities
                   (type, name, icon, drive_path, parent_id, git_url, meta, ticket_code)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    entity.type,
                    entity.name,
                    entity.icon,
                    entity.drive_path,
                    entity.parent_id,
                    entity.git_url,
                    1 if entity.meta else 0,
                    entity.ticket_code,
                ),
            )
            self.conn.commit()

            cursor = self.conn.execute(
                "SELECT id FROM entities WHERE drive_path = ?", (entity.drive_path,)
            )
            row = cursor.fetchone()
            if row:
                return row["id"]

            raise RuntimeError(f"Failed to insert/get entity: {entity.drive_path}")

    def get_all_entities(self) -> list[Entity]:
        """Get all entities."""
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")

            cursor = self.conn.execute("SELECT * FROM entities")
            return [self._row_to_entity(row) for row in cursor.fetchall()]

    def get_entity(self, entity_id: int) -> Entity | None:
        """Get entity by ID."""
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")

            cursor = self.conn.execute(
                "SELECT * FROM entities WHERE id = ?", (entity_id,)
            )
            row = cursor.fetchone()
            return self._row_to_entity(row) if row else None

    def find_by_name(self, name: str) -> Entity | None:
        """Find entity by name (globally unique)."""
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")

            cursor = self.conn.execute(
                "SELECT * FROM entities WHERE name = ?", (name,)
            )
            row = cursor.fetchone()
            return self._row_to_entity(row) if row else None

    def name_exists(self, name: str) -> bool:
        """Check if name exists in database."""
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")

            cursor = self.conn.execute(
                "SELECT 1 FROM entities WHERE name = ? LIMIT 1", (name,)
            )
            return cursor.fetchone() is not None

    def update_entity_name(self, entity_id: int, new_name: str) -> None:
        """Update entity name by ID."""
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")

            self.conn.execute(
                "UPDATE entities SET name = ? WHERE id = ?", (new_name, entity_id)
            )
            self.conn.commit()

    def has_children(
        self, parent_id: int, exclude_types: list[str] | None = None
    ) -> bool:
        """Check if entity has children, optionally excluding types."""
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")

            if exclude_types:
                placeholders = ", ".join("?" * len(exclude_types))
                cursor = self.conn.execute(
                    f"""SELECT 1 FROM entities
                        WHERE parent_id = ? AND type NOT IN ({placeholders})
                        LIMIT 1""",
                    (parent_id, *exclude_types),
                )
            else:
                cursor = self.conn.execute(
                    "SELECT 1 FROM entities WHERE parent_id = ? LIMIT 1",
                    (parent_id,),
                )

            return cursor.fetchone() is not None

    def find_by_drive_path(self, drive_path: str) -> Entity | None:
        """Find the entity registered at exactly this `drive_path`, or None."""
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")

            cursor = self.conn.execute(
                "SELECT * FROM entities WHERE drive_path = ?", (drive_path,)
            )
            row = cursor.fetchone()
            return self._row_to_entity(row) if row else None

    def get_entity_chain(self, entity_id: int) -> list[Entity]:
        """Get chain from root to entity (for orientation)."""
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")

            chain: list[Entity] = []
            current_id: int | None = entity_id

            while current_id is not None:
                entity = self.get_entity(current_id)
                if entity is None:
                    break
                chain.insert(0, entity)
                current_id = entity.parent_id

            return chain

    def count_children(self, parent_id: int) -> int:
        """Count direct children of an entity."""
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")

            cursor = self.conn.execute(
                "SELECT COUNT(*) FROM entities WHERE parent_id = ?", (parent_id,)
            )
            row = cursor.fetchone()
            return row[0] if row else 0

    def get_workspaces(self) -> list[Entity]:
        """Get all workspace entities (excludes product_repo, reference_repo).

        Order is not guaranteed at the DB layer — display order is the
        service's responsibility (`EntitiesService.get_workspaces`).
        """
        with self._lock:
            if not self.conn:
                raise RuntimeError("Database not initialized")

            cursor = self.conn.execute(
                "SELECT * FROM entities WHERE type = 'workspace'"
            )
            return [self._row_to_entity(row) for row in cursor.fetchall()]

    def _row_to_entity(self, row: sqlite3.Row) -> Entity:
        """Convert database row to Entity."""
        return Entity(
            id=row["id"],
            type=row["type"],
            name=row["name"],
            icon=row["icon"],
            drive_path=row["drive_path"],
            parent_id=row["parent_id"],
            git_url=row["git_url"],
            meta=bool(row["meta"]) if row["meta"] else False,
            ticket_code=row["ticket_code"],
        )
