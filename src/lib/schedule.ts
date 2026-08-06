/* ---------------------------------------------------------------------------
   Schedule engine

   Turns data/schedule.yaml (a perpetual weekly pattern) plus the resolved
   holiday rules from data/holidays.yaml into concrete days. This replaced 4,948
   individual WordPress event posts: the pattern is the source of truth and
   dates are generated, so the calendar cannot run dry the way a finite list of
   posts eventually does.

   Times are wall-clock local to the gym and are never converted through a
   timezone. A 05:30 class is 05:30 in January and in July; routing it through
   UTC is exactly how a DST boundary moves a class by an hour twice a year.
--------------------------------------------------------------------------- */

import {
  isoWeekday,
  suppressesNormal,
  type OverridesDoc,
  type DateOverride,
} from './overrides.ts'

export interface ClassSlot {
  day: string
  times: string[]
}

export interface ClassDef {
  id: string
  name: string
  duration: number
  slots: ClassSlot[]
}

export interface ScheduleDoc {
  timezone: string
  classes: ClassDef[]
}

export interface Session {
  classId: string
  name: string
  time: string
  duration: number
  /** True when it came from an override rather than the weekly pattern. */
  special: boolean
}

export type DayKind = 'normal' | 'closed' | 'replaced' | 'added' | 'labelled'

export interface ScheduleDay {
  date: string
  /** ISO weekday, 1 = Monday. */
  weekday: number
  /** Set when an override names the day, whatever else it does. */
  label?: string
  kind: DayKind
  closed: boolean
  sessions: Session[]
}

const DAY_TO_ISO: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function eachDate(from: string, to: string): string[] {
  const out: string[] = []
  let t = Date.parse(from + 'T00:00:00Z')
  const end = Date.parse(to + 'T00:00:00Z')
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10))
    t += 86400000
  }
  return out
}

/** The normal weekly pattern for one ISO weekday. */
export function normalSessionsFor(doc: ScheduleDoc, weekday: number): Session[] {
  const out: Session[] = []
  for (const cls of doc.classes) {
    for (const slot of cls.slots) {
      const iso = DAY_TO_ISO[slot.day]
      if (iso === undefined) throw new Error(`Unknown day "${slot.day}" in class "${cls.id}"`)
      if (iso !== weekday) continue
      for (const time of slot.times) {
        out.push({ classId: cls.id, name: cls.name, time, duration: cls.duration, special: false })
      }
    }
  }
  return out.sort((a, b) => minutes(a.time) - minutes(b.time))
}

function overrideSessions(date: string, list: DateOverride['replace']): Session[] {
  return (list ?? []).map((s, i) => ({
    classId: `override-${date}-${i}`,
    name: s.name,
    time: s.time,
    duration: s.duration,
    special: true,
  }))
}

/** Concrete days between two dates, inclusive. */
export function generateSchedule(
  doc: ScheduleDoc,
  overrides: OverridesDoc,
  from: string,
  to: string
): ScheduleDay[] {
  return eachDate(from, to).map((date) => {
    const weekday = isoWeekday(date)
    const o = overrides[date]
    const label = o?.label

    if (!o) {
      return { date, weekday, kind: 'normal', closed: false, sessions: normalSessionsFor(doc, weekday) }
    }

    if (o.closed) {
      return { date, weekday, label, kind: 'closed', closed: true, sessions: [] }
    }

    if (o.replace?.length) {
      return {
        date, weekday, label, kind: 'replaced', closed: false,
        sessions: overrideSessions(date, o.replace).sort((a, b) => minutes(a.time) - minutes(b.time)),
      }
    }

    if (o.add?.length) {
      const merged = [...normalSessionsFor(doc, weekday), ...overrideSessions(date, o.add)]
      return {
        date, weekday, label, kind: 'added', closed: false,
        sessions: merged.sort((a, b) => minutes(a.time) - minutes(b.time)),
      }
    }

    // Named, but nothing changes.
    return { date, weekday, label, kind: 'labelled', closed: false, sessions: normalSessionsFor(doc, weekday) }
  })
}

/** Dates in the range where the normal weekly pattern does not run. */
export function suppressedDates(overrides: OverridesDoc, from: string, to: string): string[] {
  return Object.keys(overrides)
    .filter((d) => d >= from && d <= to && suppressesNormal(overrides[d]))
    .sort()
}
