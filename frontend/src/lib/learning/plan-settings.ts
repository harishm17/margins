import { z } from 'zod'
import { isDayString, MAX_DAILY_MINUTES, MIN_DAILY_MINUTES } from './plan'

/** The exam date and daily study time a course can be given (course creation, settings). */

export const DEFAULT_DAILY_MINUTES = 45

/** "I can study this long each day": the choices in the forms. */
export const DAILY_MINUTE_CHOICES = [20, 30, 45, 60, 90, 120, 180] as const

export const examDateSchema = z
  .string()
  .refine(isDayString, 'Use a date like 2026-12-14')
  .nullable()

export const dailyMinutesSchema = z.number().int().min(MIN_DAILY_MINUTES).max(MAX_DAILY_MINUTES)

/** Why a daily time cannot be saved, in words for the field, or null when it can. NaN is an empty box. */
export function dailyMinutesProblem(minutes: number): string | null {
  if (!Number.isInteger(minutes)) return 'Enter a whole number of minutes.'
  if (minutes < MIN_DAILY_MINUTES || minutes > MAX_DAILY_MINUTES) return `Use ${MIN_DAILY_MINUTES} to ${MAX_DAILY_MINUTES} minutes.`
  return null
}

/** The database column for a calendar date: midnight UTC of that date. Null clears it. */
export const examDateColumn = (day: string | null | undefined): Date | null | undefined =>
  day === undefined ? undefined : day === null ? null : new Date(`${day}T00:00:00.000Z`)

/** "45 minutes", "1 hour", "1 hour 30 minutes". */
export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const h = `${hours} hour${hours === 1 ? '' : 's'}`
  return rest === 0 ? h : `${h} ${rest} minutes`
}
