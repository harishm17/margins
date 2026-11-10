"""The practice tutor's retry before the authored fallback, and the drafts it keeps from rejected replies."""
import re

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.llm.schemas import LeakVerdict
from app.services.tutor import practice
from app.services.tutor.practice import tutor_reply
from tests.test_tutor_practice import HINTS_1, THREE_STEPS, Scripted, request, reply, step, use

LATER_ANSWER_CONFIRM = "Yes, 0.1071 is right. Now a new case: a bag has 99 marbles; what do you get?"
CLEAN_CONFIRM = "Yes, 0.1071 is right. Try the same idea on a bag of 4 red and 6 blue: what is P(both red)?"


def confirm_request(**over):
    base = dict(
        steps=THREE_STEPS, step_index=1, move="confirm", rung_allowed=0, final_allowed=True, own_answer="0.1071",
        attempts=["0.1071"], working="",
    )
    base.update(over)
    return request(**base)


def notice_of(prompt):
    return re.search(r"<leak_notice>.*?</leak_notice>", prompt, re.S).group(0)


@pytest.mark.asyncio
async def test_a_string_hit_is_retried_with_the_value_named_and_the_passing_retry_is_used():
    provider = Scripted([reply(LATER_ANSWER_CONFIRM, rung=0, kind=None), reply(CLEAN_CONFIRM, rung=0, kind=None)])
    with use(provider):
        out = await tutor_reply(confirm_request())
    assert out.reply == CLEAN_CONFIRM and out.from_authored_hint is False and out.leaked is True
    # The retry carries a note that names the value, the step it answers and why it is off limits.
    notice = notice_of(provider.tutor_prompts()[1])
    assert '"99"' in notice and "answer to step 3" in notice and "would read that value as the answer" in notice
    assert "<leak_notice>" not in provider.tutor_prompts()[0]
    # The retry went through the judge as well as the string check; the string-hit draft never reached it.
    assert len(provider.tutor_prompts()) == 2 and len(provider.judge_calls()) == 1
    # What was held back is kept, with the value and the verdict on its retry.
    assert [(d.attempt, d.kind, d.values, d.retry_passed) for d in out.rejected_drafts] == [(1, "string", ["99"], True)]
    assert out.rejected_drafts[0].draft == LATER_ANSWER_CONFIRM and "later step" in out.rejected_drafts[0].reason


@pytest.mark.asyncio
async def test_a_retry_that_states_the_value_again_falls_back_and_keeps_both_drafts():
    again = "Right, 0.1071. Scale it to 99 and tell me what you see?"
    provider = Scripted([reply(LATER_ANSWER_CONFIRM, rung=0, kind=None), reply(again, rung=0, kind=None)])
    with use(provider):
        out = await tutor_reply(confirm_request())
    assert out.from_authored_hint is True and out.leaked is True and out.reply == practice.CONFIRM_FALLBACK
    assert len(provider.tutor_prompts()) == 2 and provider.judge_calls() == []
    assert [(d.attempt, d.kind, d.values, d.retry_passed) for d in out.rejected_drafts] == [
        (1, "string", ["99"], False),
        (2, "string", ["99"], None),
    ]
    assert out.rejected_drafts[1].draft == again


@pytest.mark.asyncio
async def test_a_judge_verdict_gets_the_same_one_retry_and_then_the_fallback():
    provider = Scripted(
        [reply("Multiply 3 over 8 by 2 over 7.", rung=1), reply("Now multiply the two fractions.", rung=1)],
        verdicts=[LeakVerdict(answer_revealed=True, reason="plugs the numbers in"), LeakVerdict(answer_revealed=True, reason="still plugs them in")],
    )
    with use(provider):
        out = await tutor_reply(request())
    assert out.from_authored_hint is True and out.reply == HINTS_1[0]
    # The bound: two tutor calls and two judge calls, never more.
    assert len(provider.tutor_prompts()) == practice.MAX_ATTEMPTS == 2 and len(provider.judge_calls()) == 2
    assert "plugs the numbers in" in provider.tutor_prompts()[1]
    assert [(d.kind, d.reason, d.values) for d in out.rejected_drafts] == [
        ("judge", "plugs the numbers in", []),
        ("judge", "still plugs them in", []),
    ]


def test_the_route_returns_rejected_drafts_only_to_the_eval():
    body = confirm_request().model_dump(mode="json")

    def call(headers):
        provider = Scripted([reply(LATER_ANSWER_CONFIRM, rung=0, kind=None), reply(CLEAN_CONFIRM, rung=0, kind=None)])
        with use(provider):
            return TestClient(app).post("/tutor/practice", json=body, headers=headers)

    plain = call({})
    assert plain.status_code == 200 and "rejected_drafts" not in plain.json() and "99 marbles" not in plain.text
    kept = call({"x-margins-eval": "1"}).json()["rejected_drafts"]
    assert kept[0]["draft"] == LATER_ANSWER_CONFIRM and kept[0]["values"] == ["99"] and kept[0]["kind"] == "string"


# ---- false positives from the live run: number words and yes/no in ordinary prose, and a cut that drops the closing question


@pytest.mark.asyncio
async def test_a_number_word_answer_in_ordinary_prose_goes_to_the_judge_not_the_string_check():
    steps = [step("How many sets are there?", "2", ["two"], 0, HINTS_1), step("Which is larger?", "A", [], None, [])]
    text = "Look at the two sets side by side. Which one has more elements, and how do you know?"
    provider = Scripted([reply(text, rung=1)])
    with use(provider):
        out = await tutor_reply(request(steps=steps, step_index=0, rung_allowed=1))
    assert out.reply == text and out.leaked is False and len(provider.judge_calls()) == 1
    # The digit form is still a value that is checked.
    again = Scripted([reply("There are 2 of them, so compare.", rung=1), reply("Look at the sets side by side. What do you see?", rung=1)])
    with use(again):
        out = await tutor_reply(request(steps=steps, step_index=0, rung_allowed=1))
    assert out.leaked is True and out.rejected_drafts[0].values == ["2"]


def test_the_authored_hint_check_still_holds_a_number_word():
    from app.services.tutor.leak import string_leak

    assert string_leak("Answer: eight", ["8", "eight"], 0) is True
    assert string_leak("Answer: eight", ["8", "eight"], 0, prose_words_to_judge=True) is False
    assert string_leak("It is 8.", ["8", "eight"], 0, prose_words_to_judge=True) is True


def test_a_long_reply_keeps_its_closing_question_and_loses_lead_in_instead():
    lead = " ".join(f"Point number {n} is about the draws in the bag." for n in range(1, 9))  # 80 words
    text = lead + " Which draw changes the bag, and why?"
    limited = practice.limit_reply(text)
    assert limited.endswith("Which draw changes the bag, and why?") and len(limited.split()) <= 80
    assert limited.startswith("Point number 1 is about")
    # A reply whose question is already inside the limit is untouched, and a reply with no question is cut as before.
    assert practice.limit_reply("Good start. Which draw changes the bag?") == "Good start. Which draw changes the bag?"
    assert not practice.limit_reply(lead + " Then you are done.").endswith("done.")

