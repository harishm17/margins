"""Voice transcripts are deleted after VOICE_RETENTION_DAYS and the evidence stays (spec 19.9)."""
import json

import httpx

from app.main import app
from app.services.voice_retention import purge_voice_transcripts
from tests.db_helpers import UTC_NOW, new_id, seed_project, seed_topic, seed_user

OLD = f"{UTC_NOW} - interval '200 days'"
RECENT = f"{UTC_NOW} - interval '10 days'"

HISTORY = [{"role": "user", "content": "hash tables map keys to buckets"}, {"role": "assistant", "content": [{"type": "text", "text": "Good."}]}]
STATE = {
    "turn": 4,
    "said": [{"turn": 3, "text": "keys to buckets"}],
    "quiz": {"askedTurn": 2, "current": 1},
    "teach": {"current": "c1", "askedTurn": 2, "concepts": {"c1": {"assessments": 1, "said": ["keys to buckets"], "gaps": {"g": {"probes": 1, "explained": False}}, "outcome": None}}},
    "guided": {"index": 1, "stage": "taught", "prediction": "something about buckets", "checkQuestion": "q?", "askedTurn": 2},
}


async def seed_session(db, user_id, project_id, topic_id, when):
    session_id = new_id()
    await db.execute(
        f"""
        INSERT INTO voice_drill_sessions (id, user_id, project_id, topic_id, question_set, history, coach_state, created_at, last_seen_at)
        VALUES ($1, $2, $3, $4, '[]'::jsonb, $5::jsonb, $6::jsonb, {when}, {when})
        """,
        session_id, user_id, project_id, topic_id, json.dumps(HISTORY), json.dumps(STATE),
    )
    await db.execute(
        f"""
        INSERT INTO voice_drill_attempts (id, session_id, user_id, topic_id, question_index, question_type, question_text, user_answer, is_correct, score, created_at)
        VALUES ($1, $2, $3, $4, 0, 'conceptual', 'q0', 'keys to buckets', TRUE, 1, {when})
        """,
        new_id(), session_id, user_id, topic_id,
    )
    return session_id


async def seed_recall(db, user_id, topic_id, when, mode="voice"):
    recall_id = new_id()
    result = {"status": "graded", "claims": [{"claim_id": "a", "verdict": "covered", "student_quote": "keys to buckets", "misconception": None, "pointer": None}]}
    await db.execute(
        f"""
        INSERT INTO recall_attempts (id, user_id, topic_id, kind, prompt_text, answer_text, mode, result, created_at)
        VALUES ($1, $2, $3, 'teach_back', 'Explain', 'keys to buckets', $4, $5::jsonb, {when})
        """,
        recall_id, user_id, topic_id, mode, json.dumps(result),
    )
    return recall_id


async def seed_evidence(db, user_id, project_id, topic_id, session_id, when):
    concept_id = new_id()
    await db.execute(
        "INSERT INTO concepts (id, project_id, topic_id, name, summary, kind, order_index) "
        f"VALUES ($1, $2, $3, 'C', 's', 'concept', 0)",
        concept_id, project_id, topic_id,
    )
    event_id = new_id()
    await db.execute(
        "INSERT INTO evidence_events (id, user_id, project_id, topic_id, concept_id, item_key, source, score, assistance, weight, role, graded_by, session_key, created_at) "
        f"VALUES ($1, $2, $3, $4, $5, 'voice:x:0', 'voice', 0.5, 0, 1, 'primary', 'model', $6, {when})",
        event_id, user_id, project_id, topic_id, concept_id, f"voice:{session_id}",
    )
    return event_id


async def world(db):
    user_id = await seed_user(db)
    project_id = await seed_project(db, user_id)
    topic_id = await seed_topic(db, project_id)
    return user_id, project_id, topic_id


async def test_old_transcripts_are_emptied_and_the_rest_stays(db):
    user_id, project_id, topic_id = await world(db)
    old = await seed_session(db, user_id, project_id, topic_id, OLD)
    recent = await seed_session(db, user_id, project_id, topic_id, RECENT)
    old_recall = await seed_recall(db, user_id, topic_id, OLD)
    recent_recall = await seed_recall(db, user_id, topic_id, RECENT)
    typed_recall = await seed_recall(db, user_id, topic_id, OLD, mode="text")

    counts = await purge_voice_transcripts()
    assert counts == {"sessions": 1, "attempts": 1, "recall_attempts": 1}

    row = await db.fetchrow("SELECT history, coach_state, question_set FROM voice_drill_sessions WHERE id = $1", old)
    assert row["history"] is None
    state = json.loads(row["coach_state"])
    assert "said" not in state
    assert state["teach"]["concepts"]["c1"]["said"] == []
    assert state["guided"]["prediction"] == ""
    # What is not a transcript stays: where the session is, the counts and the question.
    assert state["turn"] == 4 and state["quiz"] == {"askedTurn": 2, "current": 1}
    assert state["teach"]["concepts"]["c1"]["gaps"] == {"g": {"probes": 1, "explained": False}}
    assert state["guided"]["checkQuestion"] == "q?" and state["guided"]["index"] == 1
    attempt = await db.fetchrow("SELECT user_answer, is_correct, score FROM voice_drill_attempts WHERE session_id = $1", old)
    assert attempt["user_answer"] == "" and attempt["is_correct"] is True and attempt["score"] == 1

    kept = await db.fetchrow("SELECT history, coach_state FROM voice_drill_sessions WHERE id = $1", recent)
    assert json.loads(kept["history"]) == HISTORY
    assert json.loads(kept["coach_state"]) == STATE
    assert (await db.fetchval("SELECT user_answer FROM voice_drill_attempts WHERE session_id = $1", recent)) == "keys to buckets"

    emptied = await db.fetchrow("SELECT answer_text, result FROM recall_attempts WHERE id = $1", old_recall)
    assert emptied["answer_text"] == ""
    claim = json.loads(emptied["result"])["claims"][0]
    assert claim == {"claim_id": "a", "verdict": "covered", "pointer": None}
    assert (await db.fetchval("SELECT answer_text FROM recall_attempts WHERE id = $1", recent_recall)) == "keys to buckets"
    assert (await db.fetchval("SELECT answer_text FROM recall_attempts WHERE id = $1", typed_recall)) == "keys to buckets"


async def test_a_second_run_touches_nothing(db):
    user_id, project_id, topic_id = await world(db)
    await seed_session(db, user_id, project_id, topic_id, OLD)
    assert (await purge_voice_transcripts())["sessions"] == 1
    assert await purge_voice_transcripts() == {"sessions": 0, "attempts": 0, "recall_attempts": 0}


async def test_a_session_without_a_coach_state_is_emptied_too(db):
    user_id, project_id, topic_id = await world(db)
    session_id = new_id()
    await db.execute(
        f"INSERT INTO voice_drill_sessions (id, user_id, project_id, question_set, history, created_at) VALUES ($1, $2, $3, '[]'::jsonb, $4::jsonb, {OLD})",
        session_id, user_id, project_id, json.dumps(HISTORY),
    )
    assert (await purge_voice_transcripts())["sessions"] == 1
    assert (await db.fetchrow("SELECT history, coach_state FROM voice_drill_sessions WHERE id = $1", session_id))["history"] is None


async def test_zero_days_keeps_everything(db):
    user_id, project_id, topic_id = await world(db)
    session_id = await seed_session(db, user_id, project_id, topic_id, OLD)
    assert await purge_voice_transcripts(0) == {"sessions": 0, "attempts": 0, "recall_attempts": 0}
    assert (await db.fetchval("SELECT history FROM voice_drill_sessions WHERE id = $1", session_id)) is not None


async def test_the_endpoint_runs_the_purge(db):
    user_id, project_id, topic_id = await world(db)
    await seed_session(db, user_id, project_id, topic_id, OLD)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/voice/retention")
    assert response.status_code == 200
    assert response.json()["sessions"] == 1


async def test_evidence_events_stay(db):
    user_id, project_id, topic_id = await world(db)
    session_id = await seed_session(db, user_id, project_id, topic_id, OLD)
    event_id = await seed_evidence(db, user_id, project_id, topic_id, session_id, OLD)
    assert (await purge_voice_transcripts())["sessions"] == 1
    event = await db.fetchrow("SELECT score, source, session_key FROM evidence_events WHERE id = $1", event_id)
    assert event["score"] == 0.5 and event["source"] == "voice" and event["session_key"] == f"voice:{session_id}"
