"""Every SQL statement the AI service's code holds, as text Postgres can check (tests/test_schema_contract.py).

The service reads and writes the web app's tables with raw SQL. This finds each string in app/ that starts like a SQL
statement and rebuilds f-strings: a placeholder that names a module constant (UTC_NOW, WAITING_FOR_AI) or a string
assigned earlier in the same function (a shared WHERE clause) is filled in with its text. A placeholder that is only
known at run time (a column list chosen by the caller, say) cannot be checked statically: the statement is reported
as unresolved, and the test keeps their number from growing silently.
"""
import ast
import importlib
import re
from dataclasses import dataclass
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
# WITH only as a CTE (`WITH name AS (`, `WITH RECURSIVE name (cols) AS (`): prompt text such as "with a type: ..." is
# not SQL.
SQL_START = re.compile(
    r"^\s*((SELECT|INSERT|UPDATE|DELETE)\b|WITH\s+(RECURSIVE\s+)?\w+\s*(\([^)]*\)\s*)?AS\s*(NOT\s+)?(MATERIALIZED\s*)?\()",
    re.IGNORECASE,
)


@dataclass
class Statement:
    where: str  # file:line
    sql: str | None  # None when a placeholder could not be resolved
    unresolved: str = ""


class _Unresolved(Exception):
    pass


def _module_name(path: Path) -> str:
    return ".".join(path.relative_to(APP.parent).with_suffix("").parts)


def _local_strings(func: ast.AST) -> dict[str, ast.AST]:
    """Names assigned exactly once in a function to a string or f-string."""
    found: dict[str, list[ast.AST]] = {}
    for node in ast.walk(func):
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, (ast.JoinedStr, ast.Constant))
        ):
            found.setdefault(node.targets[0].id, []).append(node.value)
    return {name: values[0] for name, values in found.items() if len(values) == 1}


def _render(node: ast.AST, module, local: dict[str, ast.AST], depth: int = 0) -> str:
    if depth > 5:
        raise _Unresolved("nesting")
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts = []
        for value in node.values:
            if isinstance(value, ast.Constant):
                parts.append(value.value)
            else:
                parts.append(_render(value.value, module, local, depth + 1))
        return "".join(parts)
    if isinstance(node, ast.Name):
        if node.id in local:
            return _render(local[node.id], module, local, depth + 1)
        value = getattr(module, node.id, None)
        if isinstance(value, str):
            return value
        raise _Unresolved(node.id)
    if isinstance(node, ast.Attribute):
        try:
            value = eval(compile(ast.Expression(node), "<sql>", "eval"), vars(module))
        except Exception as exc:
            raise _Unresolved(ast.unparse(node)) from exc
        if isinstance(value, str):
            return value
        raise _Unresolved(ast.unparse(node))
    raise _Unresolved(ast.unparse(node))


def _enclosing_functions(tree: ast.AST) -> dict[int, ast.AST]:
    """The innermost function around each node, by id."""
    owner: dict[int, ast.AST] = {}

    def visit(node: ast.AST, func: ast.AST | None):
        for child in ast.iter_child_nodes(node):
            current = child if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) else func
            if current is not None:
                owner[id(child)] = current
            visit(child, current)

    visit(tree, None)
    return owner


def _starts_like_sql(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return bool(SQL_START.match(node.value))
    if isinstance(node, ast.JoinedStr) and node.values and isinstance(node.values[0], ast.Constant):
        first = node.values[0].value
        return isinstance(first, str) and bool(SQL_START.match(first))
    return False


def statements() -> list[Statement]:
    found: list[Statement] = []
    for path in sorted(APP.rglob("*.py")):
        tree = ast.parse(path.read_text())
        module = importlib.import_module(_module_name(path))
        owners = _enclosing_functions(tree)
        nested = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.JoinedStr):
                nested.update(id(v) for v in node.values)
            # Docstrings ("Delete the voice transcripts...") start like SQL too.
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
                first = node.body[0]
                if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                    nested.add(id(first.value))
        for node in ast.walk(tree):
            if id(node) in nested or not _starts_like_sql(node):
                continue
            func = owners.get(id(node))
            local = _local_strings(func) if func is not None else {}
            where = f"{path.relative_to(APP.parent)}:{getattr(node, 'lineno', 0)}"
            try:
                found.append(Statement(where, _render(node, module, local)))
            except _Unresolved as exc:
                found.append(Statement(where, None, str(exc)))
    return found
