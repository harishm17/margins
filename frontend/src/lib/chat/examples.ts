/** Example questions for the empty chat, built from the project's topic names. */

/**
 * The topic name goes in quotes. Names are written as titles ("Conditional probability", "TCP
 * handshake"), so pasted mid-sentence as they are they read like a capitalization slip, and
 * lower-casing them would break acronyms and proper names. Quoted, any name reads correctly.
 */
const quoted = (topic: string) => `“${topic}”`

const TOPIC_TEMPLATES = [
  (topic: string) => `Ask me to explain ${quoted(topic)} in my own words, then check what I say.`,
  (topic: string) => `Give me a question on ${quoted(topic)} to try, then check my answer.`,
  (topic: string) => `What should I look for before I read about ${quoted(topic)}?`,
]

const GENERIC_QUESTIONS = [
  'Give me a question from my materials to try first, then check my answer.',
  'Ask me to explain an idea from my materials in my own words, then check it.',
  'What should I look for before I start reading my materials?',
]

/** Up to `count` example questions: one per topic (first topics first), then generic ones. */
export function exampleQuestions(topicNames: readonly string[], count = 3): string[] {
  const names = topicNames.map((name) => name.trim()).filter(Boolean)
  const questions = names.slice(0, count).map((name, index) => TOPIC_TEMPLATES[index % TOPIC_TEMPLATES.length](name))
  for (const generic of GENERIC_QUESTIONS) {
    if (questions.length >= count) break
    questions.push(generic)
  }
  return questions
}
