/* ---------------------------------------------------------------------------
   Asserts every path in url-inventory.json still resolves in dist/.

   The point of the rebuild was that addresses people already link to keep
   working. A refactor that quietly renames a route would otherwise only be
   noticed by whoever clicks the dead link — this fails the build instead.

   It also does a few cheap SEO checks on every built page, because the same
   refactor that drops a route tends to drop a <title> too.

   Run: npm run verify-urls   (after npm run build)
--------------------------------------------------------------------------- */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

if (!existsSync(dist)) {
  console.error('\n  dist/ does not exist — run `npm run build` first.\n')
  process.exit(1)
}

const inventory = JSON.parse(readFileSync(join(root, 'url-inventory.json'), 'utf8'))
const failures = []
const warnings = []

/* --- 1. every preserved URL resolves ------------------------------------ */
for (const entry of inventory) {
  const rel = entry.from === '/' ? 'index.html' : join(entry.from.replace(/^\/|\/$/g, ''), 'index.html')
  const file = join(dist, rel)
  if (!existsSync(file)) {
    failures.push(`${entry.from} (${entry.title}) — no ${rel} in dist/`)
    continue
  }
  const html = readFileSync(file, 'utf8')
  if (!/<title>[^<]+<\/title>/.test(html)) failures.push(`${entry.from} — missing <title>`)
  if (!/<link rel="canonical"/.test(html)) failures.push(`${entry.from} — missing canonical`)
}

/* --- 2. cheap SEO checks across every page ------------------------------ */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') ? [p] : []
  })
}

const pages = walk(dist)
for (const p of pages) {
  const rel = '/' + p.slice(dist.length + 1)

  /* /checkout/ is machinery, not content — the iframe communicator is a bare
     relay page with no prose to describe, and the receipt and payment-test
     pages are noindex. Holding them to on-page SEO rules produces failures
     whose only available fix is to invent a description for a page no search
     engine will ever be shown. Kept out of the sitemap for the same reason. */
  if (rel.startsWith('/checkout/')) continue

  const html = readFileSync(p, 'utf8')

  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? ''
  const h1s = html.match(/<h1[\s>]/g)?.length ?? 0

  if (!title) failures.push(`${rel} — no <title>`)
  else if (title.length > 65) warnings.push(`${rel} — title is ${title.length} chars (over ~65 gets truncated)`)

  if (!desc) failures.push(`${rel} — no meta description`)
  else if (desc.length > 160) warnings.push(`${rel} — description is ${desc.length} chars (over ~160 gets truncated)`)

  if (h1s === 0) warnings.push(`${rel} — no <h1>`)
  if (h1s > 1) warnings.push(`${rel} — ${h1s} <h1> elements`)

  if (!/property="og:image"/.test(html)) warnings.push(`${rel} — no og:image`)

  // Images without alt text are both an accessibility and an SEO problem.
  const imgs = html.match(/<img\b[^>]*>/g) ?? []
  const noAlt = imgs.filter((t) => !/\balt=/.test(t)).length
  if (noAlt) failures.push(`${rel} — ${noAlt} <img> without alt`)
}

/* --- 3. sitemap and robots --------------------------------------------- */
if (!existsSync(join(dist, 'sitemap-index.xml'))) failures.push('no sitemap-index.xml')
if (!existsSync(join(dist, 'robots.txt'))) failures.push('no robots.txt')

/* --- report ------------------------------------------------------------- */
console.log(`\n  ${inventory.length} preserved URLs checked, ${pages.length} pages scanned`)
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
console.log('  every preserved URL resolves; no SEO failures\n')
