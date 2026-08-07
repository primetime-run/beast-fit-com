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

for (const key of ['version', 'title', 'paragraphs', 'acknowledgements']) {
  if (!doc[key]) throw new Error(`${SRC}: missing "${key}"`)
}
if (!Array.isArray(doc.paragraphs) || doc.paragraphs.length === 0) {
  throw new Error(`${SRC}: paragraphs must be a non-empty list`)
}
/* The name token has to survive into the PDF. Losing it would produce a
   document naming nobody, which is worse than one that fails to build. */
if (!doc.paragraphs.some((t) => String(t).includes('{{name}}'))) {
  throw new Error(`${SRC}: no {{name}} token — the signer would not be named in the agreement`)
}
if (!Array.isArray(doc.acknowledgements) || doc.acknowledgements.length === 0) {
  throw new Error(`${SRC}: acknowledgements must be a non-empty list`)
}
for (const [i, t] of doc.paragraphs.entries()) {
  if (typeof t !== 'string' || !t.trim()) throw new Error(`${SRC}: paragraph ${i + 1} is empty`)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n')
copyFileSync(LOGO_SRC, LOGO_OUT)

console.log(
  `waiver: ${doc.version}, ${doc.paragraphs.length} paragraphs, ` +
    `${doc.acknowledgements.length} acknowledgements -> ${OUT}`
)
