"""Voice coach: drill filtering."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.api.routes import voice
from app.api.routes.voice import DrillGenerateRequest, _is_conceptual_text
from app.services.llm.schemas import DrillQuestion, DrillQuestionSet


@pytest.mark.parametrize(
    "text,conceptual",
    [
        ("Summarize the role of layer 4 in the OSI model", True),
        ("Calculate the area of a circle", False),
        ("If x = 3, what is y?", False),
    ],
)
def test_math_filter_uses_word_boundaries(text, conceptual):
    assert _is_conceptual_text(text) is conceptual


@pytest.mark.asyncio
async def test_drill_tops_up_after_filtering():
    questions = [
        DrillQuestion(question_text=f"Explain idea {i}", key_points=["k"], sample_answer="s", explanation="e")
        for i in range(4)
    ] + [DrillQuestion(question_text="Calculate 3 + 4", key_points=["k"], sample_answer="7", explanation="e")]
    llm = MagicMock()
    llm.generate_structured = AsyncMock(return_value=DrillQuestionSet(questions=questions))
    with patch.object(voice.LLMFactory, "get_provider", return_value=llm):
        result = await voice.generate_concept_drill(DrillGenerateRequest(notes="n", count=3))
    assert result["total"] == 3

