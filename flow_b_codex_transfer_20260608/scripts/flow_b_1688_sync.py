#!/usr/bin/env python3
"""Synchronous-only entry point for the existing 1688 cost estimator.

The third-party ``search1688api`` package imports its aiohttp implementation
from ``__init__`` even when only ``Sync1688Session`` is used. On this runtime
that import can stall before a request is sent. Load only ``sync_session.py``
while preserving the package-relative ``utils`` import, then delegate every
cost and matching decision to ``1688_image_median.py`` unchanged.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


IMPLEMENTATION_PATH = Path(__file__).with_name("1688_image_median.py")
_implementation_spec = importlib.util.spec_from_file_location(
    "flow_b_1688_image_median_sync_entry",
    IMPLEMENTATION_PATH,
)
if _implementation_spec is None or _implementation_spec.loader is None:
    raise RuntimeError(f"Unable to load 1688 implementation: {IMPLEMENTATION_PATH}")
_implementation = importlib.util.module_from_spec(_implementation_spec)
_implementation_spec.loader.exec_module(_implementation)

normalize_image = _implementation.normalize_image
summarize_products = _implementation.summarize_products
first_page_p70_cost = _implementation.first_page_p70_cost


def load_sync_session_class(package_dir: Path | str | None = None):
    if package_dir is None:
        package_spec = importlib.util.find_spec("search1688api")
        locations = list(package_spec.submodule_search_locations or []) if package_spec else []
        if not locations:
            raise ModuleNotFoundError("search1688api package directory was not found")
        package_root = Path(locations[0]).resolve()
    else:
        package_root = Path(package_dir).expanduser().resolve()

    sync_path = package_root / "sync_session.py"
    if not sync_path.is_file():
        raise ModuleNotFoundError(f"search1688api sync_session.py was not found: {sync_path}")

    package_name = f"_flow_b_search1688api_sync_{abs(hash(str(package_root)))}"
    module_name = f"{package_name}.sync_session"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing.Sync1688Session

    package = types.ModuleType(package_name)
    package.__path__ = [str(package_root)]
    package.__package__ = package_name
    sys.modules[package_name] = package

    sync_spec = importlib.util.spec_from_file_location(module_name, sync_path)
    if sync_spec is None or sync_spec.loader is None:
        raise RuntimeError(f"Unable to load synchronous 1688 session: {sync_path}")
    sync_module = importlib.util.module_from_spec(sync_spec)
    sys.modules[module_name] = sync_module
    try:
        sync_spec.loader.exec_module(sync_module)
    except Exception:
        sys.modules.pop(module_name, None)
        sys.modules.pop(package_name, None)
        raise
    return sync_module.Sync1688Session


def load_session():
    try:
        session_class = load_sync_session_class()
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing dependency `search1688api`. Install with:\n"
            "python3 -m pip install search1688api requests beautifulsoup4 lxml"
        ) from exc
    return session_class(debug=False)


def main() -> int:
    _implementation.load_session = load_session
    return _implementation.main()


if __name__ == "__main__":
    raise SystemExit(main())
