/**
 * The account behind the settings page: who is signed in and how, and deleting the account with
 * the real database and storage (the steps and their order are in lib/account/deletion).
 *
 * What goes with the account row. Every table reaches users through ON DELETE CASCADE, either
 * directly (user_id) or through a course (project_id) and its children:
 *   users -> projects -> materials -> material_chunks -> topic_chunk_mappings, topic_sources
 *                     -> topics -> topic_content, topic_quizzes, topic_progress, quiz_attempts,
 *                                  practice_progress, review_schedules, topic_sources, ...
 *                     -> units, overall_quizzes -> overall_quiz_attempts,
 *                        sample_exams -> exam_submissions, chat_threads -> chat_messages,
 *                        voice_drill_sessions -> voice_drill_attempts, learning_signals,
 *                        processing_jobs
 *   users -> processing_jobs, topic_progress, quiz_attempts, overall_quiz_attempts,
 *            exam_submissions, voice_drill_sessions, voice_drill_attempts, learning_signals,
 *            review_schedules, practice_progress, chat_threads
 * The one exception is llm_usage_events (ON DELETE SET NULL): its rows are kept, unlinked, so the
 * global daily cap still counts the money. ai_status is global and holds nothing per user.
 */

import { prisma } from '@/lib/db/prisma'
import { deleteAccount, type DeletionResult, type DeletionStore } from '@/lib/account/deletion'
import { deleteFile, deleteUserFiles } from '@/lib/storage/gcs'

export type AccountDetails = {
  email: string
  name: string | null
  /** 'google' when the account signs in with Google. */
  signInProvider: string | null
}

export async function getAccountDetails(userId: string): Promise<AccountDetails | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, oauthProvider: true },
  })
  return user ? { email: user.email, name: user.name, signInProvider: user.oauthProvider } : null
}

/** The error a stopped job carries. Nobody sees it: the account and the job go together. */
export const ACCOUNT_DELETED_CODE = 'ACCOUNT_DELETED'

const store: DeletionStore = {
  async accountExists(userId) {
    return (await prisma.user.count({ where: { id: userId } })) > 0
  },

  async stopJobs(userId) {
    // Failed and not retryable: the AI service claims only pending jobs (and processing ones whose
    // lease ran out), the reaper re-dispatches only those, and a worker that is running loses its
    // lease at its next heartbeat.
    const { count } = await prisma.processingJob.updateMany({
      where: { OR: [{ userId }, { project: { userId } }], status: { in: ['pending', 'processing'] } },
      data: {
        status: 'failed',
        errorCode: ACCOUNT_DELETED_CODE,
        errorMessage: 'The account was deleted.',
        retryable: false,
        leaseUntil: null,
        completedAt: new Date(),
      },
    })
    return count
  },

  async storedFilePaths(userId) {
    const materials = await prisma.material.findMany({
      where: { project: { userId } },
      select: { gcsPath: true },
    })
    return materials.map((material) => material.gcsPath)
  },

  async removeAccount(userId) {
    const [, removed] = await prisma.$transaction([
      // Kept for the global daily cap, with nothing left that points back at the account.
      prisma.llmUsageEvent.updateMany({
        where: { userId },
        data: { userId: null, projectId: null, sourceId: '' },
      }),
      // deleteMany, not delete: a row that is already gone is not an error.
      prisma.user.deleteMany({ where: { id: userId } }),
    ])
    return removed.count > 0
  },
}

/** Deletes the account and everything it owns. Throws AccountDeletionError when a step fails. */
export function deleteUserAccount(userId: string): Promise<DeletionResult> {
  return deleteAccount(userId, { store, files: { deleteFile, deleteUserFiles } })
}
