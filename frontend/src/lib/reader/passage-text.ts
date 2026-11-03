/**
 * A chunk's text is markdown with the file's own headings (a chapter title is a `#`). On the reader page those
 * headings sit under the page title and the file's name, so every heading goes down one level (to at most h6)
 * and the page's outline stays in order. Lines in code fences, and `#` lines that are not headings, are kept.
 */
export function demoteHeadings(markdown: string, by = 1): string {
  let fenced = false
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced) return line
      const heading = /^(#{1,6})(\s+\S.*)$/.exec(line)
      return heading ? '#'.repeat(Math.min(6, heading[1].length + by)) + heading[2] : line
    })
    .join('\n')
}
