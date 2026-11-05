/** The line under the file list: what is read, what is still being read, and what needs the student. */
export type MaterialsCounts = {
  /** Files that were read and can be used. */
  ready: number
  /** Files still uploading or being read. */
  working: number
  /** Files that were rejected, could not be read, or had no readable text. */
  needsAttention: number
}

const files = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`

export function materialsSummary({ ready, working, needsAttention }: MaterialsCounts): string {
  const attention = `${files(needsAttention)} ${needsAttention === 1 ? 'needs' : 'need'} attention.`
  if (working > 0) {
    const base = 'You can leave this page. Files keep being read.'
    return needsAttention > 0 ? `${base} ${attention}` : base
  }
  if (needsAttention === 0) return 'Every file here has been read.'
  // The claim "read" is only made for the files that were: a rejected file is never counted in it.
  if (ready === 0) {
    const them = needsAttention === 1 ? 'it' : 'them'
    return `${attention} Remove ${them} or replace ${them} with course files.`
  }
  return `${files(ready)} ready; ${attention}`
}
