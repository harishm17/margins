import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { eventsForToolOutput } from './tool-events'
import { VOICE_TOOLS, toolsForStyle } from './tools'

describe('eventsForToolOutput', () => {
  it('a question becomes a question event with options for multiple choice', () => {
    const events = eventsForToolOutput(
      'get_next_question',
      {
        done: false,
        question_index: 3,
        question: {
          question_text: 'Which?',
          question_type: 'multiple_choice',
          options: [{ id: 'A', text: 'One' }, { id: 'B', text: 'Two' }],
          concepts_tested: ['x'],
        },
      },
      10
    )
    assert.deepEqual(events, [
      {
        type: 'question',
        index: 3,
        total: 10,
        text: 'Which?',
        questionType: 'multiple_choice',
        options: [{ id: 'A', text: 'One' }, { id: 'B', text: 'Two' }],
      },
    ])
  })

  it('a finished drill becomes session_complete, from either tool', () => {
    assert.deepEqual(eventsForToolOutput('get_next_question', { done: true, message: 'Drill complete.' }, 4), [{ type: 'session_complete' }])
    assert.deepEqual(eventsForToolOutput('record_answer', { done: true, message: 'Drill complete.' }, 4), [{ type: 'session_complete' }])
  })

  it('a graded answer becomes an evaluation', () => {
    assert.deepEqual(
      eventsForToolOutput('record_answer', { is_correct: true, score: 0.8, feedback: { comment: 'Nice', explanation: 'Because' } }, 4),
      [{ type: 'evaluation', isCorrect: true, score: 0.8, comment: 'Nice', explanation: 'Because' }]
    )
  })

  it('errors and unknown tools produce no events', () => {
    assert.deepEqual(eventsForToolOutput('record_answer', { error: 'Grading is unavailable' }, 4), [])
    assert.deepEqual(eventsForToolOutput('get_hint', { error: 'Question not found' }, 4), [])
    assert.deepEqual(eventsForToolOutput('mystery', { hint: 'x' }, 4), [])
  })
})

describe('toolsForStyle', () => {
  it('gives each style its own tools and a topic conversation none', () => {
    assert.deepEqual(toolsForStyle('oral_quiz'), VOICE_TOOLS)
    // The oral quiz has the three drill tools, with no session id for the model to supply.
    assert.deepEqual(VOICE_TOOLS.map((tool) => tool.name), ['get_next_question', 'record_answer', 'get_hint'])
    for (const tool of VOICE_TOOLS) {
      assert.equal(tool.input_schema.type, 'object')
      assert.ok(!('session_id' in tool.input_schema.properties))
      assert.ok(tool.description.length > 20)
    }
    assert.deepEqual(VOICE_TOOLS[1].input_schema.required, ['question_index'])
    assert.deepEqual(toolsForStyle('teach_back').map((tool) => tool.name), ['get_concept_to_explain', 'assess_explanation', 'record_check'])
    assert.deepEqual(toolsForStyle('guided_reading').map((tool) => tool.name), ['next_claim', 'record_check'])
    assert.deepEqual(toolsForStyle('topic_conversation'), [])
    for (const style of ['teach_back', 'guided_reading'] as const) {
      for (const tool of toolsForStyle(style)) {
        assert.ok(!('session_id' in tool.input_schema.properties) && !('user_id' in tool.input_schema.properties), tool.name)
        assert.ok(tool.description.length > 20)
      }
    }
    const check = toolsForStyle('teach_back')[2].input_schema.required
    assert.deepEqual(check, ['concept_id', 'question'])
    assert.deepEqual(toolsForStyle('guided_reading')[1].input_schema.required, ['claim_index'])
  })


  it('none takes the student\'s words as an argument: the server heard them', () => {
    const everyTool = [...VOICE_TOOLS, ...toolsForStyle('teach_back'), ...toolsForStyle('guided_reading')]
    for (const tool of everyTool) {
      for (const name of ['user_answer', 'answer', 'explanation', 'prediction']) {
        assert.ok(!(name in tool.input_schema.properties), `${tool.name} takes ${name}`)
      }
    }
  })
})
