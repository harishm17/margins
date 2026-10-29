"""Account deletion and the spend ledger, in the database itself (migration
20261121000000_account_deletion): the web app deletes an account with delete_user_account(), and
every writer of llm_usage_events (the web app's chat route, this service's jobs and voice turns)
goes through the same trigger. Spend recorded for a deleted account is kept, unlinked, so it still
counts toward the global daily cap, and nothing can be written for the account between the
unlinking and the delete."""
import asyncio

import asyncpg
import pytest

from app.services.budget import global_spent_today_usd, record_usage_event
from tests.db_helpers import new_id, seed_project, seed_usage, seed_user

pytestmark = pytest.mark.asyncio

INSERT = """
    INSERT INTO llm_usage_events (id, user_id, project_id, source, source_id, cost_usd)
    VALUES ($1, $2, $3, 'chat', $4, 0.5)
"""


async def ledger_row(db, event_id):
    return dict(await db.fetchrow(
        "SELECT user_id, project_id, source_id, cost_usd::float8 AS cost FROM llm_usage_events WHERE id = $1",
        event_id,
    ))


UNLINKED = {"user_id": None, "project_id": None, "source_id": ""}


async def test_delete_user_account_unlinks_the_ledger_and_deletes_the_account(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    event_id = await seed_usage(db, user_id, 1.25, project_id=project_id)

    assert await db.fetchval("SELECT delete_user_account($1)", user_id) is True
    assert await db.fetchval("SELECT count(*) FROM users WHERE id = $1", user_id) == 0
    assert await db.fetchval("SELECT count(*) FROM projects WHERE id = $1", project_id) == 0
    assert await ledger_row(db, event_id) == {**UNLINKED, "cost": 1.25}
    assert await global_spent_today_usd() == pytest.approx(1.25)
    # Again: the account is already gone.
    assert await db.fetchval("SELECT delete_user_account($1)", user_id) is False


async def test_spend_for_a_deleted_account_is_kept_unlinked_by_any_writer(db):
    # The web app's chat route writes the ledger with a plain INSERT (Prisma): a billed failure that
    # lands after the account was deleted is kept, not refused by the foreign key.
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    await db.fetchval("SELECT delete_user_account($1)", user_id)

    event_id = new_id()
    await db.execute(INSERT, event_id, user_id, project_id, "message-1")
    assert await ledger_row(db, event_id) == {**UNLINKED, "cost": 0.5}

    # The same for this service's jobs and voice turns.
    await record_usage_event(user_id=user_id, project_id=project_id, source="voice", source_id="s1",
                             models="m", input_tokens=1, output_tokens=1, cost_usd=0.25)
    assert await global_spent_today_usd() == pytest.approx(0.75)
    assert await db.fetchval("SELECT count(*) FROM llm_usage_events WHERE user_id IS NOT NULL") == 0


async def test_spend_of_a_live_account_keeps_its_ids(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    event_id = new_id()
    await db.execute(INSERT, event_id, user_id, project_id, "message-1")
    assert await ledger_row(db, event_id) == {"user_id": user_id, "project_id": project_id,
                                              "source_id": "message-1", "cost": 0.5}


class TestConcurrentSpend:
    """Two connections: the deletion and a usage insert for the same account at the same time."""

    @pytest.fixture
    async def conns(self, db, test_database_url):
        deleter = await asyncpg.connect(test_database_url)
        writer = await asyncpg.connect(test_database_url)
        yield deleter, writer
        await deleter.close()
        await writer.close()

    async def test_an_insert_during_the_deletion_waits_and_is_kept_unlinked(self, db, conns):
        deleter, writer = conns
        user_id = await seed_user(db)
        project_id = await seed_project(db, user_id)

        tx = deleter.transaction()
        await tx.start()
        assert await deleter.fetchval("SELECT delete_user_account($1)", user_id) is True

        event_id = new_id()
        insert = asyncio.create_task(writer.execute(INSERT, event_id, user_id, project_id, "job-late"))
        await asyncio.sleep(0.3)
        assert not insert.done(), "the insert must wait for the deletion to finish"

        await tx.commit()
        await asyncio.wait_for(insert, 5)
        assert await ledger_row(db, event_id) == {**UNLINKED, "cost": 0.5}

    async def test_a_deletion_during_an_open_insert_waits_and_unlinks_it(self, db, conns):
        deleter, writer = conns
        user_id = await seed_user(db)
        project_id = await seed_project(db, user_id)

        tx = writer.transaction()
        await tx.start()
        event_id = new_id()
        await writer.execute(INSERT, event_id, user_id, project_id, "job-early")

        deletion = asyncio.create_task(deleter.fetchval("SELECT delete_user_account($1)", user_id))
        await asyncio.sleep(0.3)
        assert not deletion.done(), "the deletion must wait for the insert's transaction"

        await tx.commit()
        assert await asyncio.wait_for(deletion, 5) is True
        assert await ledger_row(db, event_id) == {**UNLINKED, "cost": 0.5}
