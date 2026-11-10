/**
 * SW2: model-written text that reached the page unrendered. `unrenderedText` judges one block's visible text,
 * maths and code already left out (page-checks.ts collects it). Each finding names what is wrong and quotes it.
 */

const IDEA_STATES = /(?: (?:Not started|Inferred|Shaky|Getting there|Solid|Fading))?(?: (?:Start here|Next up))?$/

/** SW3: an idea's name from its map node's accessible name ("<name> <state> [Start here|Next up]"). */
export function conceptNameOf(node: string): string {
  return node.replace(IDEA_STATES, '').trim()
}

const SENTENCE_WORDS = ['about', 'on', 'at', 'of', 'with', 'missed', 'explain', 'Explain', 'Re-read', 'Read', 'Practice', 'Practise', 'Review', 'Learn']

/**
 * SW3: places where a sentence uses an idea's name (an ability: "Compute a sample mean") as a noun, right after a
 * word that needs one ("about", "missed", "Re-read"). A label ("Next question: Compute ...") or the name on its own
 * reads right.
 */
export function misusedConcepts(text: string, names: string[]): string[] {
  const found: string[] = []
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const match of text.matchAll(new RegExp(`(?:^|[^\\w-])(${SENTENCE_WORDS.join('|')}) ${escaped}`, 'g'))) {
      found.push(`"${match[1]} ${name}"`)
    }
  }
  return [...new Set(found)]
}

const RAW_MATHS =[/\$[^$\n]*[\\^_{}][^$\n]*\$/, /\$[a-zA-Z]\$/, /\\(?:frac|sqrt|sum|prod|cdot|leq?|geq?|neq|times|log|Theta|Omega|mathcal|mathbb|infty|lfloor|lceil)\b/]
const MARKDOWN = [/\*\*[^*\n]+\*\*/, /__[^_\n]+__/]

export function unrenderedText(block: string): string[] {
  const found: string[] = []
  for (const pattern of RAW_MATHS) {
    const match = block.match(pattern)
    if (match) {
      found.push(`raw maths: "${match[0]}"`)
      break
    }
  }
  for (const pattern of MARKDOWN) {
    const match = block.match(pattern)
    if (match) found.push(`markdown: "${match[0]}"`)
  }
  // Two numbered items in a row inside one block: a list the renderer ran into a paragraph.
  const items = [...block.matchAll(/(?:^|[.?!:]\s+)(\d{1,2})\.\s+(?=[A-Z])/g)]
  for (let i = 0; i + 1 < items.length; i++) {
    if (Number(items[i + 1][1]) === Number(items[i][1]) + 1) {
      const start = (items[i].index ?? 0) + items[i][0].indexOf(items[i][1])
      found.push(`list run together: "${block.slice(start, start + 120)}"`)
      break
    }
  }
  return found
}
