"""Object storage for exports (services/fiscal-worker/src/storage.ts).

LocalDirStorage writes to a directory (mount a volume / NFS / s3fs in production); an
S3/MinIO or Azure Blob implementation only needs put().
"""

from __future__ import annotations

import os
from typing import Protocol


class ObjectStorage(Protocol):
    def put(self, key: str, body: str | bytes, content_type: str) -> dict[str, str]: ...


class LocalDirStorage:
    def __init__(self, directory: str) -> None:
        self.root = os.path.abspath(directory)

    def put(self, key: str, body: str | bytes, content_type: str = "application/octet-stream") -> dict[str, str]:
        path = os.path.abspath(os.path.join(self.root, key))
        if not path.startswith(self.root + os.sep):
            raise ValueError(f"Invalid storage key: {key}")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:  # binary: CSV keeps its \r\n line endings on every OS
            f.write(body.encode("utf-8") if isinstance(body, str) else body)
        return {"uri": "file://" + path.replace("\\", "/")}
