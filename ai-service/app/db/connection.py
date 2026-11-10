"""Database connection utilities.

Prisma stores DateTime columns as `timestamp(3) without time zone` holding UTC. SQL written
here must produce UTC too: use `UTC_NOW` instead of a plain now call, which would give the database
server's local time.
"""
import asyncio
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import asyncpg
from app.config import settings

# Query parameters that belong to Prisma's connection string, not to Postgres. The web app and this
# service usually share one DATABASE_URL, and asyncpg rejects them ("unrecognized configuration
# parameter \"schema\"").
_PRISMA_ONLY_PARAMS = frozenset({"schema", "connection_limit", "pool_timeout", "pgbouncer", "socket_timeout"})


def asyncpg_dsn(url: str) -> str:
    """The URL with the Prisma-only query parameters removed; everything else is kept as it is."""
    parts = urlsplit(url)
    if not parts.query:
        return url
    kept = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key not in _PRISMA_ONLY_PARAMS]
    return urlunsplit(parts._replace(query=urlencode(kept)))

# Current UTC time as a plain timestamp, the way Prisma writes it.
UTC_NOW = "(NOW() AT TIME ZONE 'UTC')"

_pool: asyncpg.Pool | None = None
_pool_lock = asyncio.Lock()


def _with_acquire_timeout(pool: asyncpg.Pool) -> asyncpg.Pool:
    """Make every `pool.acquire()` (and so every `pool.fetch`, `pool.execute` and the like, which acquire through it)
    give up after DB_ACQUIRE_TIMEOUT_SECONDS instead of waiting for a free connection for ever. An explicit
    `timeout=` still wins."""
    acquire = pool.acquire

    def acquire_with_timeout(*, timeout=None):
        return acquire(timeout=settings.DB_ACQUIRE_TIMEOUT_SECONDS if timeout is None else timeout)

    pool.acquire = acquire_with_timeout  # type: ignore[method-assign]
    return pool


async def get_db_pool() -> asyncpg.Pool:
    """Get or create database connection pool."""
    global _pool

    if _pool is None:
        async with _pool_lock:
            if _pool is None:
                _pool = _with_acquire_timeout(await asyncpg.create_pool(
                    asyncpg_dsn(settings.DATABASE_URL),
                    min_size=2,
                    max_size=settings.DB_POOL_MAX_SIZE,
                    command_timeout=settings.DB_COMMAND_TIMEOUT_SECONDS,
                    # So a bare now call or a timestamptz comparison is UTC as well.
                    server_settings={"timezone": "UTC"},
                ))

    return _pool


async def close_db_pool():
    """Close database connection pool."""
    global _pool, _pool_lock

    if _pool is not None:
        await _pool.close()
        _pool = None
    # A lock that has waited is tied to that event loop; start fresh for the next one.
    _pool_lock = asyncio.Lock()


async def execute_query(query: str, *args):
    """Execute a database query."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        return await conn.fetch(query, *args)


async def execute_one(query: str, *args):
    """Execute a query and return one result."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        return await conn.fetchrow(query, *args)


async def execute_update(query: str, *args):
    """Execute an update/insert query."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        return await conn.execute(query, *args)


async def execute_in_transaction(operations):
    """
    Execute multiple database operations in a transaction.

    Args:
        operations: Async function that takes a connection and performs operations

    Returns:
        Result of the operations function

    Example:
        async def insert_chunks(conn):
            for chunk in chunks:
                await conn.execute("INSERT INTO ...", ...)
            return len(chunks)

        result = await execute_in_transaction(insert_chunks)
    """
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            return await operations(conn)
