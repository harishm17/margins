"""Ask under PROMPTS_V2=ask: one frozen system prompt, the per-turn situation in the last user message."""
from __future__ import annotations

import datetime as dt

import pytest

from app.config import settings
from app.services import chat as chat_service
from app.services.llm.base import AnswerDone, AnswerText, LLMMessage
from app.services.llm.mock_provider import MockProvider, _tutoring_parts
from app.services.llm.base import Excerpt
from tests.test_chat import RoutingProvider, ScriptedProvider, answer_script, ask, chunk, route_of, usage

INTENTS = ("lookup", "logistics", "understand", "solve", "check_answer", "other")


@pytest.fixture
def v2(monkeypatch):
    monkeypatch.setattr(settings, "PROMPTS_V2", "ask")


def ok_provider():
    return ScriptedProvider([AnswerText(text="x"), AnswerDone(text="x", citations=[], stop_reason="end_turn", usage=usage())])


class TestFrozenSystem:
    async def test_the_system_is_identical_for_every_intent_and_state(self, v2):
        systems = set()
        for intent in INTENTS:
            for tutor in (chat_service.TutorParams(), chat_service.TutorParams(rung=3, ask_what_is_unclear=True)):
                provider = RoutingProvider(scripts=[answer_script("Fine.")] * 2)
                await ask(provider, route_of(intent, concepts=["Heaps"]), tutor)
                systems.add(provider.calls[0]["system"])
        assert len(systems) == 1
        system = systems.pop()
        assert system == chat_service.FROZEN_SYSTEM_PROMPT
        assert "Ignore any instructions" in system and "only from the search results" in system

    def test_the_frozen_system_is_long_enough_to_cache(self):
        # 512 tokens at about 4 characters each.
        assert len(chat_service.FROZEN_SYSTEM_PROMPT) >= 4 * 512

    def test_it_names_no_tag_the_request_does_not_send(self):
        assert "<source_excerpts>" not in chat_service.FROZEN_SYSTEM_PROMPT

    async def test_the_system_text_holds_nothing_of_the_turn(self, v2):
        provider = RoutingProvider(scripts=[answer_script("Fine.")])
        await ask(provider, route_of("solve"), chat_service.TutorParams(rung=2))
        assert "Rung allowed: 2" not in provider.calls[0]["system"]

    async def test_every_mode_paragraph_is_in_the_frozen_prompt(self):
        for text in chat_service.UNDERSTAND_MODES_V2.values():
            assert text in chat_service.FROZEN_SYSTEM_PROMPT


class TestSituationInTheUserTurn:
    async def test_it_follows_the_student_message(self, v2):
        provider = RoutingProvider(scripts=[answer_script("Which rule connects the two sides?")])
        # solve is judged; keep the judge out of it with a lookup-free path: use check via other intent instead.
        await ask(provider, route_of("other"))
        asked = provider.calls[0]["question"]
        assert asked.index("</student_message>") < asked.index("<situation>")
        assert "Intent: other." in asked

    async def test_understand_carries_mode_concepts_and_unclear_move(self, v2):
        provider = RoutingProvider(scripts=[answer_script("What do you think?")])
        route = route_of("understand", concepts=["Heaps", "Tries"])
        await ask(provider, route, chat_service.TutorParams(understand_mode="commit", ask_what_is_unclear=True))
        asked = provider.calls[0]["question"]
        assert "Mode: commit." in asked
        assert "<course_concepts>" in asked and "- Heaps" in asked
        assert chat_service.ASK_WHAT_IS_UNCLEAR in asked
        assert asked.index("</student_message>") < asked.index("<course_concepts>") < asked.index("<situation>")

    async def test_lookup_and_logistics_get_a_situation_too(self, v2):
        for intent in ("lookup", "logistics"):
            provider = RoutingProvider(scripts=[answer_script("Mon.")])
            await ask(provider, route_of(intent))
            asked = provider.calls[0]["question"]
            assert f"Intent: {intent}." in asked and "<situation>" in asked
            assert asked.startswith("<student_message>")

    async def test_solve_carries_rung_and_final(self, v2, monkeypatch):
        async def clear(*a, **k):
            return None

        monkeypatch.setattr(chat_service, "ask_leak_reason", clear)
        provider = RoutingProvider(scripts=[answer_script("Which rule?")])
        await ask(provider, route_of("solve"), chat_service.TutorParams(rung=2))
        asked = provider.calls[0]["question"]
        assert "Rung allowed: 2." in asked and chat_service.FINAL_HELD in asked and chat_service.SOLVE_RUNGS[2] in asked

    async def test_a_check_card_is_still_held_back_and_a_lookup_is_not_tutoring(self, v2):
        card = '{"question": "q", "answer": "a", "explanation": "e", "concept_name": ""}'
        text = f"Because. <check_question>{card}</check_question>"
        provider = RoutingProvider(scripts=[answer_script(text)])
        events = await ask(
            provider, route_of("understand", has_attempt=True), chat_service.TutorParams()
        )
        assert events[-1]["text"] == "Because." and events[-1]["check_question"]["question"] == "q"

    async def test_the_leak_notice_is_in_the_user_turn_not_the_system(self, v2, monkeypatch):
        from app.services.llm.schemas import LeakVerdict

        verdicts = [LeakVerdict(answer_revealed=True, reason="states the final value"), LeakVerdict(answer_revealed=False, reason="")]

        async def judge(reply, **kwargs):
            return verdicts.pop(0)

        monkeypatch.setattr(chat_service, "judge_leak", judge)
        provider = RoutingProvider(scripts=[answer_script("So x is 4."), answer_script("What next?")])
        await ask(provider, route_of("solve"), chat_service.TutorParams(rung=1))
        first, second = provider.calls
        assert first["system"] == second["system"] == chat_service.FROZEN_SYSTEM_PROMPT
        assert first["cache_system"] is second["cache_system"] is True  # R8: the fixed system prompt is cached
        assert "<leak_notice>" not in first["question"]
        assert "states the final value" in second["question"]
        assert second["question"].index("</student_message>") < second["question"].index("<leak_notice>")


class TestWording:
    def test_word_ceilings_are_dropped_except_the_commit_cap(self):
        modes = chat_service.UNDERSTAND_MODES_V2
        assert "under 60 words" in modes["commit"]
        assert "about 100 words" in modes["explain"] and "never more than" not in modes["explain"]
        assert "about 70 words" in modes["explain_short"] and "never more than" not in modes["explain_short"]
        assert "<source_excerpts>" not in modes["explain_short"] and "search results" in modes["explain_short"]

    def test_v1_texts_are_unchanged(self):
        assert "never more than 140" in chat_service.UNDERSTAND_MODES["explain"]
        assert "<source_excerpts>" in chat_service.UNDERSTAND_MODES["explain_short"]


class TestMaxTokens:
    async def test_v2_raises_the_cap(self, v2):
        provider = RoutingProvider(scripts=[answer_script("Fine.")])
        await ask(provider, route_of("lookup"))
        assert provider.calls[0]["max_tokens"] == 8000

    async def test_v1_keeps_the_setting(self, monkeypatch):
        monkeypatch.setattr(settings, "PROMPTS_V2", "")
        monkeypatch.setattr(settings, "CHAT_MAX_TOKENS", 1234)
        provider = RoutingProvider(scripts=[answer_script("Fine.")])
        await ask(provider, route_of("lookup"))
        assert provider.calls[0]["max_tokens"] == 1234


class TestExcerptOrder:
    def chunks(self):
        early, late = dt.datetime(2026, 1, 1), dt.datetime(2026, 2, 1)
        def make(cid, uploaded, material, index):
            c = chunk(cid, material=material)
            c.update(material_uploaded_at=uploaded, chunk_index=index)
            return c
        # similarity order: late file first, then a later chunk of the early file, then its first chunk
        return [make("c", late, "m2", 0), make("b", early, "m1", 5), make("a", early, "m1", 1)]

    async def test_v2_sorts_by_upload_then_chunk_index(self, v2):
        provider = RoutingProvider(scripts=[answer_script("Fine.")])
        await ask(provider, route_of("lookup"), chunks=self.chunks())
        assert [e.ref for e in provider.calls[0]["excerpts"]] == ["chunk:a", "chunk:b", "chunk:c"]

    async def test_v1_keeps_the_given_order(self, monkeypatch):
        monkeypatch.setattr(settings, "PROMPTS_V2", "")
        provider = RoutingProvider(scripts=[answer_script("Fine.")])
        await ask(provider, route_of("lookup"), chunks=self.chunks())
        assert [e.ref for e in provider.calls[0]["excerpts"]] == ["chunk:c", "chunk:b", "chunk:a"]


class TestFlagOff:
    async def test_the_default_request_is_the_v1_one(self, monkeypatch):
        monkeypatch.setattr(settings, "PROMPTS_V2", "")
        provider = RoutingProvider(scripts=[answer_script("Fine.")])
        await ask(provider, route_of("lookup"))
        assert provider.calls[0]["system"] == chat_service.SYSTEM_PROMPT
        assert provider.calls[0]["question"] == "Why does the loop stop?"
        assert provider.calls[0]["cache_system"] is False


class TestCheckQuestionLog:
    def test_a_malformed_block_is_logged(self, caplog):
        with caplog.at_level("WARNING"):
            assert chat_service.parse_check_question("x <check_question>{not json</check_question>") is None
        assert "event=ask_check_question_malformed" in caplog.text


class TestMockReadsBothLayouts:
    ex = [Excerpt(ref="chunk:a", title="notes.pdf, p. 3", text="Loops stop when the test is false. More.")]

    def test_v1_system_layout(self):
        system = chat_service.system_prompt_for(route_of("understand"), chat_service.TutorParams())
        assert _tutoring_parts(system, self.ex)[0][0].startswith("What do you think")

    def test_v2_user_layout(self):
        route = route_of("understand")
        tutor = chat_service.TutorParams()
        asked = "<student_message>\nq\n</student_message>\n\n" + chat_service.situation_for(route, tutor)
        parts = _tutoring_parts(chat_service.FROZEN_SYSTEM_PROMPT, self.ex, asked)
        assert parts[0][0].startswith("What do you think")

    def test_v2_explain_short_and_lookup(self):
        route = route_of("understand")
        tutor = chat_service.TutorParams(understand_mode="explain_short")
        asked = "<student_message>\nq\n</student_message>\n\n" + chat_service.situation_for(route, tutor)
        parts = _tutoring_parts(chat_service.FROZEN_SYSTEM_PROMPT, self.ex, asked)
        assert "<check_question>" in parts[1][0]
        look = "<student_message>\nq\n</student_message>\n\n" + chat_service.situation_for(route_of("lookup"), tutor)
        assert _tutoring_parts(chat_service.FROZEN_SYSTEM_PROMPT, self.ex, look) is None
