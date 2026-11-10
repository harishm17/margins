import { logServerError } from '@/lib/ops/log'
import { readSession } from '@/lib/auth/get-session'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { fileDeleteImpact } from '@/lib/materials/delete-impact'

export const dynamic = 'force-dynamic'

/**
 * GET /api/materials/[materialId]/delete-impact
 *
 * What deleting (or replacing) this file does to the student's work, as counts for the confirm dialog:
 * 200: { notes, ideas } - notes on the file that are kept; ideas taken only from it that leave recall checks.
 * Another student's file answers 404 like an unknown id.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ materialId: string }> }) {
  try {
    const session = await readSession()
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { materialId } = await params
    const material = await prisma.material.findFirst({
      where: { id: materialId, project: { userId: session.user.id } },
      select: { id: true, projectId: true },
    })
    if (!material) return NextResponse.json({ error: 'Material not found' }, { status: 404 })
    return NextResponse.json(await fileDeleteImpact(prisma, material))
  } catch (error) {
    logServerError('Error reading what deleting a file does', error)
    return NextResponse.json({ error: 'Failed to read the file' }, { status: 500 })
  }
}
