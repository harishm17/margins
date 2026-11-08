/** The part of an mdast tree (the markdown tree remark plugins work on) this plugin looks at. */
export type MdNode = {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string }
}

const OPEN = /^<(sup|sub|u)>$/i
const BREAK = /^<br\s*\/?>$/i
const ONLY_BREAKS = /^(?:\s*<br\s*\/?>\s*)+$/i
/** Where a line break means nothing: between blocks, not inside a paragraph or a table cell. */
const FLOW = new Set(['root', 'blockquote', 'listItem'])

/**
 * The PDF reader writes superscripts, subscripts, underlines and the line breaks inside table cells as HTML
 * ("n<sup>2</sup>", "Input<br>size"). Markdown shows raw HTML as text, so a student would read the tags. This turns the
 * three tags and the break into the elements they stand for, and nothing else: any other tag is still shown as text,
 * so no page can bring its own markup in.
 */
export function remarkInlineHtml() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      const kids = node.children
      if (!kids) return
      kids.forEach(walk)
      const out: MdNode[] = []
      for (let i = 0; i < kids.length; i += 1) {
        const child = kids[i]
        const value = child.type === 'html' ? (child.value ?? '').trim() : ''
        const open = OPEN.exec(value)
        if (open) {
          const tag = open[1].toLowerCase()
          const close = kids.findIndex((candidate, j) => j > i && candidate.type === 'html' && (candidate.value ?? '').trim().toLowerCase() === `</${tag}>`)
          if (close !== -1) {
            // An emphasis node, renamed: its children are converted like any other, and it comes out as the tag.
            out.push({ type: 'emphasis', data: { hName: tag }, children: kids.slice(i + 1, close) })
            i = close
            continue
          }
        }
        if (BREAK.test(value) || ONLY_BREAKS.test(value)) {
          if (!FLOW.has(node.type)) out.push({ type: 'break' })
          continue
        }
        out.push(child)
      }
      node.children = out
    }
    walk(tree)
  }
}
