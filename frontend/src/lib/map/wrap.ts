/** A concept name broken into at most `maxLines` lines of about `width` characters, for a map node (SVG text does not wrap). */
export function wrapName(name: string, width: number, maxLines: number): string[] {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= width || current === '') current = next
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  const shown = lines.slice(0, maxLines)
  const cut = lines.length > maxLines
  return shown.map((line, index) => {
    const last = index === shown.length - 1
    if (line.length > width) return `${line.slice(0, width - 1)}…`
    return last && cut ? `${line.slice(0, Math.max(0, width - 1)).trimEnd()}…` : line
  })
}
