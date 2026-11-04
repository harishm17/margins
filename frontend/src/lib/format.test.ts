import test from 'node:test'
import assert from 'node:assert/strict'
import {
  firstName,
  formatAgo,
  formatBytes,
  formatClock,
  formatDate,
  formatDueLabel,
  formatElapsed,
  formatRelative,
  formatTime,
  greetingForHour,
  homeGreeting,
  homeIntro,
  initials,
  pluralize,
} from './format'

const now = new Date('2026-10-20T15:00:00')

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(640 * 1024), '640 KB')
  assert.equal(formatBytes(1.2 * 1024 * 1024), '1.2 MB')
  assert.equal(formatBytes('2516582'), '2.4 MB')
  assert.equal(formatBytes(25 * 1024 * 1024), '25 MB')
  assert.equal(formatBytes(BigInt(1024)), '1 KB')
})

test('formatAgo is compact and falls back to a date after a week', () => {
  const ago = (ms: number) => new Date(now.getTime() - ms)
  assert.equal(formatAgo(ago(10_000), now), 'just now')
  assert.equal(formatAgo(ago(5 * 60_000), now), '5m ago')
  assert.equal(formatAgo(ago(2 * 3_600_000), now), '2h ago')
  assert.equal(formatAgo(ago(3 * 86_400_000), now), '3d ago')
  assert.equal(formatAgo(ago(10 * 86_400_000), now), 'Oct 10')
})

test('formatDate adds the year only for other years', () => {
  assert.equal(formatDate(new Date('2026-10-20T12:00:00'), now), 'Oct 20')
  assert.equal(formatDate(new Date('2025-03-02T12:00:00'), now), 'Mar 2, 2025')
})

test('formatTime uses lowercase am and pm', () => {
  assert.equal(formatTime(new Date('2026-10-20T15:12:00')), '3:12 pm')
  assert.equal(formatTime(new Date('2026-10-20T09:40:00')), '9:40 am')
})

test('formatRelative reads both directions', () => {
  assert.equal(formatRelative(new Date(now.getTime() + 4 * 86_400_000), now), 'in 4 days')
  assert.equal(formatRelative(new Date(now.getTime() - 86_400_000), now), 'yesterday')
  assert.equal(formatRelative(new Date(now.getTime() + 86_400_000), now), 'tomorrow')
  assert.equal(formatRelative(new Date(now.getTime() - 2 * 3_600_000), now), '2 hours ago')
})

test('formatDueLabel', () => {
  assert.equal(formatDueLabel(new Date(now.getTime() + 3_600_000), now), 'Due today')
  assert.equal(formatDueLabel(new Date(now.getTime() - 3_600_000), now), 'Due today')
  assert.equal(formatDueLabel(new Date(now.getTime() - 2 * 86_400_000 - 1000), now), 'Overdue 2d')
})

test('timers', () => {
  assert.equal(formatClock(41 * 60 + 7), '41:07')
  assert.equal(formatClock(3600 + 5 * 60 + 9), '1:05:09')
  assert.equal(formatClock(-4), '00:00')
  assert.equal(formatElapsed(4), '4s')
  assert.equal(formatElapsed(72), '1m 12s')
})

test('pluralize and greeting', () => {
  assert.equal(pluralize(1, 'topic'), '1 topic')
  assert.equal(pluralize(12, 'topic'), '12 topics')
  assert.equal(pluralize(2, 'person', 'people'), '2 people')
  assert.equal(greetingForHour(8), 'Good morning')
  assert.equal(greetingForHour(13), 'Good afternoon')
  assert.equal(greetingForHour(20), 'Good evening')
})

test('names', () => {
  assert.equal(firstName('  Harish Mahadevan '), 'Harish')
  assert.equal(firstName(null), null)
  assert.equal(firstName('   '), null)
  assert.equal(initials('Harish Mahadevan'), 'HM')
  assert.equal(initials('harish'), 'HA')
  assert.equal(initials(null, 'demo@margins.dev'), 'DE')
  assert.equal(initials(null, null), '?')
})

test('Home never welcomes back an account that has not studied yet', () => {
  assert.equal(homeGreeting({ name: 'Harish Mahadevan', hour: 20, firstVisit: true }), 'Welcome, Harish')
  assert.equal(homeGreeting({ name: null, hour: null, firstVisit: true }), 'Welcome')
  assert.equal(homeGreeting({ name: 'Harish', hour: 8, firstVisit: false }), 'Good morning, Harish')
  assert.equal(homeGreeting({ name: 'Harish', hour: null, firstVisit: false }), 'Welcome back, Harish')
  assert.equal(homeGreeting({ name: null, hour: null, firstVisit: false }), 'Welcome back')
  assert.equal(homeIntro(true), 'Start with the step below.')
  assert.equal(homeIntro(false), "Here's where you left off.")
})
