"""Deterministically partition collected EEST tests across independent chains."""

import hashlib
import os

import pytest


def shard_for_nodeid(nodeid: str, shard_count: int) -> int:
    """Return the stable shard index assigned to a pytest node ID."""
    digest = hashlib.sha256(nodeid.encode()).digest()
    return int.from_bytes(digest[:8], byteorder="big") % shard_count


def shard_configuration() -> tuple[int, int]:
    """Read and validate the shard configuration from the environment."""
    try:
        shard_count = int(os.environ.get("EEST_SHARD_COUNT", "1"))
        shard_index = int(os.environ.get("EEST_SHARD_INDEX", "0"))
    except ValueError as error:
        raise pytest.UsageError(
            "EEST_SHARD_COUNT and EEST_SHARD_INDEX must be integers."
        ) from error

    if shard_count < 1:
        raise pytest.UsageError("EEST_SHARD_COUNT must be positive.")
    if not 0 <= shard_index < shard_count:
        raise pytest.UsageError(
            "EEST_SHARD_INDEX must be between 0 and EEST_SHARD_COUNT - 1."
        )
    return shard_count, shard_index


def pytest_report_header() -> str | None:
    """Show the active shard in pytest's report header."""
    shard_count, shard_index = shard_configuration()
    if shard_count == 1:
        return None
    return f"EEST chain shard {shard_index + 1}/{shard_count}"


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(
    config: pytest.Config,
    items: list[pytest.Item],
) -> None:
    """Keep only tests assigned to this chain shard."""
    shard_count, shard_index = shard_configuration()
    if shard_count == 1:
        return

    selected = []
    deselected = []
    for item in items:
        destination = shard_for_nodeid(item.nodeid, shard_count)
        (selected if destination == shard_index else deselected).append(item)

    config.hook.pytest_deselected(items=deselected)
    items[:] = selected
