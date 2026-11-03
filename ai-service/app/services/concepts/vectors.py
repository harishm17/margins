"""pgvector text literals, shared by the concept writers."""
from typing import List


def vector_literal(values: List[float]) -> str:
    return "[" + ",".join(repr(float(v)) for v in values) + "]"


def parse_vector(text: str) -> List[float]:
    return [float(v) for v in text.strip("[]").split(",") if v]
