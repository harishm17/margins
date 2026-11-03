import type { Plan } from '@/lib/learning/plan'

/**
 * The unit the map opens on (spec §9): the unit of the first thing left to do in today's plan, else of the next
 * planned thing, else the first unit that has concepts. `unitIds` are the units the map can show, in course order
 * (null is the topics that belong to no unit).
 */
export function defaultUnit(plan: Pick<Plan, 'days'> | null, unitIds: (string | null)[]): string | null {
  if (unitIds.length === 0) return null
  const available = new Set(unitIds)
  const days = plan?.days ?? []
  const today = days.filter((day) => day.isToday)
  const later = days.filter((day) => !day.isToday)
  for (const day of [...today, ...later]) {
    for (const item of day.items) {
      if (item.done || item.topicId === null) continue
      const unit = item.unitId ?? null
      if (available.has(unit)) return unit
    }
  }
  return unitIds[0]
}
