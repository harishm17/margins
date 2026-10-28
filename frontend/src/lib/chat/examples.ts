/** Example questions for the empty chat, built from the project's topic names. */

/**
 * The topic name goes in quotes. Names are written as titles ("Conditional probability", "TCP
 * handshake"), so pasted mid-sentence as they are they read like a capitalisation slip, and
 * lower-casing them would break acronyms and proper names. Quoted, any name reads correctly.
 */
const quoted = (topic: string) => `“${topic}”`

const TOPIC_TEMPLATES = [
  (topic: string) => `Explain ${quoted(topic)} in simple terms.`,
  (topic: string) => `What are the key points about ${quoted(topic)}?`,
  (topic: string) => `Give me an example that shows ${quoted(topic)}.`,
]

const GENERIC_QUESTIONS = [
  'Summarize the main ideas in my materials.',
  'Which concepts are most likely to show up on an exam?',
  'What definitions should I memorize?',
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
