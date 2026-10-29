"""Read uploaded material files from an S3-compatible bucket or the local uploads folder.

The frontend records where it stored each material:

- `s3://bucket/key`: the S3 bucket (production). The file is downloaded to a temp dir.
- `local://path`: the local uploads folder (no S3 bucket configured: local runs, e2e).
- `gs://bucket/path`: older local uploads, written before the `local://` form. The bucket name
  was never used for them; the path is looked up in the local uploads folder the same way.

Plain filesystem paths are read in place.

Any failure here is a `StorageError`: the file could not be read right now, which says nothing
about the file's content. Callers must not mark a material invalid because of it.
"""
import asyncio
import logging
import os
import shutil
import tempfile
from contextlib import asynccontextmanager
from typing import AsyncIterator, List, Optional, Tuple

from app.config import settings

logger = logging.getLogger(__name__)

FALLBACK_UPLOADS_DIR = "/tmp/margins-uploads"
LOCAL_PREFIX = "local://"
LEGACY_LOCAL_PREFIX = "gs://"


class StorageError(RuntimeError):
    """The file could not be fetched from storage (retryable; not a content problem)."""


def _local_relative_path(storage_path: str) -> str:
    """The path inside the uploads folder of a `local://` or legacy `gs://bucket/` path."""
    if storage_path.startswith(LOCAL_PREFIX):
        relative = storage_path[len(LOCAL_PREFIX):]
    else:
        parts = storage_path[len(LEGACY_LOCAL_PREFIX):].split("/", 1)
        relative = parts[1] if len(parts) == 2 and parts[0] else ""
    if not relative:
        raise StorageError(f"Invalid local storage path: {storage_path}")
    return relative


def _local_candidates(blob_path: str) -> List[str]:
    """Upload folder locations for a blob path, never leaving the upload folder."""
    candidates = []
    for base in (settings.LOCAL_UPLOADS_DIR, FALLBACK_UPLOADS_DIR):
        if not base:
            continue
        root = os.path.realpath(base)
        candidate = os.path.realpath(os.path.join(root, blob_path))
        if os.path.commonpath([root, candidate]) == root:
            candidates.append(candidate)
    return candidates


def _s3_client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.S3_ENDPOINT or None,
        region_name=settings.S3_REGION or "auto",
        aws_access_key_id=settings.S3_ACCESS_KEY_ID or None,
        aws_secret_access_key=settings.S3_SECRET_ACCESS_KEY or None,
        config=Config(
            s3={"addressing_style": "path" if settings.S3_FORCE_PATH_STYLE else "virtual"},
            # Checksums only where S3 requires them: not every S3-compatible store accepts
            # the SDK's default ones.
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


def _download_from_s3(bucket_name: str, key: str) -> Tuple[str, str]:
    """Download one object into a fresh temp dir; returns (file path, temp dir)."""
    temp_dir = tempfile.mkdtemp(prefix="margins-")
    try:
        suffix = os.path.splitext(key)[1]
        local_path = os.path.join(temp_dir, f"material{suffix}")
        _s3_client().download_file(bucket_name, key, local_path)
        return local_path, temp_dir
    except Exception as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise StorageError(f"Could not download s3://{bucket_name}/{key}: {exc}") from exc


def _fetch(storage_path: str) -> Tuple[str, Optional[str]]:
    """(readable local path, temp dir to delete afterwards or None)."""
    if storage_path.startswith("s3://"):
        parts = storage_path[5:].split("/", 1)
        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise StorageError(f"Invalid S3 path format: {storage_path}")
        logger.info("Downloading %s", storage_path)
        return _download_from_s3(parts[0], parts[1])

    if not storage_path.startswith((LOCAL_PREFIX, LEGACY_LOCAL_PREFIX)):
        if os.path.isfile(storage_path):
            return storage_path, None
        raise StorageError(f"File not found: {storage_path}")

    for candidate in _local_candidates(_local_relative_path(storage_path)):
        if os.path.isfile(candidate):
            logger.info("Using local upload %s", candidate)
            return candidate, None

    raise StorageError(f"{storage_path} is not in the local uploads folder")


@asynccontextmanager
async def local_copy(storage_path: str) -> AsyncIterator[str]:
    """Yield a local path for the stored file; downloaded copies are deleted on exit.

    The fetch runs in a worker thread so a slow download never blocks the event loop.
    """
    local_path, temp_dir = await asyncio.to_thread(_fetch, storage_path)
    try:
        yield local_path
    finally:
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)
