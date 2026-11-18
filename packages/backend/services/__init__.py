"""Services of the Duet backend: orientation, the entity registry, tickets, deploy.

Keep this package initializer side-effect free. Scanner imports
``services.manifest``; eager imports of higher-level services from here create
an import cycle (``scanner -> services -> services.entities -> scanner``).
"""

__all__ = ["OrientationService", "EntitiesService"]


def __getattr__(name: str):
    """Lazily expose service classes without import-time cycles."""
    if name == "OrientationService":
        from services.orientation import OrientationService

        return OrientationService
    if name == "EntitiesService":
        from services.entities import EntitiesService

        return EntitiesService
    raise AttributeError(name)
