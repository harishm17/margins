"""Who owns what: the one check every id the AI service is handed goes through (SEC-L1).

The web app names a user and the ids of the things a call is about. An id alone says nothing about whose it is, so before a
route or a job reads or writes by an id, `assert_owns` asks the database, in one query, whether each id given belongs to
that user. A missing row and another user's row are the same answer, so the 404 does not say which ids exist.

    await assert_owns(user_id, project_id=..., topic_id=...)   # raises NotOwnedError (a 404) unless both are the user's

When both a project and something inside a project are given, the thing must be inside that project.
"""
from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

from app.db.connection import execute_one
from app.errors import public_message


class NotOwnedError(HTTPException):
    """The user does not own one of the ids. A 404 on a route; a job fails permanently (see `assert_job_owns`)."""

    def __init__(self) -> None:
        super().__init__(status_code=404, detail=public_message("NOT_FOUND"))


# One test per kind of id: "@USER" is the user, "@ID" the id, "@PROJ" the project when the call also names one. Each tests that
# the row exists, belongs to the user (through its course where it has no user of its own) and, if a project is
# given, lies inside it. The strings are fixed here; only the parameters vary.
_PROJECT_MATCH = "(@PROJ::text IS NULL OR {alias}.project_id = @PROJ)"

_TESTS = {
    "project_id": "EXISTS (SELECT 1 FROM projects p WHERE p.id = @ID AND p.user_id = @USER AND (@PROJ::text IS NULL OR p.id = @PROJ))",
    "topic_id": (
        "EXISTS (SELECT 1 FROM topics x JOIN projects p ON p.id = x.project_id "
        "WHERE x.id = @ID AND p.user_id = @USER AND " + _PROJECT_MATCH.format(alias="x") + ")"
    ),
    "unit_id": (
        "EXISTS (SELECT 1 FROM units x JOIN projects p ON p.id = x.project_id "
        "WHERE x.id = @ID AND p.user_id = @USER AND " + _PROJECT_MATCH.format(alias="x") + ")"
    ),
    "material_id": (
        "EXISTS (SELECT 1 FROM materials x JOIN projects p ON p.id = x.project_id "
        "WHERE x.id = @ID AND p.user_id = @USER AND " + _PROJECT_MATCH.format(alias="x") + ")"
    ),
    "exam_id": (
        "EXISTS (SELECT 1 FROM sample_exams x JOIN projects p ON p.id = x.project_id "
        "WHERE x.id = @ID AND p.user_id = @USER AND " + _PROJECT_MATCH.format(alias="x") + ")"
    ),
    "session_id": (
        "EXISTS (SELECT 1 FROM voice_drill_sessions x "
        "WHERE x.id = @ID AND x.user_id = @USER AND " + _PROJECT_MATCH.format(alias="x") + ")"
    ),
    "attempt_id": (
        "EXISTS (SELECT 1 FROM recall_attempts x JOIN topics t ON t.id = x.topic_id "
        "WHERE x.id = @ID AND x.user_id = @USER AND (@PROJ::text IS NULL OR t.project_id = @PROJ))"
    ),
    # An exam submission or a quiz submission: the ids never collide.
    "submission_id": (
        "(EXISTS (SELECT 1 FROM exam_submissions x JOIN sample_exams e ON e.id = x.sample_exam_id "
        "WHERE x.id = @ID AND x.user_id = @USER AND (@PROJ::text IS NULL OR e.project_id = @PROJ)) "
        "OR EXISTS (SELECT 1 FROM quiz_submissions x JOIN topics t ON t.id = x.topic_id "
        "WHERE x.id = @ID AND x.user_id = @USER AND (@PROJ::text IS NULL OR t.project_id = @PROJ)))"
    ),
}

_KINDS = tuple(_TESTS)


async def assert_owns(
    user_id: str,
    *,
    project_id: Optional[str] = None,
    topic_id: Optional[str] = None,
    unit_id: Optional[str] = None,
    material_id: Optional[str] = None,
    exam_id: Optional[str] = None,
    session_id: Optional[str] = None,
    attempt_id: Optional[str] = None,
    submission_id: Optional[str] = None,
) -> None:
    """Raise NotOwnedError (404) unless every id given belongs to `user_id`. Ids left as None are not checked."""
    given = {
        "project_id": project_id,
        "topic_id": topic_id,
        "unit_id": unit_id,
        "material_id": material_id,
        "exam_id": exam_id,
        "session_id": session_id,
        "attempt_id": attempt_id,
        "submission_id": submission_id,
    }
    wanted = [(kind, value) for kind, value in given.items() if value is not None]
    if not user_id or not wanted:
        raise NotOwnedError()
    # Every check in one statement: @USER is the user, then each id, then (last) the project the others must lie in.
    checks = []
    args: list = [user_id]
    project_slot = len(wanted) + 2
    for kind, value in wanted:
        args.append(value)
        test = _TESTS[kind].replace("@USER", "$1").replace("@ID", f"${len(args)}").replace("@PROJ", f"${project_slot}")
        checks.append(test)
    args.append(project_id)
    row = await execute_one("SELECT " + " AND ".join(checks) + " AS owned", *args)
    if row is None or not row["owned"]:
        raise NotOwnedError()

