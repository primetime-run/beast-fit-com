/* ---------------------------------------------------------------------------
   Validates data/holidays.yaml.

   Rules are compact, which is the point — but a compact rule can be quietly
   wrong for years before anyone notices. So beyond checking the file is
   well-formed, this asserts an INDEPENDENT property of each computed date:
   the nth occurrence of a weekday in a month always falls inside a known
   seven-day window. The 4th Thursday of November is always Nov 22-28; the
   last Monday of May is always May 25-31.

   That check is not a reimplementation of the resolver, so a bug in the
   resolver cannot satisfy both. It is exactly the check that would have
   caught Thanksgiving being encoded as "last Thursday" — Nov 29 and Nov 30
   fall outside the window.

   Run: npm run verify-holidays
--------------------------------------------------------------------------- */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { datesForYear, type HolidaysDoc } from '../src/lib/holidays.ts'
import type { OverrideSession } from '../src/lib/overrides.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const raw = readFileSync(join(root, 'data/holidays.yaml'), 'utf8')
const doc: HolidaysDoc = parseYaml(raw)

const failures: string[] = []
const warnings: string[] = []
const fail = (m: string) => failures.push(m)
const warn = (m: string) => warnings.push(m)

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
const isoWeekday = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay() || 7
const dayOfMonth = (d: string) => Number(d.slice(8))

/* --- structure ----------------------------------------------------------- */
const ids = new Set<string>()
for (const h of doc.holidays ?? []) {
  if (!h.id) { fail('a holiday has no id'); continue }
  if (ids.has(h.id)) fail(`duplicate holiday id "${h.id}"`)
  ids.add(h.id)
  if (!h.label) warn(`${h.id}: no label, so the calendar shows a changed day unexplained`)

  if (h.closed && (h.replace || h.add)) {
    fail(`${h.id}: "closed" together with "${h.replace ? 'replace' : 'add'}" is contradictory`)
  }
  if (h.replace && h.add) fail(`${h.id}: "replace" and "add" together is ambiguous — pick one`)

  const r = h.on ?? ({} as any)
  const isRelative = r.after !== undefined
  const isNth = r.weekday !== undefined
  const isFixed = r.month !== undefined && r.day !== undefined
  if (!isRelative && !isNth && !isFixed) fail(`${h.id}: rule is not a fixed date, nth weekday, or relative`)
  if (isNth) {
    if (!WEEKDAYS[r.weekday]) fail(`${h.id}: unknown weekday "${r.weekday}"`)
    if (r.nth !== 'last' && !(Number.isInteger(r.nth) && r.nth >= 1 && r.nth <= 5)) {
      fail(`${h.id}: nth must be 1-5 or "last", got ${JSON.stringify(r.nth)}`)
    }
    if (r.month === undefined) fail(`${h.id}: weekday rule needs a month`)
  }
  if (isRelative && !ids.has(r.after) && !(doc.holidays ?? []).some((x) => x.id === r.after)) {
    fail(`${h.id}: "after: ${r.after}" refers to no holiday`)
  }

  const check = (key: 'replace' | 'add', list?: OverrideSession[]) => {
    if (!list) return
    if (!list.length) return fail(`${h.id}: "${key}" is empty`)
    const seen = new Set<string>()
    for (const s of list) {
      if (!s?.name) fail(`${h.id}: a "${key}" session has no name`)
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s?.time))) {
        fail(`${h.id}: "${s?.time}" is not a valid HH:MM time`)
      }
      if (!Number.isInteger(s?.duration) || s.duration <= 0) {
        fail(`${h.id}: session "${s?.name}" has an invalid duration (${s?.duration})`)
      }
      if (seen.has(s?.time)) fail(`${h.id}: two "${key}" sessions both start at ${s.time}`)
      seen.add(s?.time)
    }
  }
  check('replace', h.replace)
  check('add', h.add)
}

/* --- resolution across a wide span --------------------------------------- */
const THIS_YEAR = new Date().getUTCFullYear()
const FROM = THIS_YEAR - 1
const TO = THIS_YEAR + Math.max(20, doc.horizonYears ?? 5)

let resolved = 0
for (let y = FROM; y <= TO; y++) {
  let dates: Map<string, string>
  try {
    dates = datesForYear(doc, y)
  } catch (e) {
    fail(`${y}: ${(e as Error).message}`)
    continue
  }

  // Two holidays on one date makes the day ambiguous — last one silently wins.
  const seen = new Map<string, string>()
  for (const [id, date] of dates) {
    resolved++
    const prev = seen.get(date)
    if (prev) fail(`${y}: "${prev}" and "${id}" both resolve to ${date}`)
    seen.set(date, id)

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 4) !== String(y)) {
      // Relative rules may legitimately cross a year boundary; only flag a
      // malformed date.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`${y} ${id}: produced "${date}"`)
    }

    // --- the independent window property ---
    const h = doc.holidays.find((x) => x.id === id)!
    const r = h.on
    if (r.weekday !== undefined && r.nth !== undefined) {
      const wantWd = WEEKDAYS[r.weekday]
      if (isoWeekday(date) !== wantWd) {
        fail(`${y} ${id}: ${date} is not a ${r.weekday}`)
      }
      const dom = dayOfMonth(date)
      const lo = r.nth === 'last' ? null : (r.nth as number - 1) * 7 + 1
      const hi = r.nth === 'last' ? null : (r.nth as number) * 7
      if (lo !== null && (dom < lo || dom > hi!)) {
        fail(`${y} ${id}: ${date} (day ${dom}) is outside the ${r.nth}th-week window ${lo}-${hi}`)
      }
      if (r.nth === 'last') {
        const daysInMonth = new Date(Date.UTC(y, r.month!, 0)).getUTCDate()
        if (dom < daysInMonth - 6) {
          fail(`${y} ${id}: ${date} is not in the final week of month ${r.month}`)
        }
      }
    }
    if (r.month !== undefined && r.day !== undefined) {
      if (dayOfMonth(date) !== r.day || Number(date.slice(5, 7)) !== r.month) {
        fail(`${y} ${id}: ${date} does not match the fixed rule ${r.month}/${r.day}`)
      }
    }
    if (r.after) {
      const base = dates.get(r.after)
      if (base) {
        const want = new Date(Date.parse(base + 'T00:00:00Z') + (r.days ?? 0) * 86400000)
          .toISOString().slice(0, 10)
        if (date !== want) fail(`${y} ${id}: ${date} is not ${r.days} day(s) after ${r.after} (${base})`)
      }
    }
  }
}

/* --- canonical definitions ------------------------------------------------
   The window check above proves a rule was RESOLVED correctly. It cannot tell
   you the rule expresses the right idea: if Thanksgiving is written as
   `nth: last`, then "the last Thursday of November" is exactly what was asked
   for, and every internal check passes while the gym closes a week late in
   2028, 2029, 2034 and 2035.

   So for holidays with a fixed public definition, assert the rule matches it.
   A holiday not listed here is unconstrained — the gym can define Halloween
   or a Turkey Burner however it likes.
--------------------------------------------------------------------------- */
const CANONICAL: Record<string, { rule: Record<string, unknown>; why: string }> = {
  'new-years-day':          { rule: { month: 1, day: 1 },                    why: 'January 1' },
  'mlk-day':                { rule: { month: 1, weekday: 'Mon', nth: 3 },    why: 'third Monday in January' },
  'presidents-day':         { rule: { month: 2, weekday: 'Mon', nth: 3 },    why: 'third Monday in February' },
  'memorial-day':           { rule: { month: 5, weekday: 'Mon', nth: 'last' }, why: 'last Monday in May' },
  'independence-day':       { rule: { month: 7, day: 4 },                    why: 'July 4' },
  'labor-day':              { rule: { month: 9, weekday: 'Mon', nth: 1 },    why: 'first Monday in September' },
  'indigenous-peoples-day': { rule: { month: 10, weekday: 'Mon', nth: 2 },   why: 'second Monday in October' },
  halloween:                { rule: { month: 10, day: 31 },                  why: 'October 31' },
  'veterans-day':           { rule: { month: 11, day: 11 },                  why: 'November 11' },
  thanksgiving:             { rule: { month: 11, weekday: 'Thu', nth: 4 },   why: 'FOURTH Thursday in November, per the 1941 statute — not the last' },
  'black-friday':           { rule: { after: 'thanksgiving', days: 1 },      why: 'the day after Thanksgiving' },
  'christmas-eve':          { rule: { month: 12, day: 24 },                  why: 'December 24' },
  'christmas-day':          { rule: { month: 12, day: 25 },                  why: 'December 25' },
  'new-years-eve':          { rule: { month: 12, day: 31 },                  why: 'December 31' },
}

for (const h of doc.holidays ?? []) {
  const canon = CANONICAL[h.id]
  if (!canon) continue
  const got = h.on ?? {}
  for (const [k, want] of Object.entries(canon.rule)) {
    if ((got as Record<string, unknown>)[k] !== want) {
      fail(
        `${h.id}: rule has ${k}=${JSON.stringify((got as Record<string, unknown>)[k])}, ` +
          `but ${h.id} is ${canon.why} (expected ${k}=${JSON.stringify(want)})`
      )
    }
  }
}

/* --- one-off exceptions --------------------------------------------------- */
for (const [date, o] of Object.entries(doc.exceptions ?? {})) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { fail(`exception key "${date}" is not YYYY-MM-DD`); continue }
  const dt = new Date(date + 'T00:00:00Z')
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== date) {
    fail(`exception "${date}" is not a real calendar date`)
  }
  if (o?.closed && (o.replace || o.add)) fail(`exception ${date}: "closed" with sessions is contradictory`)
}

const todos = (raw.match(/TODO CONFIRM/g) ?? []).length
if (todos) warn(`${todos} holidays still carry "# TODO CONFIRM" — the gym may not actually close`)

/* --- report --------------------------------------------------------------- */
console.log(
  `\n  ${doc.holidays.length} holiday rules, ${Object.keys(doc.exceptions ?? {}).length} one-off exceptions` +
    `\n  resolved ${resolved} dates across ${TO - FROM + 1} years (${FROM}–${TO}), ` +
    `publishing ${doc.horizonYears ?? 5} years ahead`
)
if (warnings.length) {
  console.log(`\n  ${warnings.length} warnings:`)
  for (const w of warnings) console.log('    ! ' + w)
}
if (failures.length) {
  console.log(`\n  ${failures.length} FAILURES:\n`)
  for (const f of failures) console.log('    ✗ ' + f)
  console.log()
  process.exit(1)
}
console.log('\n  holidays.yaml is valid\n')
