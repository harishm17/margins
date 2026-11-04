/**
 * Telling a student that a file they are adding is already in the course. Two files are the same here when their names and sizes match;
 * the server keeps no hash of a file's content, so a renamed copy is not caught (and a different file of the same name and size would be:
 * the student decides, which is why this asks and never refuses).
 */

export type KnownFile = { id: string; filename: string; sizeBytes: number }

export type Incoming = { name: string; size: number }

const sameFile = (a: { name: string; size: number }, b: { name: string; size: number }) => a.name === b.name && a.size === b.size

/**
 * Splits a batch into the files that are new and the ones that match a file already in the course (or an earlier file of the same
 * batch). `known` is every file the course has, and the uploads still on their way. A duplicate lists the files it matches, so a
 * replacement knows which to remove afterwards; a copy within the batch matches none (there is nothing to replace) and is offered
 * a place in the list by its first copy.
 */
export function splitDuplicates<T extends Incoming>(files: T[], known: KnownFile[]): { fresh: T[]; duplicates: { file: T; matches: KnownFile[] }[] } {
  const fresh: T[] = []
  const duplicates: { file: T; matches: KnownFile[] }[] = []
  for (const file of files) {
    const matches = known.filter((item) => sameFile({ name: item.filename, size: item.sizeBytes }, file))
    const inBatch = fresh.some((item) => sameFile(item, file)) || duplicates.some((item) => sameFile(item.file, file))
    if (matches.length > 0 || inBatch) duplicates.push({ file, matches })
    else fresh.push(file)
  }
  return { fresh, duplicates }
}
