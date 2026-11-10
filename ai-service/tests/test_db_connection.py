import pytest

from app.db.connection import asyncpg_dsn


@pytest.mark.parametrize(
    "url, expected",
    [
        ("postgresql://dev:devpass@localhost:5432/margins?schema=public", "postgresql://dev:devpass@localhost:5432/margins"),
        (
            "postgresql://dev:devpass@db:5432/margins?sslmode=require&schema=public&connection_limit=5",
            "postgresql://dev:devpass@db:5432/margins?sslmode=require",
        ),
        ("postgresql://dev:devpass@localhost:5432/margins", "postgresql://dev:devpass@localhost:5432/margins"),
    ],
    ids=["prisma_only", "other_parameters_kept", "plain_url"],
)
def test_prisma_only_parameters_are_removed(url, expected):
    assert asyncpg_dsn(url) == expected
