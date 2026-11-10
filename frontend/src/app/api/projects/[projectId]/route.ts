/**
 * API route for project management
 * GET /api/projects/[projectId] - Get project details
 * PATCH /api/projects/[projectId] - Update project
 * DELETE /api/projects/[projectId] - Delete project
 */

import { logServerError } from '@/lib/ops/log'
import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { z } from 'zod'
import { storedFolderPath } from '@/lib/storage/files'
import { deleteQueuedFilesNow, queueFileDeletions } from '@/lib/storage/pending-deletions'
import { dailyMinutesSchema, examDateColumn, examDateSchema } from '@/lib/learning/plan-settings'

const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  status: z.enum(['setup', 'topics_pending', 'active', 'completed']).optional(),
  // The exam date (YYYY-MM-DD, or null to clear it), the minutes to study each day, and whether the
  // "When is your exam?" card was closed.
  examDate: examDateSchema.optional(),
  dailyMinutes: dailyMinutesSchema.optional(),
  examPromptDismissed: z.boolean().optional(),
})

// Kept for API clients; the UI reads this through server queries.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await requireAuth()
    const { projectId } = await params

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: session.user.id,
      },
      include: {
        _count: {
          select: {
            materials: true,
            topics: true,
          },
        },
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ project })
  } catch (error) {
    logServerError('Fetch project error', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to fetch project' },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { projectId } = await params

    // Verify ownership
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

    const validation = await readJson(request, updateProjectSchema)
    if (!validation.ok) return validation.response

    const updatedProject = await prisma.project.update({
      where: { id: projectId },
      data: { ...validation.data, examDate: examDateColumn(validation.data.examDate) },
    })

    return NextResponse.json({ project: updatedProject })
  } catch (error) {
    logServerError('Update project error', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to update project' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await requireAuth()
    const limited = await enforceMutationLimit(session.user.id)
    if (limited) return limited
    const { projectId } = await params

    // Verify ownership
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

    // Note the stored files before the rows that point to them are gone.
    const materials = await prisma.material.findMany({
      where: { projectId },
      select: { gcsPath: true },
    })

    // Delete the project (cascade will handle all related records) and queue its files and its folder in the same
    // transaction, so the database is either fully deleted with the files promised for removal, or untouched.
    const queued = await prisma.$transaction(async (tx) => {
      await tx.project.delete({ where: { id: projectId } })
      return queueFileDeletions(
        tx,
        [...materials.map((material) => material.gcsPath), storedFolderPath(`${session.user.id}/${projectId}/`)],
        'project_deleted'
      )
    })

    // Then try the files right away; whatever fails stays queued for the AI service's reaper to retry.
    try {
      await deleteQueuedFilesNow(queued)
      const { deleteProjectFolder } = await import('@/lib/storage/files')
      // The local uploads folder too (uploads made before a bucket was set up); the queue covers the bucket.
      await deleteProjectFolder(session.user.id, projectId)
    } catch (storageError) {
      logServerError('Course deleted, but its files could not be cleaned up yet', storageError, { projectId })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    logServerError('Delete project error', error)

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to delete project' },
      { status: 500 }
    )
  }
}
