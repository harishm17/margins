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
        ("Why did Python 3 drop print statements?", True),
        ("What does the summary of chapter 2 say?", True),
        ("Calculate the area of a circle", False),
        ("What is the sum of the angles?", False),
        ("If x = 3, what is y?", False),
        ("What is 2 + 2?", False),
        ("Explain the formula for entropy", False),
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
    assert "6 questions" in llm.generate_structured.call_args.args[0][-1].content
    assert llm.generate_structured.call_args.kwargs["purpose"] == "voice_drill"


@pytest.mark.asyncio
async def test_drill_prompt_names_the_app_margins():
    llm = MagicMock()
    llm.generate_structured = AsyncMock(
        return_value=DrillQuestionSet(
            questions=[DrillQuestion(question_text="Explain idea", key_points=["k"], sample_answer="s", explanation="e")]
        )
    )
    with patch.object(voice.LLMFactory, "get_provider", return_value=llm):
        await voice.generate_concept_drill(DrillGenerateRequest(notes="n", count=3))
    system = llm.generate_structured.call_args.args[0][0].content
    assert system.startswith("You are the oral exam coach in Margins, a study app.")
    assert "StudyBuddy" not in system
