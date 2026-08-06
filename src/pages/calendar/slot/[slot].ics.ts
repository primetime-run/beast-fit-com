/* One file per class time-slot — "every Monday at 5:30, Cardio Conditioning".

   These exist so the add-to-calendar dialog can hand out a real URL instead
   of a blob built in the browser. On iOS Safari a blob with a `download`
   attribute frequently opens as plain text or does nothing at all, while a
   served text/calendar URL opens Calendar's preview sheet. Same content,
   completely different experience on the device most members use. */

import type { APIRoute, GetStaticPaths } from 'astro'
import { schedule, overrides, SERIES_FROM, SERIES_UNTIL } from '../../../lib/data.ts'
import { generateSchedule } from '../../../lib/schedule.ts'
import { buildCalendar, seriesEvents } from '../../../lib/ics.ts'

/** cardio-conditioning--Mon-0530 */
export const slotId = (classId: string, day: string, time: string) =>
  `${classId}--${day}-${time.replace(':', '')}`

export const getStaticPaths: GetStaticPaths = () =>
  schedule.classes.flatMap((c) =>
    c.slots.flatMap((s) =>
      s.times.map((t) => ({
        params: { slot: slotId(c.id, s.day, t) },
        props: { classId: c.id, name: c.name, day: s.day, time: t },
      }))
    )
  )

export const GET: APIRoute = ({ props }) => {
  const { classId, name, day, time } = props as {
    classId: string; name: string; day: string; time: string
  }

  const days = generateSchedule(schedule, overrides, SERIES_FROM, SERIES_UNTIL)
  const all = seriesEvents(schedule, days, SERIES_FROM, SERIES_UNTIL, classId)

  // seriesEvents emits one event per slot; keep just this weekday and time.
  const events = all.filter((e) => e.time === time && e.uid.includes(day.toLowerCase()))

  return new Response(buildCalendar(events, `${name} — ${day} ${time}`), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="beast-fit-${slotId(classId, day, time)}.ics"`,
    },
  })
}
