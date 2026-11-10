"""Log calls keep values out of the message (SEC-L3, OPS-M6).

The log filter (app/logging_utils.py) turns an exception passed as a log argument into `ClassName(code)`. That only
works when the exception travels as an argument: `logger.warning(f"failed: {exc}")` has already written the text into
the message by the time the filter sees it. So every `logger.*` call under app/ has a plain string literal as its
message, and none of its arguments turns an exception into text by hand (`str(exc)`, `repr(exc)`, `.format`, f-strings).
"""
import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
LEVELS = {"debug", "info", "warning", "warn", "error", "exception", "critical", "fatal"}
LOGGER_NAMES = {"logger", "log", "_logger"}
TEXT_MAKERS = {"str", "repr", "format", "ascii"}


def _is_log_call(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in LEVELS
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id in LOGGER_NAMES
    )


def _hand_made_text(node: ast.AST) -> bool:
    """str(...), repr(...), "...".format(...), an f-string or a % or + on text, anywhere inside this argument."""
    for child in ast.walk(node):
        if isinstance(child, ast.JoinedStr):
            return True
        if isinstance(child, ast.Call):
            func = child.func
            if isinstance(func, ast.Name) and func.id in TEXT_MAKERS:
                return True
            if isinstance(func, ast.Attribute) and func.attr == "format":
                return True
        if isinstance(child, ast.BinOp) and isinstance(child.op, (ast.Mod, ast.Add)):
            if any(isinstance(side, (ast.Constant, ast.JoinedStr)) and isinstance(getattr(side, "value", ""), str) for side in (child.left, child.right)):
                return True
    return False


def _violations() -> list[str]:
    found = []
    for path in sorted(APP.rglob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not _is_log_call(node):
                continue
            where = f"{path.relative_to(APP.parent)}:{node.lineno}"
            if not node.args or not (isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
                found.append(f"{where}: the message is not a plain string literal")
                continue
            for arg in node.args[1:]:
                if _hand_made_text(arg):
                    found.append(f"{where}: an argument is text made by hand (str, repr, format, f-string); pass the value")
    return found


def test_log_calls_have_literal_messages_and_no_hand_made_exception_text():
    assert _violations() == []
