"""List stored PDFs that have pages the markdown read drops but the page's own text layer holds (finding 104).

A dry run only. It reads each stored PDF the way the service does (through `local_copy` and `parse_document`, which
runs the parser in the limited child process) and prints the material id, filename and the page numbers that are now
read from the text layer. It writes nothing: not to the database, not to the bucket, and it does not re-read or
rewrite any chunk. A file's chunks are replaced only by the re-read that waits for PR 3, because new chunk ids would
orphan the notes and claims on the old ones.

    cd ai-service && uv run python scripts/list_text_layer_pages.py [--project PROJECT_ID] [--limit N]

Needs DATABASE_URL and the storage settings (S3_*, LOCAL_UPLOADS_DIR) of the environment it should look at.
"""
import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import asyncpg  # noqa: E402

from app.config import settings  # noqa: E402
from app.db.connection import asyncpg_dsn  # noqa: E402
from app.services.document_processor.parse_types import ParseRefused, UnreadableDocumentError  # noqa: E402
from app.services.document_processor.sandbox import parse_document  # noqa: E402
from app.services.document_processor.storage import StorageError, local_copy  # noqa: E402


async def main(project_id: str | None, limit: int | None) -> None:
    conn = await asyncpg.connect(asyncpg_dsn(settings.DATABASE_URL))
    try:
        rows = await conn.fetch(
            "SELECT id, filename, gcs_path FROM materials "
            "WHERE lower(filename) LIKE '%.pdf' AND ($1::text IS NULL OR project_id = $1) "
            "ORDER BY id LIMIT $2",
            project_id,
            limit if limit is not None else 1_000_000,
        )
    finally:
        await conn.close()

    affected = 0
    unreadable = 0
    for row in rows:
        try:
            async with local_copy(row["gcs_path"]) as path:
                extracted = await parse_document(path, row["filename"], markdown=True)
        except (StorageError, ParseRefused, UnreadableDocumentError) as exc:
            unreadable += 1
            print(f"skipped {row['id']} {row['filename']}: {type(exc).__name__}")
            continue
        pages = [page.number for page in extracted.pages if page.from_text_layer]
        if pages:
            affected += 1
            print(f"{row['id']}\t{row['filename']}\tpages {', '.join(str(p) for p in pages)}")
    print(f"{affected} of {len(rows)} PDFs have such pages ({unreadable} could not be read). Nothing was written.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", help="only the PDFs of this project id")
    parser.add_argument("--limit", type=int, help="read at most this many PDFs")
    args = parser.parse_args()
    asyncio.run(main(args.project, args.limit))
