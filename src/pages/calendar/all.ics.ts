/* Every class as a recurring series, plus every holiday special session.
   This is the "add the whole schedule" download. */

import type { APIRoute } from 'astro'
import { schedule, overrides, SERIES_FROM, SERIES_UNTIL } from '../../lib/data.ts'
import { generateSchedule } from '../../lib/schedule.ts'
import { buildCalendar, seriesEvents, specialEvents } from '../../lib/ics.ts'

export const GET: APIRoute = () => {
  const days = generateSchedule(schedule, overrides, SERIES_FROM, SERIES_UNTIL)
  const events = [
    ...seriesEvents(schedule, days, SERIES_FROM, SERIES_UNTIL),
    ...specialEvents(days),
  ]
  return new Response(buildCalendar(events, 'BEAST Fitness — All Classes'), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="beast-fit-all-classes.ics"',
    },
  })
}
