/* Single place that reads the data files, so pages and endpoints agree. */

import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { ScheduleDoc } from './schedule.ts'
import type { OverridesDoc } from './overrides.ts'
import { resolveOverrides, type HolidaysDoc } from './holidays.ts'
import { renderPolicy, type PolicyDoc } from './policy.ts'

export const schedule: ScheduleDoc = parseYaml(readFileSync('data/schedule.yaml', 'utf8'))
export const holidayDoc: HolidaysDoc = parseYaml(readFileSync('data/holidays.yaml', 'utf8'))

export interface HomeDoc {
  hero: string[]
  closing?: string
  headings: Record<string, string>
}

/** All home page copy, so wording changes never touch a component. */
export const home: HomeDoc = parseYaml(readFileSync('data/home.yaml', 'utf8'))

export interface TrainingOption {
  label: string
  price: number
  /** Original price, when this is a reduction. */
  was?: number
  note?: string
  highlight?: boolean
}

export interface Product {
  id: string
  name: string
  /** The original WordPress path. Kept alive by the rebuild. */
  url: string
  summary: string
  description: string
  options: TrainingOption[]
}

export const training: { products: Product[] } = parseYaml(
  readFileSync('data/training.yaml', 'utf8')
)

export interface Trainer {
  id: string
  name: string
  role: string
  photo: string
  email?: string
  motto?: string
  hometown?: string
  college?: string
  certifications: string[]
  specialties: string[]
  quote?: string
  bio: string[]
}

export const trainers: { trainers: Trainer[] } = parseYaml(
  readFileSync('data/trainers.yaml', 'utf8')
)

export interface LocationDoc {
  name: string
  street: string
  city: string
  state: string
  zip: string
  country: string
  lat: number
  lng: number
  /** How to find it once you are there. Shown right under the address. */
  landmark?: string
  notes?: string[]
}

export const location: LocationDoc = parseYaml(readFileSync('data/location.yaml', 'utf8'))

/** One line, for headers and footers. */
export const addressLine = (l: LocationDoc = location) =>
  `${l.street}, ${l.city}, ${l.state} ${l.zip}`

/**
 * Deep links that open the visitor's own maps app rather than embedding a
 * third-party map on the page. No script, no cookies, and it hands off to
 * whatever they already use for navigation.
 */
export const directions = (l: LocationDoc = location) => {
  const ll = `${l.lat},${l.lng}`
  const addr = encodeURIComponent(addressLine(l))
  return {
    /*
      Coordinates only, and no `q`.

      Passing `q` alongside `daddr` sent Apple Maps to Nashville: it treats
      `q` as a global search, that search wins over the destination, and
      "Seacrest Soccer Complex" matched something else entirely. A lat/lng
      `daddr` cannot be misread. `dirflg=d` opens straight into driving
      directions.
    */
    apple: `https://maps.apple.com/?daddr=${ll}&dirflg=d`,

    // Google geocodes the written address reliably and labels the pin with
    // it, which reads better than a coordinate pair.
    google: `https://www.google.com/maps/dir/?api=1&destination=${addr}&travelmode=driving`,

    waze: `https://waze.com/ul?ll=${ll}&navigate=yes`,
    osm: `https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=16/${l.lat}/${l.lng}`,
  }
}

/** The map iframe source — only ever loaded after a click. */
export const osmEmbed = (l: LocationDoc = location) => {
  const d = 0.006
  const bbox = [l.lng - d, l.lat - d * 0.6, l.lng + d, l.lat + d * 0.6].join(',')
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${l.lat},${l.lng}`
}

/** Shared address block for structured data, so every page agrees. */
export const gymSchema = (l: LocationDoc = location) => ({
  '@type': 'ExerciseGym',
  name: 'BEAST Fitness',
  url: 'https://beast-fit.com/',
  address: {
    '@type': 'PostalAddress',
    streetAddress: l.street,
    addressLocality: l.city,
    addressRegion: l.state,
    postalCode: l.zip,
    addressCountry: l.country,
  },
  geo: { '@type': 'GeoCoordinates', latitude: l.lat, longitude: l.lng },
  hasMap: `https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}`,
})

/** The privacy policy. Structure in YAML, no markup — see src/lib/policy.ts. */
export const privacy: PolicyDoc = parseYaml(readFileSync('data/privacy-policy.yaml', 'utf8'))

/* The waiver. The same file feeds the PDF the Lambda renders — see
   scripts/generate-waiver.mjs — so the page someone reads and the document
   they sign cannot drift apart. */
export type WaiverDoc = {
  version: string
  title: string
  intro?: string
  sections: { heading: string; body: string }[]
  acknowledgements: string[]
}
export const waiver: WaiverDoc = parseYaml(readFileSync('data/waiver.yaml', 'utf8'))

/** Rendered at build time; the page only ever sees finished HTML. */
export const privacyHtml: string = renderPolicy(privacy)

/** Cheapest option in a product — derived, never hard-coded, so the home
 *  page can never drift out of step with the price list. */
export const fromPrice = (p: Product) => Math.min(...p.options.map((o) => o.price))

export const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

export const buildToday = new Date().toISOString().slice(0, 10)
const thisYear = Number(buildToday.slice(0, 4))

/* Rules are perpetual, so this horizon is only how far the published calendar
   looks — not a limit on the data. Bumping horizonYears in holidays.yaml is
   the only thing needed to publish further ahead. */
export const HORIZON_YEARS = holidayDoc.horizonYears ?? 5
export const FIRST_YEAR = thisYear
export const LAST_YEAR = thisYear + HORIZON_YEARS
export const COVERED_THROUGH = `${LAST_YEAR}-12-31`

/** Holiday rules resolved to concrete dates, plus one-off exceptions. */
export const overrides: OverridesDoc = resolveOverrides(holidayDoc, FIRST_YEAR - 1, LAST_YEAR)

/** Series anchor at the start of the current year so rebuilds within a year
 *  produce byte-identical files. */
export const SERIES_FROM = `${thisYear}-01-01`
export const SERIES_UNTIL = COVERED_THROUGH
