/* ---------------------------------------------------------------------------
   Builds a static map image of the gym from OpenStreetMap tiles.

   Run once and commit the result:  npm run generate-map

   Deliberately NOT part of `npm run build`:

     * CI would then depend on a third-party host being up to produce a page.
     * OpenStreetMap's tile policy is for end-user viewing, not automated
       bulk fetching. Running this by hand, occasionally, for one location is
       within that; hammering it on every deploy is not.

   The result is self-hosted, so it can be cached, preloaded and served from
   the same domain — and no visitor ever makes a request to a third party to
   see where the gym is.

   ODbL requires attribution wherever this image is shown. The Directions
   component prints "© OpenStreetMap contributors" beneath it; do not remove
   that.
--------------------------------------------------------------------------- */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const loc = parseYaml(readFileSync(join(root, 'data/location.yaml'), 'utf8'))

const ZOOM = 16
const TILE = 256
const OUT_W = 900
const OUT_H = 600

// Web Mercator: which tile, and where inside it, a coordinate falls.
const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}

const fx = lonToX(loc.lng, ZOOM)
const fy = latToY(loc.lat, ZOOM)

// Enough tiles to cover the output with a margin for the centre crop.
const cols = Math.ceil(OUT_W / TILE) + 2
const rows = Math.ceil(OUT_H / TILE) + 2
const x0 = Math.floor(fx) - Math.floor(cols / 2)
const y0 = Math.floor(fy) - Math.floor(rows / 2)

const UA = 'beast-fit.com static map generator (one-off, contact: kevin@beast-fit.com)'

async function tile(x, y) {
  const url = `https://tile.openstreetmap.org/${ZOOM}/${x}/${y}.png`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`tile ${x},${y} -> HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

console.log(`  fetching ${cols * rows} tiles at zoom ${ZOOM} …`)
const composites = []
for (let dy = 0; dy < rows; dy++) {
  for (let dx = 0; dx < cols; dx++) {
    composites.push({
      input: await tile(x0 + dx, y0 + dy),
      left: dx * TILE,
      top: dy * TILE,
    })
    // Be a considerate client: one request at a time, with a small gap.
    await new Promise((r) => setTimeout(r, 120))
  }
}

const canvasW = cols * TILE
const canvasH = rows * TILE
const stitched = await sharp({
  create: { width: canvasW, height: canvasH, channels: 3, background: '#e8e0d8' },
})
  .composite(composites)
  .png()
  .toBuffer()

// Crop so the gym sits dead centre.
const pxX = (fx - x0) * TILE
const pxY = (fy - y0) * TILE
const left = Math.round(Math.max(0, Math.min(canvasW - OUT_W, pxX - OUT_W / 2)))
const top = Math.round(Math.max(0, Math.min(canvasH - OUT_H, pxY - OUT_H / 2)))

const markerX = Math.round(pxX - left)
const markerY = Math.round(pxY - top)

// Brand-green pin, plus the attribution ODbL requires.
const overlay = Buffer.from(`<svg width="${OUT_W}" height="${OUT_H}" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(${markerX - 18}, ${markerY - 44})">
    <path d="M18 0C8.1 0 0 8.1 0 18c0 13.5 18 26 18 26s18-12.5 18-26C36 8.1 27.9 0 18 0z"
          fill="#8bc34a" stroke="#0a0a0a" stroke-width="2.5"/>
    <circle cx="18" cy="18" r="6.5" fill="#0a0a0a"/>
  </g>
  <rect x="0" y="${OUT_H - 20}" width="${OUT_W}" height="20" fill="rgba(255,255,255,.78)"/>
  <text x="${OUT_W - 8}" y="${OUT_H - 6}" text-anchor="end"
        font-family="Helvetica,Arial,sans-serif" font-size="11" fill="#222">© OpenStreetMap contributors</text>
</svg>`)

/*
  Written to public/, not src/assets/, so it bypasses astro:assets.

  The pipeline made this image worse in both formats — WebP 89 kB, PNG
  re-encode 186 kB, against a 76 kB source — because it strips the palette and
  emits truecolour. Map tiles are flat colour with hard edges, which a palette
  PNG encodes better than anything else. Both sizes are written here so the
  srcset in Directions.astro has something to point at.
*/
mkdirSync(join(root, 'public/map'), { recursive: true })

const base = await sharp(stitched)
  .extract({ left, top, width: OUT_W, height: OUT_H })
  .composite([{ input: overlay, left: 0, top: 0 }])
  .toBuffer()

const png = { palette: true, colours: 128, compressionLevel: 9, effort: 10 }
const outputs = [
  ['public/map/location.png', OUT_W],
  ['public/map/location-450.png', 450],
]

const { statSync } = await import('node:fs')
for (const [rel, w] of outputs) {
  const file = join(root, rel)
  await sharp(base).resize(w).png(png).toFile(file)
  console.log(`  wrote ${rel.padEnd(28)} ${w}px  ${statSync(file).size.toLocaleString()} B`)
}
console.log('  attribution is baked into the image AND printed by Directions.astro — keep both.')
