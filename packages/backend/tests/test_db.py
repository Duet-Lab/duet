"""Tests for db.py - SQLite database manager."""

import pytest

from db import DatabaseManager
from tests.fixtures import EntityFactory


class TestDatabaseManager:
    """Tests for DatabaseManager class."""

    def test_init_creates_schema(self, db) -> None:
        """Database initialization creates the entities table."""
        entities = db.get_all_entities()
        assert entities == []

    def test_insert_entity(self, db) -> None:
        """Can insert an entity and get its ID."""
        entity_id = EntityFactory.insert_workspace(db, "Root", "/path/to/root")
        assert entity_id == 1

    def test_insert_entity_idempotent(self, db) -> None:
        """Inserting same entity twice returns same ID."""
        entity = EntityFactory.workspace("Root", "/path/to/root")
        id1 = db.insert_entity(entity)
        id2 = db.insert_entity(entity)
        assert id1 == id2

    def test_ticket_code_round_trips(self, db) -> None:
        """`ticket_code` keeps `ticket-code` as written: a code, `inherit`, or None."""
        EntityFactory.insert_workspace(db, "Lab", "/lab", ticket_code="LAB")
        EntityFactory.insert_workspace(db, "Desk", "/lab/desk", ticket_code="inherit")
        EntityFactory.insert_workspace(db, "Plain", "/plain")
        assert {e.name: e.ticket_code for e in db.get_workspaces()} == {
            "Lab": "LAB", "Desk": "inherit", "Plain": None}

    def test_rows_of_the_old_type_are_read_as_workspaces(self, tmp_path) -> None:
        """A database written before DUE063 called a workspace `context`."""
        import sqlite3
        path = tmp_path / "old.db"
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, "
                     "name TEXT, icon TEXT, drive_path TEXT UNIQUE, parent_id INTEGER, "
                     "git_url TEXT, meta INTEGER DEFAULT 0)")
        conn.execute("INSERT INTO entities (type, name, icon, drive_path) "
                     "VALUES ('context', 'Lab', '📁', 'Lab')")
        conn.commit()
        conn.close()
        manager = DatabaseManager(path)
        manager.init()
        [lab] = manager.get_workspaces()
        assert (lab.type, lab.ticket_code) == ("workspace", None)
        manager.close()

    def test_find_by_name(self, db) -> None:
        """Can find entity by globally unique name."""
        EntityFactory.insert_workspace(db, "UniqueProduct", "/path/product",
                                      git_url="https://example.com/p.git")

        found = db.find_by_name("UniqueProduct")
        assert found is not None
        assert found.name == "UniqueProduct"
        assert found.type == "workspace"
        assert found.git_url == "https://example.com/p.git"

        not_found = db.find_by_name("NonExistent")
        assert not_found is None

    def test_name_exists(self, db) -> None:
        EntityFactory.insert_workspace(db, "ExistingName", "/path")

        assert db.name_exists("ExistingName") is True
        assert db.name_exists("NonExistent") is False

    def test_update_entity_name(self, db) -> None:
        entity_id = EntityFactory.insert_workspace(db, "OldName", "/path")

        db.update_entity_name(entity_id, "NewName")

        updated = db.get_entity(entity_id)
        assert updated is not None
        assert updated.name == "NewName"

    def test_clear(self, db) -> None:
        EntityFactory.insert_workspace(db, "ToBeDeleted", "/path")
        assert len(db.get_all_entities()) == 1

        db.clear()
        assert len(db.get_all_entities()) == 0

    def test_find_by_drive_path_is_exact(self, db) -> None:
        """Only the entity registered at that very path; no nearest-ancestor match."""
        root_id = EntityFactory.insert_workspace(db, "Root", "Root")
        EntityFactory.insert_workspace(db, "Alpha", "Root/Alpha", parent_id=root_id)

        assert db.find_by_drive_path("Root/Alpha").name == "Alpha"
        assert db.find_by_drive_path("Root").name == "Root"
        assert db.find_by_drive_path("Root/Alpha/sub") is None
        assert db.find_by_drive_path("Root/AlphaBeta") is None

    def test_get_entity_chain(self, db) -> None:
        """Can get chain from root to entity."""
        ids = EntityFactory.insert_hierarchy(db, "/base")

        chain = db.get_entity_chain(ids["product"])
        assert len(chain) == 3
        assert chain[0].name == "Root"
        assert chain[1].name == "Mid"
        assert chain[2].name == "Product"

    def test_has_children(self, db) -> None:
        parent_id = EntityFactory.insert_workspace(db, "Parent", "/parent")

        assert db.has_children(parent_id) is False

        EntityFactory.insert_workspace(db, "Child", "/parent/child", parent_id=parent_id)

        assert db.has_children(parent_id) is True

    def test_get_workspaces_returns_only_workspaces(self, db) -> None:
        """get_workspaces() returns workspace entities, excludes product_repo and reference_repo."""
        from db import Entity

        root_id = EntityFactory.insert_workspace(db, "Root", "/root")
        product_id = EntityFactory.insert_workspace(
            db, "Product", "/root/product",
            parent_id=root_id, git_url="https://example.com/p.git",
        )
        # Insert a product_repo entity directly
        db.insert_entity(Entity(
            id=None, type="product_repo", name="Product.git",
            icon="📂", drive_path="Product.git",
            parent_id=product_id, git_url="https://example.com/p.git",
        ))

        workspaces = db.get_workspaces()
        types = {e.type for e in workspaces}
        assert types == {"workspace"}
        assert {e.name for e in workspaces} == {"Root", "Product"}
