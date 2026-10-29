import { expect, test } from '@playwright/test'

test('the evaluation page shows its method, key numbers, failed checks and caveats, server-rendered', async ({ page, request }) => {
  // The HTML itself carries the numbers: no script is needed to read them.
  const html = await (await request.get('/evaluation')).text()
  expect(html).toContain('0.961')
  expect(html).toContain('4.88')

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/evaluation')

  await expect(page.getByRole('heading', { level: 1, name: 'How Margins is evaluated' })).toBeVisible()
  for (const name of ['Retrieval', 'Generation quality', 'Model choice', 'Raw results']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
  }

  // Retrieval: hybrid with fusion against vector only and the old search, 38 topics.
  const retrieval = page.getByRole('table', { name: /Retrieval, run of October 20, 2026/ })
  await expect(retrieval.getByRole('row', { name: /Hybrid search with reciprocal rank fusion/ })).toContainText('0.989')
  await expect(retrieval.getByRole('row', { name: /Hybrid search with reciprocal rank fusion/ })).toContainText('0.961')
  await expect(retrieval.getByRole('row', { name: /Vector search only/ })).toContainText('0.934')
  await expect(retrieval.getByRole('row', { name: /Old hybrid search/ })).toContainText('0.830')
  await expect(page.getByText('38 topics, one writer.')).toBeVisible()

  // Generation: the failed checks are shown as failed, and the judge caveat is stated.
  const checks = page.getByRole('table', { name: /Automatic checks, run of October 21, 2026/ })
  await expect(checks.getByRole('row', { name: /Notes with all expected sections/ })).toContainText('0 of 8')
  await expect(checks.getByRole('row', { name: /Notes with all expected sections/ })).toContainText('Failed')
  await expect(checks.getByRole('row', { name: /Notes inside the requested word band/ })).toContainText('0 of 8')
  await expect(checks.getByRole('row', { name: /Notes inside the requested word band/ })).toContainText('Failed')
  await expect(page.getByText('the same model that wrote the content')).toBeVisible()
  const judge = page.getByRole('table', { name: /Judge scores out of 5/ })
  await expect(judge.getByRole('row', { name: /Correctness/ })).toContainText('4.88')
  await expect(judge.getByRole('row', { name: /Grounding/ })).toContainText('4.91')

  // Model choice.
  await expect(page.getByRole('table', { name: /Model choice/ }).getByRole('row', { name: /Sonnet, medium/ })).toContainText('$0.24')

  // Raw results link to the files on GitHub.
  await expect(page.getByRole('link', { name: /Generation quality, with every error/ })).toHaveAttribute(
    'href',
    'https://github.com/harishm17/margins/blob/main/evals/results/2026-10-21-structure.md'
  )

  // Metadata: canonical, Open Graph and an Article with the author.
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://studymargins.com/evaluation')
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article')
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://studymargins.com/evaluation')
  const article = await page.evaluate(() => JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent ?? '{}'))
  expect(article['@type']).toBe('Article')
  expect(article.author.name).toBe('Harish Manoharan')
  expect(article.author.url).toBe('https://harishmanoharan.com/')
  expect(article.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(article.dateModified).toMatch(/^\d{4}-\d{2}-\d{2}$/)

  // Nothing overflows the page sideways, on a desktop or a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  expect(errors).toEqual([])
})

test('the evaluation page is in the sitemap and llms.txt and linked from the footer and the landing page', async ({ page, request }) => {
  const sitemap = await (await request.get('/sitemap.xml')).text()
  expect(sitemap).toContain('<loc>https://studymargins.com/evaluation</loc>')
  const llms = await (await request.get('/llms.txt')).text()
  expect(llms).toContain('https://studymargins.com/evaluation')

  await page.goto('/')
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'How it is evaluated' })).toHaveAttribute('href', '/evaluation')
  await page.getByRole('link', { name: 'How it is evaluated' }).first().click()
  await expect(page).toHaveURL(/\/evaluation$/)
})
