import type { Expected } from './harness/checks'

/**
 * Checks that fail on today's app, each with the plan item that fixes it and the walkthrough finding it shows
 * (IMPLEMENTATION-PLAN.md and FINDINGS.md in the walkthrough notes). A PR that fixes one turns its check green
 * and removes its line here: a listed check that passes fails the workflow, so a fix cannot quietly regress.
 */
export const EXPECTED_FAILURES: Readonly<Record<string, Expected>> = {
  // WF1, a new course
  'WF1.upload-status-not-cut-off': { fixedBy: 'SW6', finding: '43' }, // "Getting your pages ready for study and search, step 3 of 3" ends in an ellipsis
  'WF1.file-order': { fixedBy: 'F6', finding: '4' }, // newest first: quiz-1, scan, lecture-3, lecture-2, lecture-1
  'WF1.one-rename-pattern': { fixedBy: 'U6', finding: '44' }, // a "Rename" button under every topic
  // WF2, the first topic
  'WF2.warm-up.no-percent-yet': { fixedBy: 'SW11', finding: '49' }, // "Learning 0%" on the header, sidebar and overview after three warm-up answers
  'WF2.reading.same-next-step': { fixedBy: 'G5', finding: '11' }, // the plan ticks "Learn <topic>" done after warm-up and reading; the topic says Recall
  'WF2.reading.no-percent-yet': { fixedBy: 'SW11', finding: '49' },
  'WF2.recall.same-next-step': { fixedBy: 'SW9, G5', finding: '10, 11' }, // list "Next: Read that part again", path "Recall (next up) 2/5", plan ticked done
  'WF2.recall-check-kept': { fixedBy: 'SW10', finding: '96' }, // the first prompt comes back empty with "Check my answer"
  'WF2.recall.no-percent-yet': { fixedBy: 'SW11', finding: '49' }, // "Learning 16%" after one written recall and one "I don't remember"
  'WF2.quiz.same-next-step': { fixedBy: 'SW9', finding: '10' }, // after the quiz: list "Next: Read that part again", path "Recall (next up) 2/5"
  'WF2.maths-renders': { fixedBy: 'SW2', finding: '93' }, // Examples: a block at the start of the line ends the numbered list, items 3 and 4 run together
  'WF2.concept-sentences': { fixedBy: 'SW3', finding: '2' }, // "Re-read <idea>" under a worked example, "missed <idea>" on Examples
  'WF2.choice-check-reason': { fixedBy: 'SW1', finding: '95' }, // "Type an answer first." beside radio buttons
  'WF2.no-blank-busy-button': { fixedBy: 'SW1', finding: '6' }, // sign-in, create course, confirm topics, start, warm-up next, show the source, save note
  // WF3, review and drill
  'WF3.weakest-are-studied': { fixedBy: 'G1', finding: '83' }, // voice practice's three weakest topics are all topics the student never opened
  'WF3.focus-mix-ups-once': { fixedBy: 'G7', finding: '82' }, // one answer's mix-up is shown under several ideas of the focus
  'WF3.fix-it-now-wait-estimate': { fixedBy: 'SW7', finding: '80' }, // "Preparing your questions" and a bar, no time
  'WF3.position-second-browser': { fixedBy: 'SW10', finding: '30, 31' }, // a second browser opens the review on the next question, not the feedback
  'WF3.follow-up-wait-estimate': { fixedBy: 'SW7', finding: '53' }, // "This takes a moment" while a fresh question is written
  'WF3.retests-as-announced': { fixedBy: 'S4', finding: '97' }, // the header announced "(+5 to retest)"; three retests came
  'WF3.review-end-one-action': { fixedBy: 'R1', finding: '55' }, // a filled button and an outlined one
  'WF3.drill-end-one-action': { fixedBy: 'R1', finding: '55' }, // a filled button and two outlined ones
  'WF3.practice-confidence': { fixedBy: 'Q3', finding: '88' }, // a practice step's answer options have no "How sure are you?" row
  // WF4, mock exam
  'WF4.form-up-to': { fixedBy: 'U10', finding: '26' }, // "10 questions": nothing says the exam may hold fewer
  'WF4.form-plain-words': { fixedBy: 'C4', finding: '23' }, // "the wording, task verbs and answer length of the exams you uploaded"
  'WF4.build-header': { fixedBy: 'SW7', finding: '25' }, // "New mock exam / Choose what to cover..." stays while the exam is written
  'WF4.build-wait-estimate': { fixedBy: 'SW7', finding: '25' }, // "This takes a few minutes"
  'WF4.exam-order': { fixedBy: 'U8', finding: '28' }, // topics interleaved and out of course order, a choice question after a written one
  'WF4.flag-second-browser': { fixedBy: 'SW10', finding: '30' }, // flags live in the first browser's session storage
  'WF4.position-second-browser': { fixedBy: 'SW10', finding: '31' }, // a second browser opens the exam on question 1
  'WF4.unstudied-folded': { fixedBy: 'SW16', finding: '36' }, // one "Not answered" row per never-opened topic
  'WF4.jump-to-missed': { fixedBy: 'U9', finding: '37' }, // no "Next missed" or "Next not answered"
  'WF4.results-rendered': { fixedBy: 'SW2', finding: '32' }, // a question row's preview strips "$" and shows the LaTeX ("\log")
  'WF4.one-exam-name': { fixedBy: 'U7', finding: '22, 39' }, // the tab titles say "Mock exam", "Taking a mock exam", "Mock exam results"
  // WF5, Ask
  'WF5.tagline-guides': { fixedBy: 'E5', finding: '9' }, // "Answers come only from your files, with sources."
  'WF5.concept-sentences': { fixedBy: 'SW3', finding: '2, 48' }, // "about <idea>" in the intro, "explain <idea>" and "about <idea>" in the suggestions
  // WF6, voice
  'WF6.one-verdict': { fixedBy: 'V2', finding: '69' }, // the evaluation row repeats the coach's words under the chip
  'WF6.next-button': { fixedBy: 'V1', finding: '68' }, // the coach asks whether the student is ready; only a typed "yes" moves on
  'WF6.summary-one-action': { fixedBy: 'R1', finding: '84' }, // "Practice this" filled, "Start again" and the back link outlined
  'WF6.revisit-in-full': { fixedBy: 'R1', finding: '84' }, // the question to revisit is clipped and has no answer
  'WF6.idle-not-counted': { fixedBy: 'V4', finding: '71' }, // wall time counts while the open tab sends heartbeats
  'WF6.start-here-instead': { fixedBy: 'V4', finding: '71' }, // "Another voice practice looks open", with no way to take over
  'WF6.round-size-stated': { fixedBy: 'V5', finding: '83' }, // "Up to 12 questions" for a round that has none
  'WF6.round-can-start': { fixedBy: 'G1', finding: '83' }, // the round's weakest topics are never-opened ones with no quiz, so Start is disabled
  'WF6.unended-closed': { fixedBy: 'V5', finding: '85' }, // the dead tab's session stays active
  'WF6.drill-keeps-set': { fixedBy: 'V5', finding: '81' }, // Quiz me reads only the newest set: 4 questions before Fix it now, 2 after
  // WF7, files
  'WF7.renamed-copy-caught': { fixedBy: 'F1', finding: '73' }, // "lecture-2 (1).pdf" is taken as a new file and read, and topic finding runs again
  'WF7.delete-states-counts': { fixedBy: 'F7', finding: '74' }, // "Existing topic content stays. Links to this file ... will stop opening.", with no counts
  'WF7.note-kept-on-delete': { fixedBy: 'F7', finding: '78' }, // the margin note is deleted with the file
  'WF7.citation-marked': { fixedBy: 'F5', finding: '74' }, // both citations of the deleted file still offer "Open page"
  'WF7.ideas-keep-claims': { fixedBy: 'SW13', finding: '74' }, // 4 of the topic's ideas are left with no claim
  'WF7.replace-says-what-happened': { fixedBy: 'F3', finding: '89' }, // no message after the duplicate dialog's Replace
  'WF7.replace-keeps-claims': { fixedBy: 'F2', finding: '72' }, // 11 claims before, 0 after
  'WF7.replace-keeps-source': { fixedBy: 'F2', finding: '72' }, // the topic no longer reads from the replaced lecture
  'WF7.replace-keeps-note': { fixedBy: 'F2', finding: '78' }, // the margin note is deleted with the old copy
  'WF7.replace-in-menu': { fixedBy: 'F4', finding: '75' }, // only a refused or unread file's menu offers Replace
  'WF7.lost-claims-repaired': { fixedBy: 'F0', finding: '89' }, // there is no repair yet
  // WF8, regenerate
  'WF8.dialogs-say-kept': { fixedBy: 'SW8', finding: '66' }, // notes, examples and practice say only what is replaced; the quiz's "earlier sets and attempts stay" passes
  'WF8.dialogs-say-time-and-share': { fixedBy: 'X4', finding: '65' }, // no dialog says how long it takes or its share of today's allowance
  'WF8.notes-dialog-says-reading': { fixedBy: 'D1', finding: '66' }, // "This replaces your current notes.", nothing on margin notes or the reading done
  'WF8.dialogs-say-which-drafts-go': { fixedBy: 'SW10', finding: '66' }, // neither dialog mentions the student's unsent work
  'WF8.practice-draft-rule': { fixedBy: 'SW10', finding: '66' }, // the working typed on step 1 shows under the new set's step 1: drafts are keyed by the content id, which a regenerate keeps
  // WF9, the allowance
  'WF9.settings-plain-terms': { fixedBy: 'D2', finding: '77' }, // "Available · 10% used · resets at 4:00 PM"
  'WF9.prepare-all-says-share': { fixedBy: 'X4', finding: '77' }, // the dialog says neither how long nor its share of today
  'WF9.one-job-past-limit': { fixedBy: 'S2', finding: 'K4' }, // three topics opened together on the last cent: 3 jobs ran, $0.26 past the limit
  'WF9.same-allowance-state': { fixedBy: 'D2, X4', finding: '77' }, // the regenerate dialog only disables its button; Settings says "Today's allowance used"; topic finding gives no reset time
  // WF10, devices
  'WF10.touch-targets-ipad': { fixedBy: 'SW5', finding: '41' }, // the menu button 34x34, the course's action links 34 px tall, radio chips 30 px: touch sizes are keyed to phone width
  'WF10.cut-off-text-ipad': { fixedBy: 'SW6', finding: '20, 43, 87' }, // topic names clamped on the course page, plan items cut with an ellipsis
  'WF10.cut-off-text-phone': { fixedBy: 'SW6', finding: '20, 43' }, // the same, and "and 1 more task" plan rows
  'WF10.focus-returns': { fixedBy: 'X5', finding: '100' }, // the menu gives focus back to its button, but the Regenerate notes dialog opened from it gives it to the page
  'WF10.palette-focus-returns': { fixedBy: 'X5', finding: '100' }, // closing the command palette leaves the focus on the page
  'WF10.phone-voice-turn-whole': { fixedBy: 'V6', finding: '86' }, // the coach's turn is partly hidden inside the sheet's scrolling strip on a phone

  // WF12, deletion
  'WF12.course-references-cleared': { fixedBy: 'SW13', finding: '101' }, // the course's Ask and practice tutor states stay: TutorState has no course key
  'WF12.course-dialog-once': { fixedBy: 'SW15', finding: '76' }, // "Type the name exactly to confirm" is the field's label and, again, the confirm button's reason
  'WF12.account-dialog-once': { fixedBy: 'U4', finding: '76' }, // "Enter DELETE to confirm" in the description, the field's hint and the confirm button's reason
}
