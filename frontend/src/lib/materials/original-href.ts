import { viewerUrl } from '@/lib/chat/citations'

/**
 * Where a student's original file opens: a PDF at the first page of the range, any other type from the start. Null for a
 * source with no file id (content written before sources linked to files). One helper for the topic editor's "Taught from"
 * note and the reader's "Open the original" links, so both open the same place.
 */
export function originalHref(source: { materialId: string | null; filename: string; pageStart: number | null }): string | null {
  return source.materialId ? viewerUrl({ materialId: source.materialId, filename: source.filename, pageStart: source.pageStart }) : null
}
