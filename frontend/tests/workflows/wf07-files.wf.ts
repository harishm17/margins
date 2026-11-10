import type { Page } from '@playwright/test'
import { test, expect } from './harness/fixtures'
import { askScreen } from './harness/ask'
import { chooseFiles, CORE_FILES, courseFile, createCourse, FILES, newStudent, openOnWarmup, startStudying, waitForTopics } from './harness/course'
import { expectNone } from './harness/page-checks'
import {
  addMarginNote,
  citing,
  claimCount,
  deadCitations,
  ideasWithoutClaims,
  loseClaims,
  preparationFinished,
  renamedCopy,
  repairLostClaims,
  sourceRows,
} from './harness/files'

// WF7: a file's life. A topic read from both lectures, a margin note on each, an Ask answer with its sources; a renamed
// copy of a file already there; one lecture deleted, the other replaced through the duplicate dialog and through its
// menu; and a topic whose claims an earlier Replace took, before the fix, repaired.

/** The student's margin notes, the same every run: one on a passage of each lecture. */
const NOTES = {
  [FILES.lecture1]: 'My note: come back to this step before the exam.',
  [FILES.lecture2]: 'My note: compare this with the earlier lecture.',
}
const fileRow = (page: Page, filename: string) => page.locator('main table tbody tr', { hasText: filename })

/** Deletes a file from its row menu on the Materials page that is open. */
async function deleteFile(page: Page, filename: string) {
  await page.getByRole('button', { name: `Actions for ${filename}` }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog', { name: `Delete ${filename}?` }).getByRole('button', { name: 'Delete file' }).click()
  await expect(fileRow(page, filename)).toHaveCount(0, { timeout: 60_000 })
}

/** Waits for the one row of `filename` to be read again after a Replace. */
async function readAgain(page: Page, filename: string) {
  await expect(fileRow(page, filename)).toHaveCount(1, { timeout: 3 * 60_000 })
  await expect(fileRow(page, filename)).toContainText('Ready', { timeout: 3 * 60_000 })
}

/** The result message under the upload area, once one shows (a few seconds at most), or '' when none does. */
async function noticeText(page: Page): Promise<string> {
  const notice = page.getByTestId('materials-notice')
  await notice.waitFor({ timeout: 10_000 }).catch(() => {})
  return (await notice.isVisible()) ? (await notice.innerText()).replace(/\s+/g, ' ').trim() : ''
}

test('WF7 files: notes and sources on two lectures, a renamed copy, delete one, replace the other, a repair', async ({ page, checks }) => {
  test.setTimeout(20 * 60_000)
  await newStudent(page, 'WF7')
  const { courseUrl, courseId } = await createCourse(page)
  const main = page.locator('main')

  await test.step('two lectures, one topic read from both', async () => {
    await chooseFiles(page, CORE_FILES)
    await expect(page.getByText('Ready', { exact: true })).toHaveCount(CORE_FILES.length, { timeout: 3 * 60_000 })
    await waitForTopics(page, courseUrl)
    // The last topic comes from the second lecture: merged into the first, the first topic is read from both files.
    await page.goto(`${courseUrl}/topics`)
    await expect(page.getByRole('heading', { level: 1, name: 'Check the topics' })).toBeVisible()
    const rows = page.getByRole('list', { name: /^Topics/ }).getByRole('listitem')
    const count = await rows.count()
    const actions = (row: number) => rows.nth(row).getByRole('button', { name: /^Actions for / })
    const firstName = ((await actions(0).getAttribute('aria-label')) ?? '').replace(/^Actions for /, '')
    await actions(count - 1).click()
    await page.getByRole('menuitem', { name: 'Merge into...' }).click()
    await page.getByRole('menuitem', { name: firstName, exact: true }).click()
    await page.getByRole('button', { name: 'Merge topics' }).click()
    await expect(rows).toHaveCount(count - 1)
    await page.getByRole('button', { name: 'Confirm topics' }).click()
    await expect(page).toHaveURL(courseUrl)
    await startStudying(page, courseUrl)
  })
  const topicUrl = new URL(page.url()).pathname
  const topicId = topicUrl.split('/').pop()!

  await test.step('a margin note on a passage of each lecture', async () => {
    await openOnWarmup(page, topicUrl)
    await page.goto(`${topicUrl}?view=read`)
    for (const file of CORE_FILES) await addMarginNote(page.locator('main').getByRole('region', { name: file, exact: true }), NOTES[file])
    // The rest of the topic (notes, examples, the quiz) is still being written from both lectures; files change only
    // once it is done, so each job reads the same files every run.
    await preparationFinished(topicId)
  })

  let threadUrl = ''
  await test.step('Ask: a suggested question and its sources', async () => {
    const ask = askScreen(page)
    await page.goto(`${courseUrl}/ask`)
    await expect(ask.suggestions.getByRole('button').first()).toBeVisible()
    const reply = await ask.reply(() => ask.suggestions.getByRole('button').first().click())
    await expect(page).toHaveURL(/[?&]thread=/)
    threadUrl = page.url()
    console.log(`note: the answer cites ${(await sourceRows(reply)).map((row) => row.label).join('; ') || 'nothing'}`)
  })

  await test.step('a renamed copy of a lecture that is already here', async () => {
    await page.goto(`${courseUrl}/materials`)
    const copy = await renamedCopy(FILES.lecture2, test.info().outputPath('files'))
    const copyName = copy.split('/').pop()!
    await chooseFiles(page, [copy])
    const duplicate = page.getByRole('dialog', { name: /already here$/ })
    const caught = await duplicate.waitFor({ timeout: 10_000 }).then(
      () => true,
      () => false
    )
    await checks.check('WF7.renamed-copy-caught', 'a renamed copy of a file already in the course is caught as the same file (F1, 73)', () =>
      expect(caught).toBe(true)
    )
    if (caught) await duplicate.getByRole('button', { name: 'Cancel' }).click()
    else {
      // Today the copy is taken as a new file: once it is read, the student deletes it again.
      console.log(`note: ${copyName} was taken as a new file; deleting it`)
      await expect(fileRow(page, copyName)).toContainText('Ready', { timeout: 3 * 60_000 })
      await deleteFile(page, copyName)
    }
  })

  await test.step('delete the first lecture', async () => {
    await page.goto(`${courseUrl}/materials`)
    await page.getByRole('button', { name: `Actions for ${FILES.lecture1}` }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = page.getByRole('dialog', { name: `Delete ${FILES.lecture1}?` })
    await expect(dialog).toBeVisible()
    await checks.check('WF7.delete-dialog-works', 'the Delete dialog lists the topics built from the file and offers Replace instead (74)', async () => {
      await expect(dialog.getByText(/^View affected topics \(\d+\)$/)).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Replace this file instead' })).toBeVisible()
    })
    const said = (await dialog.innerText()).replace(/\s+/g, ' ')
    await checks.check('WF7.delete-states-counts', `the Delete dialog says the note on the file is kept and how many ideas leave recall (F7; "${said}")`, () => {
      expect(said).toMatch(/\b1 note\b[^.]*\bkept\b/i)
      expect(said).toMatch(/\b\d+ ideas?\b/i)
    })
    await dialog.getByRole('button', { name: 'Delete file' }).click()
    await expect(fileRow(page, FILES.lecture1)).toHaveCount(0, { timeout: 60_000 })
  })

  await test.step('after the delete: the note, the sources, the ideas', async () => {
    await page.goto(`${topicUrl}?view=read`)
    await expect(main.getByRole('heading', { level: 1 })).toBeVisible()
    const noteShown = await main.getByText(NOTES[FILES.lecture1], { exact: true }).count()
    // Until PR 3's marker (X3), a note whose file is gone is listed under "Notes from removed files" at the end of the topic.
    const removedList = main.getByRole('region', { name: 'Notes from removed files' })
    await checks.check('WF7.note-kept-on-delete', 'a margin note on the deleted file is kept, listed under "Notes from removed files" (F7, 78)', async () => {
      expect(noteShown, 'the note').toBeGreaterThan(0)
      await expect(removedList.getByText(NOTES[FILES.lecture1], { exact: true })).toHaveCount(1)
    })

    await page.goto(threadUrl)
    const rows = await sourceRows(main.locator('article:not([aria-busy])').first())
    await checks.check('WF7.citation-marked', 'an Ask answer citing the deleted file says "source removed" instead of a dead link (F5, 74)', () => {
      expect(citing(rows, FILES.lecture1).length, 'the answer cited the deleted file').toBeGreaterThan(0)
      expectNone(deadCitations(rows, FILES.lecture1), 'dead citations')
    })

    // Ideas left with no claim are re-read from the topic's other lecture, in the background (SW13).
    let orphaned = await ideasWithoutClaims(topicId)
    for (const giveUpAt = Date.now() + 60_000; orphaned.length > 0 && Date.now() < giveUpAt; orphaned = await ideasWithoutClaims(topicId)) {
      await page.waitForTimeout(3000)
    }
    await checks.check('WF7.ideas-keep-claims', "every idea of the topic still has a claim from the topic's other lecture, so recall and quick checks work (SW13, 74)", () =>
      expectNone(orphaned, 'ideas with no claim')
    )
  })

  await test.step('replace the second lecture through the duplicate dialog', async () => {
    const claimsBefore = await claimCount(topicId)
    await page.goto(`${courseUrl}/materials`)
    await chooseFiles(page, [FILES.lecture2])
    const duplicate = page.getByRole('dialog', { name: 'This file is already here' })
    const sent = page.waitForResponse((response) => response.url().includes('/materials') && response.request().method() !== 'GET')
    await duplicate.getByRole('button', { name: 'Replace', exact: true }).click()
    await sent
    await readAgain(page, FILES.lecture2)
    const said = await noticeText(page)
    await checks.check('WF7.replace-says-what-happened', `Replace from the duplicate dialog says what happened to topics, progress and notes (F3, 89; "${said}")`, () =>
      expect(said).toMatch(/Replaced|Re-read/)
    )
    const claimsAfter = await claimCount(topicId)
    await checks.check('WF7.replace-keeps-claims', `the topic's claims from the replaced lecture are kept, re-anchored (F2, 72; ${claimsBefore} before, ${claimsAfter} after)`, () => {
      expect(claimsBefore, 'claims before').toBeGreaterThan(0)
      expect(claimsAfter).toBeGreaterThanOrEqual(claimsBefore)
    })

    await page.goto(`${topicUrl}?view=read`)
    await expect(main.getByRole('heading', { level: 1 })).toBeVisible()
    const file = main.getByRole('region', { name: FILES.lecture2, exact: true })
    const sourceKept = await file.count()
    const noteKept = await file.getByRole('list', { name: /^Notes on passage \d+$/ }).filter({ hasText: NOTES[FILES.lecture2] }).count()
    await checks.check('WF7.replace-keeps-source', 'after Replace the topic still reads from the lecture (F2, 72)', () => expect(sourceKept).toBe(1))
    await checks.check('WF7.replace-keeps-note', 'after Replace the margin note sits on its passage again (F2, 78)', () => expect(noteKept).toBe(1))
  })

  await test.step('replace through the row menu', async () => {
    await page.goto(`${courseUrl}/materials`)
    await page.getByRole('button', { name: `Actions for ${FILES.lecture2}` }).click()
    const replace = page.getByRole('menuitem', { name: /^Replace/ })
    const offered = await replace.isVisible()
    await checks.check('WF7.replace-in-menu', "a read file's menu offers Replace (F4, 75)", () => expect(offered).toBe(true))
    if (!offered) {
      await page.keyboard.press('Escape')
      return
    }
    const chooser = page.waitForEvent('filechooser')
    await replace.click()
    await (await chooser).setFiles(courseFile(FILES.lecture2))
    await readAgain(page, FILES.lecture2)
    const said = await noticeText(page)
    await checks.check('WF7.menu-replace-says', `Replace from the menu says what happened, as the dialog's does (F3; "${said}")`, () =>
      expect(said).toMatch(/Replaced|Re-read/)
    )
  })

  await test.step('a topic whose claims an earlier Replace took, repaired', async () => {
    const lost = await loseClaims(topicId)
    const repair = await repairLostClaims(courseId)
    const left = await ideasWithoutClaims(topicId)
    await checks.check('WF7.lost-claims-repaired', `the one-off repair re-reads ideas that lost every claim before the fix (F0, 89; ${lost} claims taken)`, () => {
      expect(repair.ran, repair.output).toBe(true)
      expectNone(left, 'ideas still with no claim')
    })
  })
})
