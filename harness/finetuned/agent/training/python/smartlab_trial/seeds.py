"""Versioned harness-owned seed derivation."""
from __future__ import annotations

import hashlib
import json
from typing import Sequence


def _derive_seed(domain: str, components: Sequence[object]) -> int:
    """Match the persisted TypeScript seed plan's domain-separated derivation."""
    material = json.dumps({
        "namespace": "auto-smart-lab.seed",
        "version": 1,
        "derivation": "sha256-domain-separated-uint32-v1",
        "domain": domain,
        "components": list(components),
    }, separators=(",", ":")).encode("utf-8")
    return int.from_bytes(hashlib.sha256(material).digest()[:4], "big")
