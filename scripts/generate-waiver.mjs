#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   data/waiver.yaml  ->  infra/lambda-waiver/waiver.json  (+ the logo)

   The page renders the YAML; the PDF is built from this JSON. Generating one
   from the other is what stops the signed document and the page a person read
   from drifting apart — which for a legal record is the whole point. If they
   disagree, the gym cannot say what someone actually agreed to.

   The logo is copied in rather than referenced, because the Lambda has no
   access to the site's assets at runtime. logo.png and not logo-dark.png: the
   dark one is white-on-transparent and would be invisible on a white page.

   Run as part of `npm run build`.
--------------------------------------------------------------------------- */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse as parseYaml } from 'yaml'

const SRC = 'data/waiver.yaml'
const OUT = 'infra/lambda-waiver/waiver.json'
const LOGO_SRC = 'src/assets/logo.png'
const LOGO_OUT = 'infra/lambda-waiver/logo.png'

const doc = parseYaml(readFileSync(SRC, 'utf8'))

for (const key of ['version', 'title', 'sections', 'acknowledgements']) {
  if (!doc[key]) throw new Error(`${SRC}: missing "${key}"`)
}
if (!Array.isArray(doc.sections) || doc.sections.length === 0) {
  throw new Error(`${SRC}: sections must be a non-empty list`)
}
if (!Array.isArray(doc.acknowledgements) || doc.acknowledgements.length === 0) {
  throw new Error(`${SRC}: acknowledgements must be a non-empty list`)
}
for (const [i, s] of doc.sections.entries()) {
  if (!s.heading || !s.body) throw new Error(`${SRC}: section ${i + 1} needs a heading and a body`)
}

/* Loud, because a placeholder waiver going live is the failure mode that
   matters here — the gym would believe it is covered when it is not. */
if (/PLACEHOLDER/i.test(JSON.stringify(doc))) {
  console.warn('\n  ⚠  data/waiver.yaml still contains PLACEHOLDER text.')
  console.warn('     This is not a usable legal document until an attorney has')
  console.warn('     replaced it. The build continues so the page can be tested.\n')
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n')
copyFileSync(LOGO_SRC, LOGO_OUT)

console.log(
  `waiver: v${doc.version}, ${doc.sections.length} sections, ` +
    `${doc.acknowledgements.length} acknowledgements -> ${OUT}`
)
