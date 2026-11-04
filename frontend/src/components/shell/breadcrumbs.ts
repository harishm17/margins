import type { Crumb } from './slots'

type NavLike = {
  id: string
  name: string
  units?: { id: string; title: string; weekLabel: string | null }[]
  topics: { id: string; name: string; unitId?: string | null }[]
}

/** What the top bar shows on a phone, where a row of truncated crumbs says nothing: the page name, with where it is above it. */
export type MobileContext = { title: string; context: string | null }

/**
 * Two lines instead of "CS... / ... / Discrete random v...". The page name is the last crumb. Above it
 * the course, and for a topic its unit (with the week when there is one), in full and ellipsised only at
 * the end. A page with deeper crumbs (an exam's results) lists the ones above it.
 */
export function mobileContext(pathname: string, nav: NavLike[], crumbs: Crumb[]): MobileContext {
  if (crumbs.length === 0) return { title: '', context: null }
  const title = crumbs[crumbs.length - 1].label
  const parts = pathname.split('?')[0].split('/').filter(Boolean)
  if (parts[0] === 'courses' && parts[2] === 'topics' && parts[3]) {
    const course = nav.find((item) => item.id === parts[1])
    const topic = course?.topics.find((item) => item.id === parts[3])
    const unit = topic?.unitId ? course?.units?.find((item) => item.id === topic.unitId) : undefined
    const unitLabel = unit ? (unit.weekLabel ? `${unit.weekLabel}: ${unit.title}` : unit.title) : null
    return { title, context: [crumbs[0].label, unitLabel].filter(Boolean).join(' / ') }
  }
  return { title, context: crumbs.length > 1 ? crumbs.slice(0, -1).map((crumb) => crumb.label).join(' / ') : null }
}

/**
 * Breadcrumbs for a path, from the route table in the design (5.1). Names come from the nav
 * index the app layout already has, so they render on the server with no flash. A page can
 * replace them with <PageHeader crumbs>, for names the index does not know (an exam).
 */
export function buildCrumbs(pathname: string, nav: NavLike[]): Crumb[] {
  const parts = pathname.split('?')[0].split('/').filter(Boolean)
  if (parts.length === 0) return []

  if (parts[0] === 'home') return [{ label: 'Home' }]

  if (parts[0] !== 'courses') return []
  if (parts[1] === 'new') return [{ label: 'Home', href: '/home' }, { label: 'New course' }]

  const courseId = parts[1]
  if (!courseId) return [{ label: 'Home', href: '/home' }]
  const course = nav.find((item) => item.id === courseId)
  const base = `/courses/${courseId}`
  const courseCrumb = (current: boolean): Crumb => ({
    label: course?.name ?? 'Course',
    ...(current ? {} : { href: base }),
  })

  const section = parts[2]
  if (!section) return [courseCrumb(true)]

  switch (section) {
    case 'materials':
      return [courseCrumb(false), { label: 'Materials' }]
    case 'ask':
      return [courseCrumb(false), { label: 'Ask' }]
    case 'plan':
      return [courseCrumb(false), { label: 'Plan' }]
    case 'map':
      return [courseCrumb(false), { label: 'Map' }]
    case 'review':
      return [courseCrumb(false), { label: 'Review' }]
    case 'settings':
      return [courseCrumb(false), { label: 'Course settings' }]
    case 'topics': {
      const topicId = parts[3]
      if (!topicId) return [courseCrumb(false), { label: 'Topics' }]
      const topic = course?.topics.find((item) => item.id === topicId)
      return [courseCrumb(false), { label: 'Topics', href: `${base}/topics` }, { label: topic?.name ?? 'Topic' }]
    }
    case 'exams': {
      const examsCrumb = (current: boolean): Crumb => ({ label: 'Mock exams', ...(current ? {} : { href: `${base}/exams` }) })
      const examId = parts[3]
      if (!examId) return [courseCrumb(false), examsCrumb(true)]
      if (examId === 'new') return [courseCrumb(false), examsCrumb(false), { label: 'New mock exam' }]
      const examCrumb = (current: boolean): Crumb => ({ label: 'Exam', ...(current ? {} : { href: `${base}/exams/${examId}` }) })
      if (!parts[4]) return [courseCrumb(false), examsCrumb(false), examCrumb(true)]
      if (parts[4] === 'take') return [courseCrumb(false), examsCrumb(false), examCrumb(false), { label: 'Taking' }]
      if (parts[4] === 'results') return [courseCrumb(false), examsCrumb(false), examCrumb(false), { label: 'Results' }]
      return [courseCrumb(false), examsCrumb(true)]
    }
    default:
      return [courseCrumb(true)]
  }
}
