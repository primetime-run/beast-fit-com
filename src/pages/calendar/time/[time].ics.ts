/* One file per time of day — "whatever is on at 5:30, every day it runs".
   Same reasoning as the slot files: a real URL beats a browser-built blob on
   mobile. */

import type { APIRoute, GetStaticPaths } from 'astro'
import { schedule, overrides, SERIES_FROM, SERIES_UNTIL } from '../../../lib/data.ts'
import { generateSchedule } from '../../../lib/schedule.ts'
import { buildCalendar, seriesEvents } from '../../../lib/ics.ts'

/** "05:30" -> "0530" */
export const timeId = (time: string) => time.replace(':', '')

export const getStaticPaths: GetStaticPaths = () => {
  const times = new Set<string>()
  for (const c of schedule.classes) for (const s of c.slots) for (const t of s.times) times.add(t)
  return [...times].sort().map((t) => ({ params: { time: timeId(t) }, props: { time: t } }))
}

export const GET: APIRoute = ({ props }) => {
  const { time } = props as { time: string }

  const days = generateSchedule(schedule, overrides, SERIES_FROM, SERIES_UNTIL)
  const events = seriesEvents(schedule, days, SERIES_FROM, SERIES_UNTIL).filter(
    (e) => e.time === time
  )

  return new Response(buildCalendar(events, `BEAST Fitness — ${time}`), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="beast-fit-${timeId(time)}.ics"`,
    },
  })
}
