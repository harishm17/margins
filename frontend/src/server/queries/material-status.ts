import { prisma } from '@/lib/db/prisma'
import { ACTIVE_JOB_STATUSES } from '@/lib/jobs/active-jobs'

/**
 * How far a file is: the one definition the Materials page rows and the sidebar's setup step both read. A file is being read
 * while it has an active job (or finished validating and its reading has not started), unusable if validation refused it,
 * and failed if its jobs failed.
 */
export type MaterialStatus = 'processing' | 'ready' | 'unusable' | 'failed'

/** `jobs` are the file's validate/chunk jobs, newest first. */
export function materialStatusOf(validationStatus: string, jobs: { status: string }[]): MaterialStatus {
  const active = jobs.find((job) => ACTIVE_JOB_STATUSES.includes(job.status))
  const latest = jobs[0]
  if (validationStatus === 'invalid') return 'unusable'
  if (active) return 'processing'
  if (validationStatus === 'pending') return latest?.status === 'completed' ? 'processing' : 'failed'
  return latest?.status === 'failed' ? 'failed' : 'ready'
}

/** The materialId a validate or chunk job works on. */
export function jobMaterialId(inputData: unknown): string | null {
  if (typeof inputData !== 'object' || inputData === null || Array.isArray(inputData)) return null
  const id = (inputData as Record<string, unknown>).materialId
  return typeof id === 'string' ? id : null
}

/** Ready and being-read file counts of one course, for the setup step shown outside the Materials page. */
export async function materialCounts(userId: string, courseId: string): Promise<{ readyCount: number; processingCount: number }> {
  const [materials, jobs] = await Promise.all([
    prisma.material.findMany({ where: { projectId: courseId, project: { userId } }, select: { id: true, validationStatus: true } }),
    prisma.processingJob.findMany({
      where: { projectId: courseId, userId, jobType: { in: ['validate_material', 'chunk_material'] } },
      orderBy: { createdAt: 'desc' },
      take: 400,
      select: { status: true, inputData: true },
    }),
  ])
  const byMaterial = new Map<string, { status: string }[]>()
  for (const job of jobs) {
    const id = jobMaterialId(job.inputData)
    if (!id) continue
    const list = byMaterial.get(id)
    if (list) list.push(job)
    else byMaterial.set(id, [job])
  }
  const statuses = materials.map((material) => materialStatusOf(material.validationStatus, byMaterial.get(material.id) ?? []))
  return {
    readyCount: statuses.filter((status) => status === 'ready').length,
    processingCount: statuses.filter((status) => status === 'processing').length,
  }
}
