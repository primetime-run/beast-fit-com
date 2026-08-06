#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   data/training.yaml  ->  infra/lambda/catalog.json

   The browser never sends a price. It sends a product id and an option label,
   and the Lambda looks the price up in this file. That is the whole point:
   a price posted from the client is a price the customer can edit, and
   "$1,380 membership for $1.38" is a form field away otherwise.

   Generating it from the same YAML the site renders means the page and the
   charge cannot disagree. Run it as part of the build, and re-run it after
   any price change — `npm run build` does this for you.

   Amounts are written in CENTS as integers. Authorize.Net wants a decimal
   string, but doing the arithmetic in floats is how you end up submitting
   1379.9999999999998. The Lambda formats cents to a string at the last
   moment.
--------------------------------------------------------------------------- */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { optionKey } from '../src/lib/option-key.mjs'

const SRC = 'data/training.yaml'
const OUT = 'infra/lambda/catalog.json'

const { products } = parseYaml(readFileSync(SRC, 'utf8'))

const slug = optionKey

const catalog = {}
const collisions = []

for (const p of products) {
  const options = {}
  for (const o of p.options) {
    const key = slug(o.label)
    if (options[key]) collisions.push(`${p.id}/${key}`)
    if (!Number.isFinite(o.price) || o.price <= 0) {
      throw new Error(`${p.id}: option "${o.label}" has a non-positive price`)
    }
    options[key] = {
      label: o.label,
      // Integer cents. Prices in the YAML are whole dollars today; rounding
      // here keeps that true even if someone writes 74.5 later.
      cents: Math.round(o.price * 100),
    }
  }
  catalog[p.id] = { name: p.name, url: p.url, options }
}

if (collisions.length) {
  throw new Error(`Duplicate option keys: ${collisions.join(', ')}`)
}

/* ---------------------------------------------------------------------------
   The $1 smoke test.

   Defined here rather than in data/training.yaml on purpose: everything in
   that file renders on /training/ and in the product pages' structured data,
   and a "$1.00 test charge" offer has no business in either. Adding it here
   means the Lambda will honour it and the site will never advertise it.

   It stays in the production catalog deliberately. Charging yourself a real
   dollar on the live account is the only way to prove the live keys, the live
   webhook and the settlement path actually work — sandbox proves the code,
   not the account. Refund it from the Merchant Interface afterwards.

   Reachable at /checkout/test/, which is noindex and linked from nowhere.
--------------------------------------------------------------------------- */
if (catalog.test) throw new Error('a real product is using the reserved id "test"')
catalog.test = {
  name: 'Test charge',
  url: '/checkout/test/',
  options: {
    'one-dollar': { label: '$1.00 test charge', cents: 100 },
  },
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(catalog, null, 2) + '\n')

const count = Object.values(catalog).reduce((n, p) => n + Object.keys(p.options).length, 0)
console.log(`catalog: ${Object.keys(catalog).length} products, ${count} options -> ${OUT}`)
