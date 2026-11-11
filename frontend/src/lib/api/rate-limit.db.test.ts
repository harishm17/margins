/**
 * The durable limiter against a real, migrated Postgres (DATABASE_URL). Skipped when no database with the
 * rate_limit_hits table answers. The counters live in the database, so two limiters built apart (two server
 * instances, or one before and one after a deploy) count the same hits. Each test uses its own limiter name.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

type Prisma = typeof import('@/lib/db/prisma').prisma
let prisma: Prisma
let createRateLimiter: typeof import('./rate-limit').createRateLimiter
let available = false
let seq = 0
const tag = `rl${process.pid}`
const name = () => `${tag}-${seq++}`
const email = (label: string) => `${tag}-${label}@example.test`
// Times count from the start of the current minute, not from 1970. Any limiter deletes windows older than a day on about
// one hit in 100 (rate-limit.ts), so in the full suite another file's hit removed rows kept at the epoch in the middle of
// a test here, and the count started again (seen twice on 2026-11-10).
const T0 = Math.floor(Date.now() / 60_000) * 60_000
const at = (ms: number) => T0 + ms

before(async () => {
  ;({ prisma } = await import('@/lib/db/prisma'))
  ;({ createRateLimiter } = await import('./rate-limit'))
  available = await prisma.$queryRaw`SELECT 1 FROM rate_limit_hits LIMIT 1`.then(
    () => true,
    () => false
  )
})

after(async () => {
  if (!available) return
  await prisma.rateLimitHit.deleteMany({ where: { key: { startsWith: tag } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: tag } } })
  await prisma.$disconnect()
})

const makeUser = (label: string) => prisma.user.create({ data: { email: email(label) } })

test('allows up to the limit, then refuses with the time left in the window', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const user = await makeUser('a')
  const limiter = createRateLimiter({ name: name(), limit: 3, windowMs: 60_000 })
  assert.equal((await limiter.check(user.id, at(0))).ok, true)
  assert.equal((await limiter.check(user.id, at(1000))).ok, true)
  assert.equal((await limiter.check(user.id, at(2000))).ok, true)
  const refused = await limiter.check(user.id, at(3000))
  assert.equal(refused.ok, false)
  assert.equal(refused.retryAfterSeconds, 57)
})

test('two instances share one count, and a new window starts at zero', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const user = await makeUser('b')
  const options = { name: name(), limit: 1, windowMs: 60_000 }
  const instanceA = createRateLimiter(options)
  const instanceB = createRateLimiter(options)
  assert.equal((await instanceA.check(user.id, at(0))).ok, true)
  assert.equal((await instanceB.check(user.id, at(1))).ok, false)
  assert.equal((await instanceB.check(user.id, at(59_999))).ok, false)
  assert.equal((await instanceA.check(user.id, at(60_000))).ok, true)
})

test('students and addresses are counted separately', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const [one, two] = [await makeUser('c'), await makeUser('d')]
  const limiter = createRateLimiter({ name: name(), limit: 1, windowMs: 60_000 })
  assert.equal((await limiter.check(one.id, at(0))).ok, true)
  assert.equal((await limiter.check(two.id, at(0))).ok, true)
  assert.equal((await limiter.check(one.id, at(1))).ok, false)
  assert.equal((await limiter.checkAddress('203.0.113.9', at(0))).ok, true)
  assert.equal((await limiter.checkAddress('203.0.113.9', at(1))).ok, false)
})

test('the count follows the spend key, so an account made again keeps its hits', { skip: !process.env.DATABASE_URL }, async (t) => {
  if (!available) return t.skip('no database')
  const first = await makeUser('e')
  const limiter = createRateLimiter({ name: name(), limit: 1, windowMs: 60_000 })
  assert.equal((await limiter.check(first.id, at(0))).ok, true)
  await prisma.user.delete({ where: { id: first.id } })
  const second = await makeUser('e')
  assert.equal((await limiter.check(second.id, at(1))).ok, false)
})
