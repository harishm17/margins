/**
 * Which job a dispatch that never reached the AI service may fail (ENQUEUE_FAILED). The same rule
 * as the AI service's own dispatcher (ai-service app/services/cloud_tasks.py `mark_undelivered`):
 * only a job no handler has touched, pending and never started.
 *
 * Everything else belongs to the AI service's reaper. A job back in `pending` after a passing
 * failure has attempts left and is waiting for its retry; a `processing` job whose lease ran out
 * lost its worker and is sent again (or failed with JOB_LEASE_EXPIRED once its attempts are used).
 * Failing either here would end work that can still finish.
 */

export function undeliveredWhere(jobId: string) {
  return { id: jobId, status: 'pending', startedAt: null }
}
