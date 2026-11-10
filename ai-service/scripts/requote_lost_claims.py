"""One-off repair: give concepts that already lost every claim new ones, in topics that still have sources (F0, 89).

An earlier Delete or Replace of a file removed the claims whose quotes came from it and left the concepts. The
`requote_concepts` job does this for the future; this script does it for the concepts already in that state, with the
same code (app/services/concepts/requote.py): the model is asked for quotes for the concepts that exist, ids kept, and
every quote is checked against the chunk it names before anything is written.

    cd ai-service && uv run python scripts/requote_lost_claims.py [--topic TOPIC_ID | --project PROJECT_ID]
        1. (default) lists the topics and concepts affected and an estimate of the cost. No model call.
        2. --yes     calls the model, prints the quotes it would add. Writes nothing.
        3. --yes --write   calls the model and writes the quotes, once (a concept that has claims by then is skipped).

The model calls spend money (the estimate is printed first), so nothing is called without --yes. They are made outside
any account's allowance: this is an operator run. Needs DATABASE_URL, the model settings of the environment it should
look at (ANTHROPIC_API_KEY, or LLM_PROVIDER=mock to try it on a development database), and ENVIRONMENT.
"""
import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db.connection import close_db_pool, execute_query  # noqa: E402
from app.services.billing import unbilled  # noqa: E402
from app.services.concepts.requote import estimate_prompt_tokens, propose_quotes  # noqa: E402
from app.services.concepts.store import store_requoted_claims  # noqa: E402
from app.services.llm.base import LLMUsage  # noqa: E402
from app.services.llm.models import resolve_model  # noqa: E402
from app.services.llm.usage import estimate_cost_usd  # noqa: E402

OUTPUT_TOKENS_PER_CONCEPT = 500  # about 3 claims with their quotes


async def affected_topics(topic_id: str | None, project_id: str | None) -> list[dict]:
    """Topics that have a source and concepts with no claim: (topic id, name, project id, concept names)."""
    rows = await execute_query(
        """
        SELECT t.id, t.name, t.project_id, array_agg(c.name ORDER BY c.order_index) AS concepts
        FROM concepts c
        JOIN topics t ON t.id = c.topic_id
        WHERE c.status = 'active' AND c.origin = 'llm'
          AND NOT EXISTS (SELECT 1 FROM concept_claims k WHERE k.concept_id = c.id)
          AND EXISTS (SELECT 1 FROM topic_sources s WHERE s.topic_id = t.id)
          AND ($1::text IS NULL OR t.id = $1) AND ($2::text IS NULL OR t.project_id = $2)
        GROUP BY t.id, t.name, t.project_id
        ORDER BY t.project_id, t.id
        """,
        topic_id,
        project_id,
    )
    return [dict(row) for row in rows]


async def main(args: argparse.Namespace) -> int:
    if args.write and not args.yes:
        print("--write needs --yes: it calls the model, which costs money.")
        return 2
    topics = await affected_topics(args.topic, args.project)
    if not topics:
        print("No topic with sources has concepts that lack claims.")
        return 0

    model = resolve_model("requote_concepts").model
    input_tokens = 0
    concept_count = 0
    for topic in topics:
        concept_count += len(topic["concepts"])
        input_tokens += await estimate_prompt_tokens(topic["id"])
        print(f"topic {topic['id']} ({topic['name']}), course {topic['project_id']}: {', '.join(topic['concepts'])}")
    estimate = estimate_cost_usd(
        LLMUsage(model=model, input_tokens=input_tokens, output_tokens=concept_count * OUTPUT_TOKENS_PER_CONCEPT)
    )
    print(f"\n{concept_count} concepts in {len(topics)} topics. One model call per topic on {model}: about ${estimate:.2f}.")
    if not args.yes:
        print("No model call made. Re-run with --yes to spend that and print the quotes; add --write to store them.")
        return 0

    written = 0
    with unbilled("requote_lost_claims repair script"):
        for topic in topics:
            plan = await propose_quotes(topic["id"])
            names = {concept["id"]: concept["name"] for concept in plan.concepts}
            print(f"\ntopic {topic['id']} ({topic['name']}): {len(plan.claims)} quotes, {plan.dropped_claims} dropped"
                  + (f" ({plan.skipped})" if plan.skipped else ""))
            for claim in plan.claims:
                print(f"  {names[claim.concept_key]}: \"{claim.quote}\" (chunk {claim.chunk_id})")
            missing = [name for cid, name in names.items() if not any(c.concept_key == cid for c in plan.claims)]
            if missing:
                print(f"  still without claims: {', '.join(missing)}")
            if args.write and plan.claims:
                done = await store_requoted_claims(topic["id"], plan.claims)
                written += sum(done.values())
    print(f"\nWrote {written} claims." if args.write else "\nNothing was written (no --write).")
    await close_db_pool()
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--topic", help="only this topic id")
    parser.add_argument("--project", help="only the topics of this course")
    parser.add_argument("--yes", action="store_true", help="call the model (spends the estimated cost)")
    parser.add_argument("--write", action="store_true", help="store the quotes found (needs --yes)")
    sys.exit(asyncio.run(main(parser.parse_args())))
