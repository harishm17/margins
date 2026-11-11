import { expect, type Page } from '@playwright/test'
import { withPrisma } from '../../e2e/helpers/db'

/** "Question 2 of 7" as { at: 2, of: 7 }; null when the progress line names no question (the coach is still opening). */
export function progressOf(text: string): { at: number; of: number } | null {
  const match = /^Question (\d+) of (\d+)/.exec(text.trim())
  return match ? { at: Number(match[1]), of: Number(match[2]) } : null
}

/** The number of questions a quick round's lobby says it has ("No questions to ask yet." is none); null when it states no number. */
export function statedRoundSize(line: string): number | null {
  if (/^No questions\b/.test(line.trim())) return 0
  const match = /(\d+) questions?\b/.exec(line)
  return match ? Number(match[1]) : null
}

/** What a student uses in the voice lobby, in a session and on its summary. */
export function voiceScreen(page: Page) {
  const lobby = page.getByTestId('voice-lobby')
  const session = page.getByTestId('voice-session')
  const progress = page.getByTestId('voice-progress')
  const box = page.getByLabel('Type your answer')
  // Disabled while the coach's turn runs, so enabled again once the reply is whole.
  const hint = session.getByRole('button', { name: 'Hint', exact: true })
  const transcript = page.getByTestId('voice-transcript').last()

  /** Answers by typing: a browser that cannot listen offers typing only, with no choice to make. */
  async function chooseTyping() {
    const typing = lobby.getByRole('radiogroup', { name: 'How you answer' }).getByRole('radio', { name: 'Type answers instead' })
    if (await typing.count()) await typing.click()
  }

  /** Sends `text` as the student's typed answer and waits until the coach's reply to it is whole. */
  async function send(text: string) {
    await box.fill(text)
    await session.getByRole('button', { name: 'Send', exact: true }).click()
    const mine = transcript.locator('li').filter({ has: page.getByText(text, { exact: true }) }).last()
    const reply = mine.locator('xpath=following-sibling::li[@data-testid="voice-coach-turn"][1]')
    await expect(reply).toBeVisible({ timeout: 2 * 60_000 })
    await expect(hint).toBeEnabled({ timeout: 2 * 60_000 })
    return reply
  }

  return {
    lobby,
    session,
    progress,
    summary: page.getByTestId('voice-summary'),
    /** The lobby's one start button: it reads "Start here instead" while a voice practice is open somewhere else. */
    start: lobby.getByRole('button', { name: /^Start (voice practice|here instead)$/ }),
    /** Waits until the lobby knows the day's minutes (and whether a voice practice is open elsewhere), so Start is settled. */
    async settled() {
      await expect(lobby.getByText(/min left today$/)).toBeVisible({ timeout: 60_000 })
    },
    question: page.getByTestId('voice-question'),
    send,
    chooseTyping,
    /** Quiz me on a topic, answered by typing. */
    async chooseTypedQuiz() {
      await expect(lobby).toBeVisible({ timeout: 60_000 })
      const quizMe = lobby.getByRole('radiogroup', { name: 'Style' }).getByRole('radio', { name: /^Quiz me/ })
      if (await quizMe.count()) await quizMe.click()
      await chooseTyping()
    },
    /** The question on screen, once the coach has asked one. */
    async place() {
      await expect(progress).toHaveText(/^Question \d+ of \d+/, { timeout: 2 * 60_000 })
      return progressOf((await progress.textContent()) ?? '')!
    },
    /** Waits until the coach's opening turn is whole, so the session takes an answer. */
    async ready() {
      await expect(box).toBeVisible({ timeout: 2 * 60_000 })
      await expect(hint).toBeEnabled({ timeout: 2 * 60_000 })
    },
    async end() {
      await session.getByRole('button', { name: 'End', exact: true }).click()
      await expect(page.getByTestId('voice-summary')).toBeVisible({ timeout: 60_000 })
    },
  }
}

/** Seconds of voice time counted against the student today: the number behind the lobby's "n min left today". */
export async function usedVoiceSeconds(page: Page): Promise<number> {
  const response = await page.request.get('/api/voice/usage')
  expect(response.ok(), 'the voice usage answered').toBe(true)
  return ((await response.json()) as { usedSeconds: number }).usedSeconds
}

/** A voice session as stored. The student sees none of it; V5 closes the sessions a browser never ended. */
export async function storedSession(id: string): Promise<{ status: string; endedAt: Date | null }> {
  return withPrisma(async (prisma) => {
    const row = await prisma.voiceDrillSession.findUnique({ where: { id }, select: { status: true, endedAt: true } })
    if (!row) throw new Error(`No voice session ${id}`)
    return row
  })
}

/**
 * The tab dies the way a crashed or killed tab does: no pagehide, so the session's ending request is never sent and it
 * stays open on the server until its heartbeat goes stale (K42).
 */
export async function crashTab(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  const crashed = page.waitForEvent('crash')
  void cdp.send('Page.crash').catch(() => {})
  await crashed
  await page.close()
}
