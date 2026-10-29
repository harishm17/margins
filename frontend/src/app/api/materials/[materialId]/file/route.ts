import { Readable } from 'node:stream'
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import prisma from '@/lib/prisma'
import {
  contentDisposition,
  contentTypeForFilename,
  isInlineContentType,
  parseByteRange,
} from '@/lib/http/file-response'
import { openStoredFile } from '@/lib/storage/files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The uploaded file behind a chat citation. Only the owner of the material's project can
 * read it; anyone else (or an unknown id) gets the same 404. PDFs are shown inline so the
 * browser can open them at `#page=N`; other types download. Byte ranges are supported so a
 * large PDF can open before it has fully arrived.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { materialId } = await params
  const material = await prisma.material.findFirst({
    where: { id: materialId, project: { userId: session.user.id } },
    select: { filename: true, gcsPath: true },
  })
  if (!material?.gcsPath) {
    return NextResponse.json({ error: 'Material not found' }, { status: 404 })
  }

  let stored
  try {
    stored = await openStoredFile(material.gcsPath)
  } catch (error) {
    console.error('Could not open material file:', error)
    return NextResponse.json({ error: 'The file could not be read right now' }, { status: 502 })
  }
  if (!stored) {
    return NextResponse.json({ error: 'The stored file was not found' }, { status: 404 })
  }

  const contentType = contentTypeForFilename(material.filename)
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition(
      isInlineContentType(contentType) ? 'inline' : 'attachment',
      material.filename
    ),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  }

  const range = parseByteRange(req.headers.get('range'), stored.size)
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stored.size}` } })
  }

  const nodeStream = stored.stream(range ?? undefined)
  // A client that goes away mid-download must not leave the file open.
  req.signal.addEventListener('abort', () => nodeStream.destroy(), { once: true })
  const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>

  if (range) {
    return new Response(body, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${stored.size}`,
        'Content-Length': String(range.end - range.start + 1),
      },
    })
  }
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(stored.size) } })
}
