"""A limit that lives in one process's memory is not a limit once the service runs as two replicas or restarts.

Locks, semaphores and conditions that guard shared work belong in Postgres (app/services/locks.py) or the LLM slot
limiter (app/services/llm/limiter.py). This test fails when a new in-memory asyncio/threading lock, semaphore or
condition appears in app/, or a module-level empty dict/set/deque that could be used as a limiter or lock table.
A genuine exception goes in the allow-list below with the reason it is safe.
"""
import ast
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"

PRIMITIVES = {"Lock", "RLock", "Semaphore", "BoundedSemaphore", "Condition"}
MODULES = {"asyncio", "threading"}
CONTAINER_CALLS = {"dict", "set", "OrderedDict", "defaultdict", "deque"}

# (file relative to app/, what it is): why a process-local one is correct here.
ALLOWED = {
    ("db/connection.py", "asyncio.Lock"): "guards creating this process's own connection pool; nothing to share across processes",
    ("services/embeddings/generator.py", "threading.Lock"): "loads the embedding model once per process; the model is process memory",
    ("services/document_processor/extractors.py", "threading.Lock"): "PyMuPDF is not thread-safe inside one process",
    ("services/exam_generator.py", "asyncio.Semaphore"): "bounds fan-out inside one request, created per call; not a cross-request limit",
    ("services/exam_grader.py", "asyncio.Semaphore"): "bounds fan-out inside one request, created per call; not a cross-request limit",
    ("services/dispatch.py", "_background_tasks"): "keeps references to this process's fire-and-forget tasks so they are not collected",
    ("services/ops.py", "_background"): "keeps references to this process's fire-and-forget tasks so they are not collected",
    ("services/ops.py", "_local_cooldown"): "fallback alert dedupe when the database is down; the database row is the shared one",
    ("services/exam_guard.py", "_cache"): "an LRU of guard verdicts, a cache: a miss only costs one more check",
    ("services/job_runner.py", "_running"): "this process's running job tasks, so shutdown and a lost lease can cancel them",
    ("services/llm/mock_provider.py", "_failures_left"): "test double state, never in production",
}


def _primitive(call: ast.Call, imported: dict[str, str]) -> str | None:
    func = call.func
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id in MODULES and func.attr in PRIMITIVES:
        return f"{func.value.id}.{func.attr}"
    if isinstance(func, ast.Name) and func.id in imported:
        return imported[func.id]
    return None


def _findings() -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path in sorted(APP.rglob("*.py")):
        rel = path.relative_to(APP).as_posix()
        tree = ast.parse(path.read_text())
        imported = {
            alias.asname or alias.name: f"{node.module}.{alias.name}"
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module in MODULES
            for alias in node.names
            if alias.name in PRIMITIVES
        }
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and (name := _primitive(node, imported)):
                found.add((rel, name))
        for node in tree.body:  # module level only
            targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
            value = getattr(node, "value", None)
            empty = (isinstance(value, ast.Dict) and not value.keys) or (
                isinstance(value, ast.Call)
                and isinstance(value.func, ast.Name)
                and value.func.id in CONTAINER_CALLS
                and not value.args
                or isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "defaultdict"
            )
            if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "set":
                empty = not value.args
            for target in targets:
                if empty and isinstance(target, ast.Name):
                    found.add((rel, target.id))
    return found


def test_no_new_process_local_locks_or_limiters():
    unexpected = sorted(_findings() - set(ALLOWED))
    assert not unexpected, (
        "New in-memory lock, semaphore or module-level container: use Postgres (app/services/locks.py) or the LLM "
        f"limiter, or add it to ALLOWED in this file with a reason: {unexpected}"
    )


def test_the_allow_list_has_no_stale_entries():
    stale = sorted(set(ALLOWED) - _findings())
    assert not stale, f"Remove from ALLOWED, the code no longer has them: {stale}"
