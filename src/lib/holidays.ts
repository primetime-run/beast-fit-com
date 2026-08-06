/* ---------------------------------------------------------------------------
   Holiday rules -> concrete dates

   data/holidays.yaml defines each holiday once, by rule, with the gym's
   policy attached. This resolves those rules into the date-keyed shape the
   schedule engine consumes, so nothing downstream knows or cares that dates
   were computed rather than listed.

   Design notes worth keeping:

   * `nth` is spelled out (4, or the word `last`) rather than encoded as a
     signed number. "Last Thursday of November" and "fourth Thursday of
     November" are different days in 2028, 2029, 2034 and 2035 — an earlier
     version of this data conflated them and would have closed the gym on the
     wrong day. Naming them separately makes that unrepresentable.

   * Relative rules (`after: thanksgiving`) resolve in a second pass, so
     Black Friday follows Thanksgiving wherever it lands instead of carrying
     its own duplicate rule that could drift out of step.

   * One-off `exceptions` are date-keyed and win over any rule, because a
     storm closure is not a recurring idea.

   All arithmetic is UTC on plain year/month/day values — the schedule is
   wall-clock local, so dates must never pass through a timezone conversion.
--------------------------------------------------------------------------- */

import type { OverridesDoc, DateOverride, OverrideSession } from './overrides.ts'

export interface HolidayRule {
  /** 1-12 */
  month?: number
  /** 1-31, for a fixed calendar date. */
  day?: number
  /** Mon..Sun, with `nth`. */
  weekday?: string
  /** 1-5, or the word `last`. */
  nth?: number | 'last'
  /** id of another holiday this one is relative to. */
  after?: string
  /** Offset in days from `after`. May be negative. */
  days?: number
}

export interface HolidayDef {
  id: string
  label: string
  on: HolidayRule
  closed?: boolean
  replace?: OverrideSession[]
  add?: OverrideSession[]
}

export interface HolidaysDoc {
  horizonYears?: number
  holidays: HolidayDef[]
  exceptions?: OverridesDoc
}

const WEEKDAYS: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const isoWeekdayOf = (d: Date) => d.getUTCDay() || 7

/**
 * The nth occurrence of a weekday in a month, by enumeration.
 * Enumerating rather than doing offset arithmetic keeps `last` honest in
 * months with five of the weekday.
 */
export function nthWeekday(year: number, month: number, weekday: number, nth: number | 'last'): string {
  const all: Date[] = []
  for (let d = 1; d <= 31; d++) {
    const dt = utc(year, month, d)
    if (dt.getUTCMonth() !== month - 1) break
    if (isoWeekdayOf(dt) === weekday) all.push(dt)
  }
  if (nth === 'last') return iso(all[all.length - 1])
  if (nth < 1 || nth > all.length) {
    throw new Error(`There is no ${nth}th weekday ${weekday} in ${year}-${month}`)
  }
  return iso(all[nth - 1])
}

function addDays(date: string, n: number): string {
  return iso(new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000))
}

/** The policy half of a holiday, without the rule. */
function policyOf(h: HolidayDef): DateOverride {
  const o: DateOverride = { label: h.label }
  if (h.closed) o.closed = true
  if (h.replace?.length) o.replace = h.replace
  if (h.add?.length) o.add = h.add
  return o
}

/** Resolve every holiday to a date for one year. Returns id -> YYYY-MM-DD. */
export function datesForYear(doc: HolidaysDoc, year: number): Map<string, string> {
  const out = new Map<string, string>()
  const deferred: HolidayDef[] = []

  for (const h of doc.holidays) {
    const r = h.on
    if (r.after) { deferred.push(h); continue }

    if (r.weekday !== undefined) {
      const wd = WEEKDAYS[r.weekday]
      if (!wd) throw new Error(`Holiday "${h.id}": unknown weekday "${r.weekday}"`)
      if (r.month === undefined) throw new Error(`Holiday "${h.id}": weekday rule needs a month`)
      if (r.nth === undefined) throw new Error(`Holiday "${h.id}": weekday rule needs nth`)
      out.set(h.id, nthWeekday(year, r.month, wd, r.nth))
      continue
    }

    if (r.month !== undefined && r.day !== undefined) {
      const dt = utc(year, r.month, r.day)
      if (dt.getUTCMonth() !== r.month - 1) {
        throw new Error(`Holiday "${h.id}": ${year}-${r.month}-${r.day} is not a real date`)
      }
      out.set(h.id, iso(dt))
      continue
    }

    throw new Error(`Holiday "${h.id}": rule is neither a fixed date, an nth weekday, nor relative`)
  }

  // Relative rules, repeated until nothing new resolves so a chain works.
  let progress = true
  while (deferred.length && progress) {
    progress = false
    for (let i = deferred.length - 1; i >= 0; i--) {
      const h = deferred[i]
      const base = out.get(h.on.after!)
      if (base === undefined) continue
      out.set(h.id, addDays(base, h.on.days ?? 0))
      deferred.splice(i, 1)
      progress = true
    }
  }
  if (deferred.length) {
    throw new Error(
      `Unresolved relative holidays: ${deferred.map((h) => `${h.id} -> ${h.on.after}`).join(', ')}`
    )
  }

  return out
}

/**
 * Resolve rules across a span of years into the date-keyed overrides the
 * schedule engine consumes. One-off exceptions are merged last and win.
 */
export function resolveOverrides(doc: HolidaysDoc, fromYear: number, toYear: number): OverridesDoc {
  const byId = new Map(doc.holidays.map((h) => [h.id, h]))
  const out: OverridesDoc = {}

  for (let y = fromYear; y <= toYear; y++) {
    for (const [id, date] of datesForYear(doc, y)) {
      out[date] = policyOf(byId.get(id)!)
    }
  }

  for (const [date, o] of Object.entries(doc.exceptions ?? {})) {
    out[date] = o
  }

  return out
}
