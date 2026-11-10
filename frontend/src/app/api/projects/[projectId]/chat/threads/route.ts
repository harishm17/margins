import { enforceMutationLimit } from '@/lib/api/rate-limit'
import { assertQuota, quota, quotaErrorResponse, quotaResponse } from '@/lib/api/quota'
import { readJson } from '@/lib/api/read-json'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import prisma from '@/lib/prisma'
import { apiInvalidInput, apiNotFound, apiUnauthorized } from '@/lib/api/errors'
import { MAX_THREAD_TITLE_CHARS } from '@/lib/chat/server'

export const dynamic = 'force-dynamic'

const MAX_THREADS = 100

async function ownedProject(projectId: string) {
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id
  if (!userId) return { userId: null, project: null }
  const project = await prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } })
  return { userId, project }
}

// Kept for API clients; the UI reads this through server queries.
/** GET: this user's conversations in the project, most recently active first. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const { userId, project } = await ownedProject(projectId)
  if (!userId) return apiUnauthorized()
  if (!project) return apiNotFound('Project not found')

  // ?requestId=: which conversation took the question sent with this id, if any (a reload while a send was in flight asks this).
  const requestId = req.nextUrl.searchParams.get('requestId')
  if (requestId !== null) {
    if (!z.string().uuid().safeParse(requestId).success) return apiInvalidInput('Invalid request id')
    const taken = await prisma.chatMessage.findFirst({
      where: { clientRequestId: requestId, thread: { projectId, userId } },
      select: { thread: { select: { id: true, title: true } } },
    })
    return NextResponse.json({ thread: taken?.thread ?? null })
  }

  const threads = await prisma.chatThread.findMany({
    where: { projectId, userId },
    orderBy: { updatedAt: 'desc' },
    take: MAX_THREADS,
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  })
  return NextResponse.json({
    threads: threads.map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
  })
}

const createSchema = z.object({ title: z.string().trim().min(1).max(MAX_THREAD_TITLE_CHARS).optional() })

/** POST: start an empty conversation. (Asking a question without a threadId starts one too.) */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  const { userId, project } = await ownedProject(projectId)
  if (!userId) return apiUnauthorized()
  const limited = await enforceMutationLimit(userId)
  if (limited) return limited
  if (!project) return apiNotFound('Project not found')

  const parsed = await readJson(req, createSchema.default({}))
  if (!parsed.ok) return parsed.response

  let thread
  try {
    thread = await prisma.$transaction(async (tx) => {
      await assertQuota(tx, { id: userId }, 'chatThreads', { projectId })
      return tx.chatThread.create({
        data: { userId, projectId, title: parsed.data.title ?? null },
        select: { id: true, title: true, createdAt: true, updatedAt: true },
      })
    })
  } catch (error) {
    const refused = quotaErrorResponse(error)
    if (refused) return refused
    throw error
  }
  return NextResponse.json(
    {
      thread: {
        id: thread.id,
        title: thread.title,
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      },
    },
    { status: 201 }
  )
}
