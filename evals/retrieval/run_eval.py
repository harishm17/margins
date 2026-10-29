"""Retrieval eval for Margins topic-to-chunk mapping.

    cd ai-service
    uv run python -I ../evals/retrieval/run_eval.py --db postgresql://postgres@127.0.0.1:5544/sb_evals --label baseline

What it does:
  1. Ingests the corpus (see corpus.json, fetch_corpus.py) through the real chunker and the
     real embedder into the eval database, as one synthetic user and project with one
     material per corpus document. Re-runs reuse the stored chunks unless the corpus, the
     chunker or the embedding model changed, or --rebuild is given.
  2. For every topic in topics.jsonl, calls the app's retrieval the way the extract-topics job
     does (see `app_retrieval`, the only function that knows how) and scores the result
     against the chunks that the topic's sections contain.
  3. Scores two reference baselines on the same chunks: pure vector cosine, with and without
     the topic keywords in the query text. They are computed here, not by app code.
  4. Writes evals/results/<date>-<label>.json and .md.

No paid API is called. Embeddings are the app's local fastembed model.
"""
import argparse
import asyncio
import datetime
import json
import os
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
EVALS_DIR = HERE.parent
REPO_ROOT = EVALS_DIR.parent
AI_SERVICE_DIR = REPO_ROOT / "ai-service"
CORPUS_FILE = HERE / "corpus.json"
TOPICS_FILE = HERE / "topics.jsonl"
DOCUMENTS_DIR = EVALS_DIR / ".cache" / "documents"
RESULTS_DIR = EVALS_DIR / "results"

# Run with `python -I`, so nothing is importable by accident; add exactly what is needed.
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(EVALS_DIR))

from common.ingest import (  # noqa: E402
    IngestDocument,
    check_db_name,
    chunker_fingerprint,
    file_sha256,
    git,
    ingest_documents,
    prepare_app_environment,
    structure_fingerprint,
)
from common.ingest import load_chunks as load_chunks_for_project  # noqa: E402

from ground_truth import resolve_topics  # noqa: E402
from retrieval_metrics import (  # noqa: E402
    CUTOFF_METRIC_NAMES,
    METRIC_NAMES,
    cutoff_metrics,
    first_relevant_rank,
    mean_metrics,
    relevant_ranks,
    topic_metrics,
)

# Extra cutoffs, read from the same ranked list, to see how good the ordering is when fewer
# chunks are used than the app's K.
CUTOFFS = (5, 10)

EVAL_USER_ID = "eval-user"
EVAL_PROJECT_ID = "eval-project"
MATERIAL_CATEGORY = "book_chapters"

HYBRID = "hybrid_current"
VECTOR_PLAIN = "reference_vector_name_description"
VECTOR_KEYWORDS = "reference_vector_with_keywords"
SYSTEM_LABELS = {
    HYBRID: "app: hybrid_search_chunks (current)",
    VECTOR_PLAIN: "reference: vector cosine, query = name + description",
    VECTOR_KEYWORDS: "reference: vector cosine, query = name + description + keywords",
}


# --------------------------------------------------------------------------------------
# The adapter. If retrieval changes, this is the one function to edit.
# --------------------------------------------------------------------------------------

async def app_retrieval(project_id: str, topic: dict, limit: Optional[int] = None) -> List[dict]:
    """Find a topic's chunks the way the extract-topics job does today.

    ai-service/app/api/routes/jobs.py calls

        hybrid_search_chunks(project_id, topic.name, topic.description, topic.keywords,
                             limit=TOPIC_CHUNK_LIMIT)

    and stores the returned chunks, best first, as the topic's mapped chunks. This function
    makes the same call with the same top-K. Return one dict per chunk, best first:

        {"chunk_id": str, "score": float | None, "source": str | None}

    `source` is only a diagnostic (how the chunk was found). When a later change moves
    retrieval elsewhere (a different function, a retrieval at generation time, a new
    signature), change the import and the call below and keep the return shape. The scoring
    code below does not depend on anything else in app code.
    """
    from app.services.content_generator.context import TOPIC_CHUNK_LIMIT
    from app.services.embeddings.search import hybrid_search_chunks

    rows = await hybrid_search_chunks(
        project_id,
        topic["name"],
        topic["description"],
        topic["keywords"],
        limit=limit if limit is not None else TOPIC_CHUNK_LIMIT,
    )
    return [
        {
            "chunk_id": str(row["id"]),
            "score": float(row["relevance_score"]) if row.get("relevance_score") is not None else None,
            "source": row.get("relevance_source"),
        }
        for row in rows
    ]


def app_top_k() -> int:
    """The top-K the app uses for a topic's chunks."""
    from app.services.content_generator.context import TOPIC_CHUNK_LIMIT

    return TOPIC_CHUNK_LIMIT


# --------------------------------------------------------------------------------------
# Setup
# --------------------------------------------------------------------------------------

def load_topics() -> List[dict]:
    topics = [json.loads(line) for line in TOPICS_FILE.read_text().splitlines() if line.strip()]
    ids = [topic["id"] for topic in topics]
    if len(ids) != len(set(ids)):
        raise SystemExit("topics.jsonl has duplicate topic ids")
    return topics


async def ingest_corpus(corpus: dict, rebuild: bool) -> None:
    """Chunk, embed and store every corpus document (see evals/common/ingest.py).

    Ids are fixed (`eval-material-<doc>-<index>`) so runs are reproducible and tie order is stable.
    """
    documents = []
    for document in corpus["documents"]:
        source = corpus["sources"][document["source"]]
        documents.append(
            IngestDocument(
                id=document["id"],
                path=DOCUMENTS_DIR / document["filename"],
                filename=document["filename"],
                category=MATERIAL_CATEGORY,
                fingerprint_inputs={"book": source["sha256"], "pages": document["pages"]},
                missing_hint="Run: cd ai-service && uv run python -I ../evals/retrieval/fetch_corpus.py",
            )
        )
    await ingest_documents(
        project_id=EVAL_PROJECT_ID,
        user_id=EVAL_USER_ID,
        project_name="Retrieval eval corpus",
        user_email="retrieval-evals@example.invalid",
        user_name="Retrieval evals",
        documents=documents,
        rebuild=rebuild,
    )


async def load_chunks(corpus: dict) -> Dict[str, List[dict]]:
    """Stored chunks per document id, in chunk order, with embeddings as text."""
    return await load_chunks_for_project(EVAL_PROJECT_ID, [d["id"] for d in corpus["documents"]])


# --------------------------------------------------------------------------------------
# Reference baselines (not app code)
# --------------------------------------------------------------------------------------

class VectorIndex:
    """Cosine search over the stored chunk embeddings, in memory."""

    def __init__(self, chunks: List[dict]):
        import numpy as np

        self.np = np
        self.ids = [c["id"] for c in chunks]
        matrix = np.array([json.loads(c["embedding"]) for c in chunks], dtype=np.float64)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        self.matrix = matrix / np.where(norms == 0, 1, norms)

    def top_k(self, query: List[float], k: int) -> List[str]:
        np = self.np
        vector = np.array(query, dtype=np.float64)
        vector = vector / (np.linalg.norm(vector) or 1)
        scores = self.matrix @ vector
        order = np.argsort(-scores, kind="stable")[:k]
        return [self.ids[i] for i in order]


# --------------------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------------------

def doc_alias(doc_id: str) -> str:
    return doc_id.split("-")[0]


def score_topic(topic: dict, ranked_rows: List[dict], relevant: set, k: int, chunk_lookup: Dict[str, dict]) -> dict:
    ids = [row["chunk_id"] for row in ranked_rows]
    metrics = topic_metrics(ids, relevant, k)
    in_doc = sum(1 for chunk_id in ids if chunk_lookup[chunk_id]["document"] == topic["document"])
    sources: Dict[str, int] = {}
    for row in ranked_rows:
        if row.get("source"):
            sources[row["source"]] = sources.get(row["source"], 0) + 1
    SOURCE_CODES = {"keyword_match": "k", "semantic_search": "s", "keyword_and_semantic": "b"}
    result = {
        "id": topic["id"],
        "document": topic["document"],
        "name": topic["name"],
        "num_relevant": len(relevant),
        "num_returned": len(ids),
        "metrics": metrics,
        "first_relevant_rank": first_relevant_rank(ids, relevant),
        "relevant_ranks": relevant_ranks(ids[:k], relevant),
        "same_document_share": (in_doc / len(ids)) if ids else 0.0,
        "at_cutoffs": {str(c): cutoff_metrics(ids, relevant, c) for c in CUTOFFS},
        "top": [
            f"{doc_alias(chunk_lookup[chunk_id]['document'])}#{chunk_lookup[chunk_id]['chunk_index']}"
            + ("*" if chunk_id in relevant else "")
            for chunk_id in ids[:k]
        ],
    }
    if sources:
        result["sources"] = sources
        result["top_sources"] = "".join(SOURCE_CODES.get(row.get("source"), "?") for row in ranked_rows[:k])
    if any(row.get("score") is not None for row in ranked_rows):
        result["top_scores"] = [round(row["score"], 3) if row.get("score") is not None else None for row in ranked_rows[:k]]
    return result


def summarise(per_topic: List[dict], documents: List[str]) -> dict:
    def block(rows: List[dict]) -> dict:
        out = {"topics": len(rows), **mean_metrics(r["metrics"] for r in rows)}
        out["same_document_share"] = sum(r["same_document_share"] for r in rows) / len(rows) if rows else 0.0
        out["at_cutoffs"] = {
            str(c): {
                name: (sum(r["at_cutoffs"][str(c)][name] for r in rows) / len(rows)) if rows else 0.0
                for name in CUTOFF_METRIC_NAMES
            }
            for c in CUTOFFS
        }
        return out

    return {
        "overall": block(per_topic),
        "per_document": {d: block([r for r in per_topic if r["document"] == d]) for d in documents},
    }


# --------------------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------------------

def num(value: float) -> str:
    return f"{value:.3f}"


def render_markdown(report: dict) -> str:
    k = report["config"]["top_k"]
    systems = report["systems"]
    docs = [d["id"] for d in report["corpus"]["documents"]]
    doc_counts = ", ".join(f"{d['id']} {d['chunks']}" for d in report["corpus"]["documents"])
    app_note = " (app code modified)" if report["code"]["app_dirty"] else ""
    lines = [
        f"# Retrieval eval: {report['label']}",
        "",
        f"- Date: {report['date']}",
        f"- Code: `{report['code']['commit'][:10]}`{app_note}, search.py `{report['code']['search_py_sha256'][:10]}`",
        f"- Topics: {report['corpus']['topics']}, chunks: {report['corpus']['chunks']} ({doc_counts})",
        f"- K = {k} (the app's TOPIC_CHUNK_LIMIT), embeddings: `{report['config']['embedder']}`",
        f"- Runtime: {report['timing']['total_seconds']:.1f}s total, "
        f"{report['timing']['ingest_seconds']:.1f}s ingestion, {report['timing']['retrieval_seconds']:.1f}s scoring",
        "",
        "Relevance is by document section (see README): a chunk counts when it sits inside the "
        "topic's section. Averages are macro averages over topics.",
        "",
        "## Overall",
        "",
        f"| System | recall@{k} | precision@{k} | MRR | nDCG@{k} | hit@5 | same-doc share |",
        "|---|---|---|---|---|---|---|",
    ]
    for name, system in systems.items():
        o = system["summary"]["overall"]
        lines.append(
            f"| {SYSTEM_LABELS.get(name, name)} | {num(o['recall@k'])} | {num(o['precision@k'])} | {num(o['mrr'])} | "
            f"{num(o['ndcg@k'])} | {num(o['hit@5'])} | {num(o['same_document_share'])} |"
        )
    lines += [
        "",
        "Same ranked lists, cut shorter (how good is the ordering if fewer chunks are used):",
        "",
        "| System | " + " | ".join(f"recall@{c} | nDCG@{c}" for c in CUTOFFS) + " |",
        "|---|" + "---|---|" * len(CUTOFFS),
    ]
    for name, system in systems.items():
        cells = []
        for c in CUTOFFS:
            m = system["summary"]["overall"]["at_cutoffs"][str(c)]
            cells += [num(m["recall"]), num(m["ndcg"])]
        lines.append(f"| {SYSTEM_LABELS.get(name, name)} | " + " | ".join(cells) + " |")
    lines += ["", "## Per document", ""]
    for doc in docs:
        n = systems[HYBRID]["summary"]["per_document"][doc]["topics"]
        lines += [
            f"### {doc} ({n} topics)",
            "",
            f"| System | recall@{k} | precision@{k} | MRR | nDCG@{k} | hit@5 |",
            "|---|---|---|---|---|---|",
        ]
        for name, system in systems.items():
            o = system["summary"]["per_document"][doc]
            lines.append(
                f"| {SYSTEM_LABELS.get(name, name)} | {num(o['recall@k'])} | {num(o['precision@k'])} | "
                f"{num(o['mrr'])} | {num(o['ndcg@k'])} | {num(o['hit@5'])} |"
            )
        lines.append("")

    hybrid_topics = {t["id"]: t for t in systems[HYBRID]["per_topic"]}
    vector_topics = {t["id"]: t for t in systems[VECTOR_PLAIN]["per_topic"]}
    lines += [
        "## Per topic",
        "",
        "`|R|` is the number of relevant chunks. `rank` is the position of the first relevant chunk "
        "(0 = none returned). `kw-only` is the share of the hybrid result that was found only by the "
        "keyword match.",
        "",
        f"| Topic | doc | \\|R\\| | hybrid recall@{k} | hybrid rank | hybrid kw-only | vector recall@{k} | vector rank |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for topic_id, h in hybrid_topics.items():
        v = vector_topics[topic_id]
        returned = max(h["num_returned"], 1)
        kw_only = h.get("sources", {}).get("keyword_match", 0) / returned
        lines.append(
            f"| {topic_id} | {doc_alias(h['document'])} | {h['num_relevant']} | {num(h['metrics']['recall@k'])} | "
            f"{h['first_relevant_rank']} | {kw_only:.2f} | {num(v['metrics']['recall@k'])} | {v['first_relevant_rank']} |"
        )
    lines += [
        "",
        "Rows are in topics.jsonl order. The JSON file has every topic's returned chunks (`top`, `*` = relevant).",
        "",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------

async def run(args: argparse.Namespace) -> dict:
    from app.config import settings
    from app.db.connection import close_db_pool
    from app.services.embeddings.generator import generate_query_embedding

    corpus = json.loads(CORPUS_FILE.read_text())
    topics = load_topics()
    started = time.perf_counter()

    print("Ingesting corpus")
    ingest_started = time.perf_counter()
    try:
        await ingest_corpus(corpus, rebuild=args.rebuild)
        chunks_by_doc = await load_chunks(corpus)
        ingest_seconds = time.perf_counter() - ingest_started

        for document in corpus["documents"]:
            if not chunks_by_doc[document["id"]]:
                raise SystemExit(f"no stored chunks for {document['id']}")
        relevant_by_topic = resolve_topics(topics, chunks_by_doc)

        # Chunk structure drift check: the chunk-range specs depend on the chunker.
        structure = []
        for document in corpus["documents"]:
            chunks = chunks_by_doc[document["id"]]
            fingerprint = structure_fingerprint(chunks)
            expected = document.get("expected_structure")
            entry = {"id": document["id"], "chunks": len(chunks), "structure_sha256": fingerprint}
            if not expected:
                print(f"  note: no expected_structure in corpus.json for {document['id']} ({len(chunks)} chunks, {fingerprint})")
            elif expected["chunks"] != len(chunks) or expected["structure_sha256"] != fingerprint:
                print(
                    f"  WARNING: chunk structure of {document['id']} changed "
                    f"(expected {expected['chunks']} chunks, got {len(chunks)}). Section specs follow the new "
                    "structure but chunk_range specs in topics.jsonl may now point at the wrong chunks."
                )
                entry["structure_changed"] = True
            structure.append(entry)

        all_chunks = [
            {**chunk, "document": doc_id} for doc_id, chunks in chunks_by_doc.items() for chunk in chunks
        ]
        chunk_lookup = {c["id"]: c for c in all_chunks}
        index = VectorIndex(all_chunks)
        k = args.top_k or app_top_k()

        per_topic: Dict[str, List[dict]] = {HYBRID: [], VECTOR_PLAIN: [], VECTOR_KEYWORDS: []}
        retrieval_started = time.perf_counter()
        for position, topic in enumerate(topics, start=1):
            relevant = relevant_by_topic[topic["id"]]

            rows = await app_retrieval(EVAL_PROJECT_ID, topic, limit=args.top_k)
            per_topic[HYBRID].append(score_topic(topic, rows, relevant, k, chunk_lookup))

            plain_text = f"{topic['name']}: {topic['description']}"
            keyword_text = f"{plain_text} Keywords: {', '.join(topic['keywords'])}"
            for system, text in ((VECTOR_PLAIN, plain_text), (VECTOR_KEYWORDS, keyword_text)):
                query = await generate_query_embedding(text)
                ranked = [{"chunk_id": chunk_id} for chunk_id in index.top_k(query, k)]
                per_topic[system].append(score_topic(topic, ranked, relevant, k, chunk_lookup))
            if position % 10 == 0:
                print(f"  scored {position}/{len(topics)} topics")
        retrieval_seconds = time.perf_counter() - retrieval_started
    finally:
        await close_db_pool()

    documents = [d["id"] for d in corpus["documents"]]
    systems = {
        name: {
            "description": SYSTEM_LABELS[name],
            "summary": summarise(rows, documents),
            "per_topic": rows,
        }
        for name, rows in per_topic.items()
    }
    search_py = AI_SERVICE_DIR / "app" / "services" / "embeddings" / "search.py"
    report = {
        "label": args.label,
        "date": datetime.date.today().isoformat(),
        "code": {
            "commit": git("rev-parse", "HEAD"),
            "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "app_dirty": bool(git("status", "--porcelain", "--", "ai-service/app")),
            "search_py_sha256": file_sha256(search_py),
        },
        "config": {
            "top_k": k,
            "embedder": f"{settings.EMBEDDING_PROVIDER}:{settings.EMBEDDING_MODEL}",
            "database": urlparse(args.db).path.lstrip("/"),
        },
        "corpus": {
            "topics": len(topics),
            "chunks": len(all_chunks),
            "documents": structure,
        },
        "timing": {
            "total_seconds": time.perf_counter() - started,
            "ingest_seconds": ingest_seconds,
            "retrieval_seconds": retrieval_seconds,
        },
        "metric_names": METRIC_NAMES,
        "systems": systems,
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", default=os.environ.get("EVAL_DATABASE_URL"), help="eval database URL (or set EVAL_DATABASE_URL)")
    parser.add_argument("--rebuild", action="store_true", help="re-chunk and re-embed every document")
    parser.add_argument("--label", default="run", help="name for the result files, e.g. baseline")
    parser.add_argument("--top-k", type=int, default=None, help="override K (default: the app's TOPIC_CHUNK_LIMIT)")
    parser.add_argument("--out-dir", type=Path, default=RESULTS_DIR)
    parser.add_argument("--allow-any-db", action="store_true", help="allow a database whose name does not contain 'eval'")
    args = parser.parse_args()
    if not args.db:
        parser.error("--db is required (or set EVAL_DATABASE_URL)")
    check_db_name(args.db, args.allow_any_db)

    prepare_app_environment(args.db)

    report = asyncio.run(run(args))

    args.out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{report['date']}-{args.label}"
    json_path = args.out_dir / f"{stem}.json"
    md_path = args.out_dir / f"{stem}.md"
    json_path.write_text(json.dumps(report, indent=2) + "\n")
    md_path.write_text(render_markdown(report))
    print(f"\nWrote {json_path}\nWrote {md_path}\n")
    k = report["config"]["top_k"]
    for name, system in report["systems"].items():
        o = system["summary"]["overall"]
        print(
            f"{SYSTEM_LABELS[name]:<70} recall@{k} {o['recall@k']:.3f}  P@{k} {o['precision@k']:.3f}  "
            f"MRR {o['mrr']:.3f}  nDCG@{k} {o['ndcg@k']:.3f}  hit@5 {o['hit@5']:.3f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
