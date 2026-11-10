"""The AI service's SQL matches the schema the web app's migrations build (OPS-H3).

The two services share one database, and the migrations live in the web app. A column renamed or dropped there used
to break this service only at run time, on the first request that reached that query. Here every SQL statement in
app/ (tests/sql_inventory.py) is prepared against a database built from the migrations: Postgres resolves every
table, column and type when it prepares, without running anything, so a stale name fails this test instead.
"""
import asyncpg
import pytest

from tests.sql_inventory import statements

# Error classes that mean the code names something the schema does not have.
SCHEMA_ERRORS = {
    "42703": "undefined column",
    "42P01": "undefined table",
    "42704": "undefined object",
    "42883": "undefined function",
}
# Statements whose text is only known at run time. Raising this needs a reason in the PR; lowering it is always fine.
MAX_UNRESOLVED = 3
# A floor so a broken inventory (nothing found) cannot pass by checking nothing.
MIN_CHECKED = 170


@pytest.fixture(scope="module")
def inventory():
    return statements()


async def test_every_statement_names_only_what_the_migrations_create(test_database_url, inventory):
    conn = await asyncpg.connect(test_database_url)
    failures, checked = [], 0
    try:
        for statement in inventory:
            if statement.sql is None:
                continue
            checked += 1
            tx = conn.transaction()
            await tx.start()
            try:
                await conn.prepare(statement.sql)
            except asyncpg.PostgresError as exc:
                code = getattr(exc, "sqlstate", "")
                if code in SCHEMA_ERRORS:
                    failures.append(f"{statement.where}: {SCHEMA_ERRORS[code]}: {exc}")
                elif code.startswith("42"):
                    failures.append(f"{statement.where}: {code}: {exc}")
            finally:
                await tx.rollback()
    finally:
        await conn.close()
    assert not failures, "SQL that does not match the migrated schema:\n" + "\n".join(failures)
    assert checked >= MIN_CHECKED, f"Only {checked} statements checked; the inventory is missing some"


def test_unresolved_statements_stay_few(inventory):
    unresolved = [f"{s.where} ({s.unresolved})" for s in inventory if s.sql is None]
    assert len(unresolved) <= MAX_UNRESOLVED, "Statements that cannot be checked statically:\n" + "\n".join(unresolved)


def test_a_renamed_column_would_fail(test_database_url):
    """The check catches what it is for: a column the schema does not have."""
    import asyncio

    async def run():
        conn = await asyncpg.connect(test_database_url)
        try:
            with pytest.raises(asyncpg.UndefinedColumnError):
                await conn.prepare("SELECT no_such_column FROM ops_state")
        finally:
            await conn.close()

    asyncio.run(run())
