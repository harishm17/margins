import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCrumbs, mobileContext } from './breadcrumbs'

const nav = [
  { id: 'c1', name: 'CS 161 Algorithms', topics: [{ id: 't1', name: 'Graph traversal' }] },
]

test('home and new course', () => {
  assert.deepEqual(buildCrumbs('/home', nav), [{ label: 'Home' }])
  assert.deepEqual(buildCrumbs('/courses/new', nav), [{ label: 'Home', href: '/home' }, { label: 'New course' }])
})

test('topic page: course, topics, topic name', () => {
  assert.deepEqual(buildCrumbs('/courses/c1/topics/t1', nav), [
    { label: 'CS 161 Algorithms', href: '/courses/c1' },
    { label: 'Topics', href: '/courses/c1/topics' },
    { label: 'Graph traversal' },
  ])
})

test('an unknown course still gets a sensible crumb', () => {
  assert.deepEqual(buildCrumbs('/courses/zzz/topics', nav)[0], { label: 'Course', href: '/courses/zzz' })
})

const unitNav = [
  {
    id: 'c1',
    name: 'CS 161 Algorithms',
    units: [
      { id: 'u1', title: 'Sorting and graphs', weekLabel: 'Week 1' },
      { id: 'u2', title: 'Hashing', weekLabel: null },
    ],
    topics: [
      { id: 't1', name: 'Graph traversal', unitId: 'u1' },
      { id: 't2', name: 'Hash tables', unitId: 'u2' },
      { id: 't3', name: 'Discrete random variables', unitId: null },
    ],
  },
]

test('on a phone the course and the unit are shown in full above the page name', () => {
  const at = (path: string) => mobileContext(path, unitNav, buildCrumbs(path, unitNav))
  assert.deepEqual(at('/courses/c1/topics/t1'), { title: 'Graph traversal', context: 'CS 161 Algorithms / Week 1: Sorting and graphs' })
  assert.deepEqual(at('/courses/c1/topics/t2'), { title: 'Hash tables', context: 'CS 161 Algorithms / Hashing' })
  // A topic outside every unit shows just the course.
  assert.deepEqual(at('/courses/c1/topics/t3'), { title: 'Discrete random variables', context: 'CS 161 Algorithms' })
  assert.deepEqual(at('/courses/c1'), { title: 'CS 161 Algorithms', context: null })
  assert.deepEqual(at('/courses/c1/plan'), { title: 'Plan', context: 'CS 161 Algorithms' })
  assert.deepEqual(at('/courses/c1/exams/e1/results/s1'), { title: 'Results', context: 'CS 161 Algorithms / Mock exams / Exam' })
  assert.deepEqual(at('/home'), { title: 'Home', context: null })
})
