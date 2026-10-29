/**
 * API route for material uploads
 * POST /api/projects/[projectId]/materials?category=lecture_notes&filename=notes.pdf
 * (category: lecture_notes, book_chapters, sample_exams or syllabus)
 *
 * The request body is the file itself (not multipart), so it can be checked and streamed to
 * storage without being held in memory. The size limit (MAX_UPLOAD_MB, default 25) is judged
 * from Content-Length before any of the body is read.
 */

import { Readable } from 'stream'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { uploadStream, generateMaterialPath, deleteFile, recordStoredFile } from '@/lib/storage/files'
import {
  IncompleteUploadError,
  InvalidSignatureError,
  UploadTooLargeError,
  checkContentLength,
  createSignatureCheck,
  createSizeLimiter,
  maxUploadBytes,
} from '@/lib/storage/upload-limits'
import { enqueueValidationJob, TaskEnqueueError } from '@/lib/tasks/dispatch'
import { z } from 'zod'
import { roleForCategory } from '@/lib/materials/role'

const uploadSchema = z.object({
  category: z.enum(['lecture_notes', 'sample_exams', 'book_chapters', 'syllabus']),
})

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.doc'])

function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex === -1) return ''
  return filename.slice(dotIndex).toLowerCase()
}

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/octet-stream', // Common fallback from browsers/OS integrations
  '',
])

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    // 1. Authenticate user
    const session = await requireAuth()
    const { projectId } = await params

    // 2. Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: session.user.id,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // 3. Validate input from the URL and headers: nothing here touches the body.
    const query = request.nextUrl.searchParams
    const filename = (query.get('filename') || '').trim()
    const validation = uploadSchema.safeParse({ category: query.get('category') })
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid category', details: validation.error },
        { status: 400 }
      )
    }
    if (!filename) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    const mimeType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (mimeType.startsWith('multipart/')) {
      return NextResponse.json(
        { error: 'Send the file as the request body, not as a form' },
        { status: 415 }
      )
    }

    const extension = getExtension(filename)
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return NextResponse.json(
        { error: 'Unsupported file type. Supported: PDF, DOCX, PPTX, DOC' },
        { status: 400 }
      )
    }
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return NextResponse.json(
        { error: 'Invalid MIME type for selected document' },
        { status: 400 }
      )
    }

    // 4. Judge the size from Content-Length, before reading any of the body.
    const maxBytes = maxUploadBytes()
    const lengthCheck = checkContentLength(request.headers.get('content-length'), maxBytes)
    if (!lengthCheck.ok) {
      return NextResponse.json({ error: lengthCheck.message }, { status: lengthCheck.status })
    }
    if (!request.body) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    // 5. Stream the body to storage, checking the size and the file signature on the way.
    // Storage is written first so a failed upload leaves no orphaned database record.
    const { randomUUID } = await import('crypto')
    const materialId = randomUUID()
    const gcsPath = generateMaterialPath(session.user.id, projectId, materialId, filename)
    const limiter = createSizeLimiter(maxBytes, lengthCheck.length)

    let storedPath: string
    try {
      storedPath = await uploadStream(
        Readable.fromWeb(request.body as import('stream/web').ReadableStream),
        gcsPath,
        mimeType,
        [createSignatureCheck(extension), limiter.stream]
      )
    } catch (error) {
      if (error instanceof UploadTooLargeError) {
        return NextResponse.json({ error: error.message }, { status: 413 })
      }
      if (error instanceof InvalidSignatureError) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
      if (error instanceof IncompleteUploadError) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
      throw error
    }
    const fileSize = limiter.bytesSeen()

    // 8. The material and its validation job, together, only after the upload succeeded. If they
    // can't be written (the course or the account was deleted meanwhile, or anything else), the
    // stored file is deleted too, so nothing is left that no row points at.
    const { material, job } = await recordStoredFile(storedPath, () =>
      prisma.$transaction(async (tx) => {
        const material = await tx.material.create({
          data: {
            id: materialId,
            projectId,
            category: validation.data.category,
            // Past exams and syllabi are known now; the validator sets the role of everything else.
            role: roleForCategory(validation.data.category),
            filename,
            sizeBytes: BigInt(fileSize),
            validationStatus: 'pending',
            gcsPath: storedPath,
            metadata: {
              mimeType: mimeType || null,
              extension,
            },
          },
        })

        const job = await tx.processingJob.create({
          data: {
            userId: session.user.id,
            projectId,
            jobType: 'validate_material',
            status: 'pending',
            stage: 'validating',
            inputData: { materialId: material.id },
            progressPercent: 0,
          },
        })
        return { material, job }
      })
    )

    // 10. Enqueue validation task
    try {
      await enqueueValidationJob(job.id, material.id)
    } catch (enqueueError) {
      const retryable = enqueueError instanceof TaskEnqueueError
        ? enqueueError.retryable
        : true
      await prisma.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          errorCode: retryable ? 'ENQUEUE_FAILED' : 'ENQUEUE_PERMANENT',
          errorMessage: 'Failed to enqueue validation job',
          retryable,
          completedAt: new Date(),
        },
      })

      // Best-effort cleanup to avoid keeping unprocessable artifacts.
      try {
        await deleteFile(storedPath)
      } catch (cleanupError) {
        console.warn('Failed to delete uploaded file after enqueue failure:', cleanupError)
      }

      await prisma.material.delete({
        where: { id: material.id },
      })

      return NextResponse.json(
        { error: 'Failed to start material validation' },
        { status: 502 }
      )
    }

    // 11. Return response
    return NextResponse.json({
      material: {
        id: material.id,
        filename: material.filename,
        category: material.category,
        role: material.role,
        sizeBytes: material.sizeBytes.toString(),
        validationStatus: material.validationStatus,
        uploadedAt: material.uploadedAt,
      },
      jobId: job.id,
    })
  } catch (error) {
    console.error('Material upload error:', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to upload material' },
      { status: 500 }
    )
  }
}

// Kept for API clients; the UI reads this through server queries.
/**
 * GET /api/projects/[projectId]/materials
 * List all materials for a project
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await requireAuth()
    const { projectId } = await params

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: session.user.id,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Fetch materials
    const materials = await prisma.material.findMany({
      where: { projectId },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        filename: true,
        category: true,
        role: true,
        sizeBytes: true,
        validationStatus: true,
        validationNotes: true,
        uploadedAt: true,
        validatedAt: true,
      },
    })

    return NextResponse.json({
      materials: materials.map(m => ({
        ...m,
        sizeBytes: m.sizeBytes.toString(),
      })),
    })
  } catch (error) {
    console.error('Fetch materials error:', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to fetch materials' },
      { status: 500 }
    )
  }
}
