/* ---------------------------------------------------------------------------
   Date overrides — the shape the schedule engine consumes.

   These are produced by resolving the rules in data/holidays.yaml (see
   lib/holidays.ts), plus any one-off `exceptions` listed there. Nothing
   hand-maintains a file in this shape; it is the intermediate form between
   "the 4th Thursday of November, closed" and "this specific date, closed".

   Semantics, in precedence order for a single date:

     closed: true    no classes
     replace: [..]   these sessions instead of the normal pattern
     add: [..]       these sessions as well as the normal pattern
     label only      the normal pattern runs; the day is just named

   Because the key is a date and not a holiday, the same mechanism covers a
   storm closure, a maintenance day or a private event.
--------------------------------------------------------------------------- */

export interface OverrideSession {
  name: string
  /** HH:MM, wall clock. */
  time: string
  /** Minutes. */
  duration: number
}

export interface DateOverride {
  label?: string
  closed?: boolean
  replace?: OverrideSession[]
  add?: OverrideSession[]
}

export type OverridesDoc = Record<string, DateOverride>

/** ISO weekday, 1 = Monday .. 7 = Sunday. */
export function isoWeekday(date: string): number {
  const js = new Date(date + 'T00:00:00Z').getUTCDay()
  return js === 0 ? 7 : js
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
}

/** The last date the file has any entry for. Everything is bounded by this. */
export function coveredThrough(doc: OverridesDoc): string {
  const dates = Object.keys(doc).sort()
  return dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10)
}

export function coveredFrom(doc: OverridesDoc): string {
  const dates = Object.keys(doc).sort()
  return dates[0] ?? new Date().toISOString().slice(0, 10)
}

/** True when the normal weekly pattern does NOT run on this date. */
export function suppressesNormal(o: DateOverride | undefined): boolean {
  if (!o) return false
  return Boolean(o.closed) || Boolean(o.replace?.length)
}
