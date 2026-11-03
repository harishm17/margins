/** The map page's address (spec §9). One place builds it, so the sidebar, the topic page and the map's own links agree. */

/** The `unit` value for topics that belong to no unit. */
export const NO_UNIT = 'none'

export type MapView = 'map' | 'list'

export function mapHref(courseId: string, options: { unitId?: string | null | undefined; topicId?: string | null; nodeId?: string | null; view?: MapView } = {}): string {
  const query = new URLSearchParams()
  if (options.unitId !== undefined) query.set('unit', options.unitId ?? NO_UNIT)
  if (options.topicId) query.set('topic', options.topicId)
  if (options.nodeId) query.set('node', options.nodeId)
  if (options.view) query.set('view', options.view)
  const text = query.toString()
  return `/courses/${courseId}/map${text ? `?${text}` : ''}`
}

export const parseView = (value: string | undefined): MapView => (value === 'list' ? 'list' : 'map')
