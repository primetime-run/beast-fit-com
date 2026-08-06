/* ---------------------------------------------------------------------------
   iCalendar (RFC 5545) generation

   Three things people get wrong in hand-rolled ICS, all handled here:

   1. CRLF. The spec requires \r\n. Files with bare \n import silently wrong
      (or not at all) in Outlook.
   2. Line folding. Lines must not exceed 75 OCTETS — not characters. A class
      name with a multi-byte character folded on a character boundary corrupts
      the file. foldLine() counts UTF-8 bytes and never splits one.
   3. Timezones. Wall-clock times need TZID plus a real VTIMEZONE component,
      or a 5:30 AM class lands at 5:30 UTC — 12:30 AM local in the winter.

   The recurring classes are expressed as RRULE with EXDATE for every holiday
   the gym is closed or running a special instead. That is what lets one VEVENT
   describe "every Monday at 5:30, except these dates" rather than emitting
   thousands of individual events.

   RRULE is bounded with UNTIL at the end of the pinned holiday range. That is
   deliberate: an unbounded series would keep generating occurrences past the
   last year we have holiday dates for, and those occurrences would have no
   EXDATEs — quietly telling members there is a class on a Thanksgiving we
   never accounted for.
--------------------------------------------------------------------------- */

import type { ScheduleDay, ScheduleDoc } from './schedule.ts'
import type { OverridesDoc } from './overrides.ts'
import { location, addressLine } from './data.ts'

export const TZID = 'America/New_York'

/** US DST rules as they have stood since 2007: 2nd Sunday March, 1st Sunday November. */
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  `TZID:${TZID}`,
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
]

const BYDAY = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

/** Escape per RFC 5545 §3.3.11: backslash, semicolon, comma, newline. */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * Fold to 75 octets per line, continuation lines starting with one space.
 * Counts UTF-8 bytes and never splits a multi-byte character.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line

  const out: string[] = []
  let start = 0
  let limit = 75
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length)
    // Walk back off a continuation byte so we never cut mid-character.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    out.push(bytes.subarray(start, end).toString('utf8'))
    start = end
    limit = 74 // subsequent lines carry a leading space
  }
  return out[0] + out.slice(1).map((s) => '\r\n ' + s).join('')
}

/** "2026-11-26" + "05:30" -> "20261126T053000" */
export function localStamp(date: string, time: string): string {
  return `${date.replace(/-/g, '')}T${time.replace(':', '')}00`
}

/** Minutes after a HH:MM time, same day or spilling over. */
export function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [h, m] = time.split(':').map(Number)
  const total = h * 60 + m + minutes
  const dayShift = Math.floor(total / 1440)
  const mins = ((total % 1440) + 1440) % 1440
  const d = new Date(Date.parse(date + 'T00:00:00Z') + dayShift * 86400000)
  return {
    date: d.toISOString().slice(0, 10),
    time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`,
  }
}

/** A fixed DTSTAMP keeps rebuilds byte-identical when nothing else changed. */
const DTSTAMP = '20260101T000000Z'

export interface IcsEvent {
  uid: string
  summary: string
  description?: string
  location?: string
  date: string
  time: string
  durationMinutes: number
  /** ISO weekday for a weekly series; omit for a one-off. */
  recurWeekday?: number
  /** YYYY-MM-DD, inclusive bound for the series. */
  recurUntil?: string
  /** Dates the series does NOT occur, YYYY-MM-DD. */
  exdates?: string[]
}

/*
  Where the class is, in the three forms calendars actually read:

    LOCATION   the human-readable line every client displays
    GEO        RFC 5545 coordinates; used for maps and travel time
    X-APPLE-STRUCTURED-LOCATION
               what makes Apple Calendar show a map thumbnail and offer
               "Directions" and a leave-by alert. LOCATION alone gets a plain
               string that Apple re-geocodes — the same guesswork that put the
               old venue pin 346 m off.

  Built from data/location.yaml, so the address in a member's calendar cannot
  drift from the address on the site.
*/
export function locationLines(): string[] {
  const label = `${location.name}, ${addressLine()}`
  const appleAddr = `${location.street}\\n${location.city} ${location.state} ${location.zip}`
  return [
    `LOCATION:${escapeText(label)}`,
    `GEO:${location.lat};${location.lng}`,
    `X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="${appleAddr}";` +
      `X-APPLE-RADIUS=100;X-TITLE="${location.name}":geo:${location.lat},${location.lng}`,
  ]
}

function eventLines(e: IcsEvent): string[] {
  const end = addMinutes(e.date, e.time, e.durationMinutes)
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${DTSTAMP}`,
    `DTSTART;TZID=${TZID}:${localStamp(e.date, e.time)}`,
    `DTEND;TZID=${TZID}:${localStamp(end.date, end.time)}`,
    `SUMMARY:${escapeText(e.summary)}`,
  ]
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`)
  if (e.location) lines.push(...locationLines())

  if (e.recurWeekday) {
    let rrule = `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[e.recurWeekday]}`
    if (e.recurUntil) {
      // UNTIL in UTC. 23:59:59Z on the bound date covers the whole final day
      // regardless of the local offset.
      rrule += `;UNTIL=${e.recurUntil.replace(/-/g, '')}T235959Z`
    }
    lines.push(rrule)

    if (e.exdates?.length) {
      // One EXDATE line carrying all excluded instances, at the event's time.
      const stamps = e.exdates.map((d) => localStamp(d, e.time)).join(',')
      lines.push(`EXDATE;TZID=${TZID}:${stamps}`)
    }
  }

  lines.push('END:VEVENT')
  return lines
}

export function buildCalendar(events: IcsEvent[], name: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BEAST Fitness//Class Schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-TIMEZONE:${TZID}`,
    ...VTIMEZONE,
    ...events.flatMap(eventLines),
    'END:VCALENDAR',
  ]
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

/* --- turning the schedule into events ------------------------------------ */

/* A flag, not the text. Setting it makes eventLines() emit the full
   LOCATION / GEO / X-APPLE block from data/location.yaml — there is no
   address written down here to fall out of date. */
const LOCATION = 'yes'

/** Stable, collision-proof UID. Same input always yields the same UID, so a
 *  re-import updates the existing entry instead of duplicating it. */
function uid(parts: string[]): string {
  return parts.join('-').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() + '@beast-fit.com'
}

/**
 * One recurring VEVENT per class-time-per-weekday, with holiday closures and
 * special-session days excluded.
 */
export function seriesEvents(
  doc: ScheduleDoc,
  days: ScheduleDay[],
  anchorFrom: string,
  until: string,
  onlyClassId?: string
): IcsEvent[] {
  const DAY_TO_ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

  // Any day where the normal pattern does not run: closed, or replaced.
  // An `add` day is NOT suppressed — the normal classes still happen.
  const suppressed = new Set(
    days.filter((d) => d.kind === 'closed' || d.kind === 'replaced').map((d) => d.date)
  )

  const events: IcsEvent[] = []
  for (const cls of doc.classes) {
    if (onlyClassId && cls.id !== onlyClassId) continue
    for (const slot of cls.slots) {
      const weekday = DAY_TO_ISO[slot.day]
      for (const time of slot.times) {
        // DTSTART must be a real occurrence: the first matching weekday on or
        // after the anchor.
        let t = Date.parse(anchorFrom + 'T00:00:00Z')
        while (true) {
          const iso = new Date(t).toISOString().slice(0, 10)
          const wd = new Date(t).getUTCDay() || 7
          if (wd === weekday) break
          t += 86400000
        }
        const first = new Date(t).toISOString().slice(0, 10)

        const exdates = [...suppressed]
          .filter((d) => d >= first && d <= until)
          .filter((d) => (new Date(d + 'T00:00:00Z').getUTCDay() || 7) === weekday)
          .sort()

        events.push({
          uid: uid(['series', cls.id, slot.day, time]),
          summary: cls.name,
          description: `${cls.duration} minute class at BEAST Fitness.`,
          location: LOCATION,
          date: first,
          time,
          durationMinutes: cls.duration,
          recurWeekday: weekday,
          recurUntil: until,
          exdates,
        })
      }
    }
  }
  return events
}

/** One-off VEVENTs for override sessions — both `replace` and `add` days. */
export function specialEvents(days: ScheduleDay[]): IcsEvent[] {
  return days
    .filter((d) => d.kind === 'replaced' || d.kind === 'added')
    .flatMap((d) =>
      d.sessions
        .filter((s) => s.special) // on an `add` day, skip the normal classes
        .map((s) => ({
          uid: uid(['special', d.date, s.classId]),
          summary: s.name,
          description: `${s.duration} minute special session at BEAST Fitness.`,
          location: LOCATION,
          date: d.date,
          time: s.time,
          durationMinutes: s.duration,
        }))
    )
}
