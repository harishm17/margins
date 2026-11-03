/** The student's zone from the browser's cookie; UTC when there is no request (a job, a test). Server only. */
export async function studentTimeZone(): Promise<string> {
  try {
    const { getTimeZone } = await import('@/server/timezone')
    return await getTimeZone()
  } catch {
    return 'UTC'
  }
}
