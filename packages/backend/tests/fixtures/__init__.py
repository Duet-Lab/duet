"""Test fixtures and factories for backend tests.

This module provides reusable test infrastructure:
- EntityFactory: Create Entity objects with sensible defaults
- DuetDataBuilder: Build DuetData directory structure for tests
- ManifestBuilder: Create workspaces (`context.json` and `INDEX.md` frontmatter)
- write_index_body: Replace the body of a workspace's INDEX.md, keeping its frontmatter
"""

from .entities import EntityFactory
from .filesystem import (
    DuetDataBuilder, HierarchyBuilder, ManifestBuilder, workspace_index, write_index_body,
)

__all__ = ["EntityFactory", "DuetDataBuilder", "ManifestBuilder", "HierarchyBuilder",
           "workspace_index", "write_index_body"]
