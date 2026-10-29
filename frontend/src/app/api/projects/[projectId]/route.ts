/**
 * API route for project management
 * GET /api/projects/[projectId] - Get project details
 * PATCH /api/projects/[projectId] - Update project
 * DELETE /api/projects/[projectId] - Delete project
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { requireAuth } from '@/lib/auth/get-session'
import { z } from 'zod'
import { dailyMinutesSchema, examDateColumn, examDateSchema } from '@/lib/learning/plan-settings'

const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
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
    console.error('Fetch project error:', error)

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

    const body = await request.json()
    const validation = updateProjectSchema.safeParse(body)

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: validation.error },
        { status: 400 }
      )
    }

    const updatedProject = await prisma.project.update({
      where: { id: projectId },
      data: { ...validation.data, examDate: examDateColumn(validation.data.examDate) },
    })

    return NextResponse.json({ project: updatedProject })
  } catch (error) {
    console.error('Update project error:', error)

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

    // Delete project (cascade will handle all related records). One statement, so the
    // database is either fully deleted or untouched.
    await prisma.project.delete({
      where: { id: projectId },
    })

    // Then the uploaded files. Best effort: the project is already deleted, so a storage
    // error is logged for manual cleanup instead of failing the request.
    try {
      const { deleteFilesBestEffort, deleteProjectFolder } = await import('@/lib/storage/files')
      await deleteFilesBestEffort(materials.map((material) => material.gcsPath))
      await deleteProjectFolder(session.user.id, projectId)
    } catch (storageError) {
      console.error(`Project ${projectId} deleted, but its files could not be cleaned up:`, storageError)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete project error:', error)

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
