/* ---------------------------------------------------------------------------
   Prints generated schedule days to the terminal, for eyeballing holiday
   rules without building the site.

   Run:  npm run schedule -- 2026-11-25 2026-11-28
         npm run schedule                      (next 14 days)
--------------------------------------------------------------------------- */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { generateSchedule, type ScheduleDoc } from '../src/lib/schedule.ts'
import { resolveOverrides, type HolidaysDoc } from '../src/lib/holidays.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const schedule: ScheduleDoc = parseYaml(readFileSync(join(root, 'data/schedule.yaml'), 'utf8'))
const holidayDoc: HolidaysDoc = parseYaml(readFileSync(join(root, 'data/holidays.yaml'), 'utf8'))

const [from, to] = process.argv.slice(2)
const start = from ?? new Date().toISOString().slice(0, 10)
const end = to ?? new Date(Date.parse(start + 'T00:00:00Z') + 13 * 86400000).toISOString().slice(0, 10)

const overrides = resolveOverrides(
  holidayDoc,
  Number(start.slice(0, 4)) - 1,
  Number(end.slice(0, 4)) + 1
)

const NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

for (const day of generateSchedule(schedule, overrides, start, end)) {
  const tag = day.label ? `  ${day.label} [${day.kind}]` : ''
  console.log(`\n${day.date}  ${NAMES[day.weekday]}${tag}`)
  if (day.closed) { console.log('    CLOSED'); continue }
  if (!day.sessions.length) { console.log('    (no classes)'); continue }
  for (const s of day.sessions) {
    console.log(`    ${s.time}  ${s.name}  (${s.duration}m)${s.special ? '  <- override' : ''}`)
  }
}
console.log()
