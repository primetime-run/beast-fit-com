/* One file per class — "add every Cardio Conditioning session" — as recurring
   series with holiday closures excluded. */

import type { APIRoute, GetStaticPaths } from 'astro'
import { schedule, overrides, SERIES_FROM, SERIES_UNTIL } from '../../lib/data.ts'
import { generateSchedule } from '../../lib/schedule.ts'
import { buildCalendar, seriesEvents } from '../../lib/ics.ts'

export const getStaticPaths: GetStaticPaths = () =>
  schedule.classes.map((c) => ({ params: { classId: c.id }, props: { name: c.name } }))

export const GET: APIRoute = ({ params, props }) => {
  const classId = params.classId!
  const days = generateSchedule(schedule, overrides, SERIES_FROM, SERIES_UNTIL)
  const events = seriesEvents(schedule, days, SERIES_FROM, SERIES_UNTIL, classId)

  return new Response(buildCalendar(events, `BEAST Fitness — ${props.name}`), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="beast-fit-${classId}.ics"`,
    },
  })
}
