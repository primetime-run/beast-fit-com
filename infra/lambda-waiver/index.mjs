/* ---------------------------------------------------------------------------
   Waiver handler — renders a signed PDF, archives it, emails it.

   This one holds more than a contact form does. A waiver carries a name, a
   date of birth, an emergency contact, and for a minor a guardian's details
   too. Three rules follow from that and none of them are optional:

     1. Never log the payload. Not on error, not for debugging. CloudWatch is
        not a place to keep someone's date of birth, and a stack trace that
        includes the request body puts it there permanently.
     2. The archive is the record. Email is a notification; an inbox gets
        migrated, pruned and lost. S3 is what you produce in a dispute years
        later, which is the entire reason this exists.
     3. Nothing is stored that was not asked for. No medical detail, no free
        text beyond what the form collects.

   The PDF is built here rather than in the browser. A document the client
   assembled is a document the client chose the contents of, which for a legal
   record is worthless — the signer could send anything. The server renders
   from its own copy of the text and stamps the version it used.
--------------------------------------------------------------------------- */

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

import waiver from './waiver.json' with { type: 'json' }

const s3 = new S3Client({})
const ses = new SESv2Client({})

const {
  WAIVER_TO,
  WAIVER_FROM,
  ARCHIVE_BUCKET,
  SIGNER_COPY = 'off',
  ALLOWED_ORIGINS = '',
  CHALLENGE_SECRET = '',
  POW_BITS = '18',
} = process.env

const origins = ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
const signerCopyEnabled = SIGNER_COPY === 'on'

const MAX = { name: 100, email: 160, phone: 40, relationship: 60 }
const MIN_FILL_MS = 5000 // a waiver takes longer to read than a contact form

const hits = new Map()
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 4

function rateLimited(ip) {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 1000) hits.clear()
  return recent.length > MAX_PER_WINDOW
}

const reply = (status, body, origin) => ({
  statusCode: status,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  },
  body: JSON.stringify(body),
})

const clean = (v, max) =>
  String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max)

/* --- proof of work ------------------------------------------------------
   A form this quiet is not worth a bot's time unless posting is free, so the
   point is to make it cost something. Two gates, and they work together:

   1. A challenge must be FETCHED. It is HMAC-signed, bound to the caller's
      IP, and expires in two minutes — so a script that POSTs straight at the
      endpoint, which is what nearly all of them do, is refused outright. It
      cannot be forged without the secret and it cannot be lifted from
      somebody else's session.

   2. That challenge must be SOLVED. The client hunts for a nonce whose
      SHA-256 starts with a run of zero bits. A person waits a moment; a bot
      pays that same moment for every single attempt, which is what turns
      bulk submission from free into expensive.

   Neither is a CAPTCHA and neither asks anything of the person filling the
   form. Turnstile could sit on top of this if it is ever wanted, but it adds
   a third-party request to a site that currently makes none.
------------------------------------------------------------------------- */

const powBits = Math.max(1, Math.min(28, Number(POW_BITS) || 18))
const CHALLENGE_TTL_MS = 120_000

const sign = (payload) =>
  createHmac('sha256', CHALLENGE_SECRET).update(payload).digest('hex').slice(0, 32)

function issueChallenge(ip) {
  const nonce = randomUUID()
  const exp = Date.now() + CHALLENGE_TTL_MS
  return { challenge: nonce, exp, bits: powBits, sig: sign(`${nonce}|${exp}|${ip}`) }
}

/** Leading zero BITS, not characters — bits give fine-grained difficulty. */
function meetsDifficulty(hashHex, bits) {
  let remaining = bits
  for (const ch of hashHex) {
    const nibble = parseInt(ch, 16)
    if (remaining >= 4) {
      if (nibble !== 0) return false
      remaining -= 4
    } else {
      return nibble >> (4 - remaining) === 0
    }
    if (remaining === 0) return true
  }
  return remaining === 0
}

function challengeValid({ challenge, exp, sig, solution }, ip) {
  if (!CHALLENGE_SECRET) return true // not configured; the other checks still apply
  if (!challenge || !exp || !sig || solution === undefined) return false
  if (Number(exp) < Date.now()) return false
  // Constant-time is unnecessary here: a forged signature reveals nothing
  // useful by timing, since the challenge is single-use and short-lived.
  if (sign(`${challenge}|${exp}|${ip}`) !== sig) return false
  const hash = createHash('sha256').update(`${challenge}:${solution}`).digest('hex')
  return meetsDifficulty(hash, powBits)
}

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Whole years between a date of birth and today, in UTC. */
function ageOn(dob, when = new Date()) {
  const [y, m, d] = dob.split('-').map(Number)
  let age = when.getUTCFullYear() - y
  const beforeBirthday =
    when.getUTCMonth() + 1 < m || (when.getUTCMonth() + 1 === m && when.getUTCDate() < d)
  if (beforeBirthday) age -= 1
  return age
}

/* --- the document -------------------------------------------------------- */

/* The standard PDF fonts are WinAnsi — Latin-1 and nothing else. Handing
   pdf-lib a character outside that range throws, and an unhandled throw here
   means somebody with a Chinese or Arabic name cannot sign the waiver at all.
   That is a hard block on a legal document, so it has to degrade instead.
   
   Accented Latin survives: é, ü, ñ and the rest are all inside WinAnsi, so
   José and Renée render exactly as typed. Only genuinely outside-Latin-1
   characters are substituted, and when that happens the PDF says so rather
   than quietly showing a name nobody would recognise. The exact string is
   still recorded in the notification email and the object metadata.
   
   Embedding a font with full Unicode coverage would be the complete fix. A
   CJK-capable one is ~16MB in the deploy zip, which is a poor trade for a
   Delray Beach gym — revisit if it ever actually comes up. */
const WIN_ANSI_SAFE = /[^\u0000-\u00ff\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178]/g

let substituted = false
const safe = (str) => {
  const out = String(str).replace(WIN_ANSI_SAFE, '?')
  if (out !== String(str)) substituted = true
  return out
}

const PAGE = { w: 612, h: 792 } // US Letter, in points
const M = 54 // margin

/** Greedy wrap. pdf-lib draws a string as given — it has no concept of a
 *  text box, so anything longer than the measured width simply runs off the
 *  page edge and is silently lost. */
function wrap(text, font, size, maxWidth) {
  const out = []
  for (const paragraph of String(text).split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        out.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    out.push(line)
  }
  return out
}

async function buildPdf(record) {
  substituted = false
  const doc = await PDFDocument.create()
  doc.setTitle(`${waiver.title} — ${record.participantName}`)
  doc.setSubject(`Signed ${record.signedAt}`)
  doc.setProducer('beast-fit.com')
  doc.setCreationDate(new Date(record.signedAt))

  const body = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const logo = await doc.embedPng(readFileSync(new URL('./logo.png', import.meta.url)))

  let page = doc.addPage([PAGE.w, PAGE.h])
  let y = PAGE.h - M
  const width = PAGE.w - M * 2

  const room = (needed) => {
    if (y - needed < M + 24) {
      page = doc.addPage([PAGE.w, PAGE.h])
      y = PAGE.h - M
    }
  }

  const text = (str, { font = body, size = 10, gap = 4, color = rgb(0.1, 0.1, 0.1) } = {}) => {
    for (const line of wrap(str, font, size, width)) {
      room(size + gap)
      page.drawText(safe(line), { x: M, y: y - size, size, font, color })
      y -= size + gap
    }
  }

  // --- masthead
  const logoW = 132
  const logoH = (logo.height / logo.width) * logoW
  page.drawImage(logo, { x: M, y: y - logoH, width: logoW, height: logoH })

  const infoSize = 8
  const info = ['BEAST Fitness', 'Seacrest Soccer Complex', '2505 Seacrest Blvd', 'Delray Beach, FL 33444', 'beast-fit.com']
  info.forEach((line, i) => {
    const w = body.widthOfTextAtSize(line, infoSize)
    page.drawText(line, {
      x: PAGE.w - M - w,
      y: y - infoSize - i * (infoSize + 2),
      size: infoSize,
      font: i === 0 ? bold : body,
      color: rgb(0.35, 0.35, 0.35),
    })
  })
  y -= Math.max(logoH, info.length * (infoSize + 2)) + 22

  page.drawLine({
    start: { x: M, y },
    end: { x: PAGE.w - M, y },
    thickness: 2,
    color: rgb(0.55, 0.76, 0.29),
  })
  y -= 26

  // --- the agreement
  text(waiver.title, { font: bold, size: 13, gap: 6 })
  if (waiver.intro) text(waiver.intro, { size: 9.5, gap: 5, color: rgb(0.3, 0.3, 0.3) })
  y -= 10

  /* Verbatim, unheaded, with the name written into the first paragraph where
     the original has a blank line. Reproducing an attorney's document means
     reproducing it — no headings added, no paragraphs merged. */
  for (const para of waiver.paragraphs) {
    room(40)
    text(para.replace(/\{\{name\}\}/g, record.participantName), { size: 9.5, gap: 4 })
    y -= 10
  }

  // --- what was ticked, individually
  room(30)
  text('Acknowledged', { font: bold, size: 11, gap: 6 })
  for (const a of waiver.acknowledgements) {
    room(16)
    page.drawRectangle({
      x: M, y: y - 9, width: 9, height: 9,
      borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 0.8,
    })
    page.drawText('X', { x: M + 1.8, y: y - 8, size: 8, font: bold, color: rgb(0.1, 0.1, 0.1) })
    for (const [i, line] of wrap(a, body, 9.5, width - 18).entries()) {
      page.drawText(safe(line), { x: M + 18, y: y - 8 - i * 12, size: 9.5, font: body })
      if (i > 0) y -= 12
    }
    y -= 16
  }
  y -= 12

  // --- who signed
  const field = (label, value) => {
    room(16)
    page.drawText(`${label}:`, { x: M, y: y - 9, size: 9, font: bold, color: rgb(0.35, 0.35, 0.35) })
    page.drawText(safe(String(value)), { x: M + 120, y: y - 9, size: 9.5, font: body })
    y -= 15
  }

  room(30)
  text('Participant', { font: bold, size: 11, gap: 6 })
  field('Name', record.participantName)
  field('Date of birth', `${record.dob}  (age ${record.age})`)
  field('Email', record.email)
  field('Phone', record.phone || '—')
  field('Emergency contact', `${record.emergencyName} · ${record.emergencyPhone}`)

  if (record.isMinor) {
    y -= 8
    room(30)
    text('Parent or guardian', { font: bold, size: 11, gap: 6 })
    field('Name', record.guardianName)
    field('Relationship', record.guardianRelationship)
    field('Signature', record.guardianSignature)
  }

  y -= 14
  room(60)
  page.drawLine({ start: { x: M, y }, end: { x: PAGE.w - M, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) })
  y -= 18
  field('Signed by', record.signature)
  field('Date', record.signedAt)

  /* The provenance block. Without it the PDF is a nicely typeset assertion
     and nothing more — this is what ties a document to a submission. */
  y -= 10
  const meta = [
    `Waiver version: ${waiver.version}`,
    `Reference: ${record.id}`,
    `Submitted from: ${record.ip}`,
    `Text fingerprint (SHA-256): ${record.textHash}`,
  ]
  for (const line of meta) {
    room(11)
    page.drawText(safe(line), { x: M, y: y - 7, size: 7.5, font: body, color: rgb(0.45, 0.45, 0.45) })
    y -= 11
  }

  /* Page numbers, added last because "of N" is not knowable until every page
     exists. On a multi-page agreement this is not decoration: without it a
     page can go missing from a printed or scanned copy and nobody can tell,
     which is exactly the argument you would not want to be having about a
     signed release. The version sits alongside for the same reason. */
  {
    const pages = doc.getPages()
    const total = pages.length
    pages.forEach((pg, i) => {
      const label = `Page ${i + 1} of ${total}`
      pg.drawText(safe(String(waiver.version)), {
        x: M, y: M - 18, size: 7, font: body, color: rgb(0.5, 0.5, 0.5),
      })
      pg.drawText(label, {
        x: PAGE.w - M - body.widthOfTextAtSize(label, 7),
        y: M - 18, size: 7, font: body, color: rgb(0.5, 0.5, 0.5),
      })
    })
  }

  /* Said out loud rather than left to be noticed. A waiver showing "?? Chen"
     with no explanation looks like corruption; with this line it is a known
     rendering limit and the real spelling is in the email. */
  if (substituted) {
    room(22)
    y -= 6
    page.drawText(
      'Some characters in the submitted details cannot be shown in this document.',
      { x: M, y: y - 7, size: 7.5, font: body, color: rgb(0.55, 0.3, 0.1) }
    )
    y -= 10
    page.drawText(
      'The exact spelling as entered is recorded in the notification email for this reference.',
      { x: M, y: y - 7, size: 7.5, font: body, color: rgb(0.55, 0.3, 0.1) }
    )
  }

  return Buffer.from(await doc.save())
}

/* --- email with an attachment --------------------------------------------
   SES's Simple content type cannot carry attachments, so this is Raw: a MIME
   document assembled by hand. Base64 has to be wrapped at 76 characters or
   some receivers reject the part outright.
------------------------------------------------------------------------- */
function rawEmail({ from, to, subject, text, filename, pdf }) {
  const boundary = `bf_${randomUUID()}`
  const b64 = pdf.toString('base64').replace(/(.{76})/g, '$1\r\n')
  return Buffer.from(
    [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      text,
      '',
      `--${boundary}`,
      'Content-Type: application/pdf',
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n')
  )
}

export const handler = async (event) => {
  const headers = event.headers ?? {}
  const origin = headers.origin ?? headers.Origin ?? ''
  const allowed = origins.includes(origin) ? origin : null
  const method = event.requestContext?.http?.method ?? 'POST'
  const ip = event.requestContext?.http?.sourceIp ?? 'unknown'

  if (method === 'OPTIONS') return reply(allowed ? 204 : 403, {}, allowed)
  if (method !== 'POST') return reply(405, { error: 'method_not_allowed' }, allowed)
  if (origins.length && !allowed) return reply(403, { error: 'origin_not_allowed' }, null)
  if (rateLimited(ip)) return reply(429, { error: 'rate_limited' }, allowed)

  let body
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return reply(400, { error: 'bad_json' }, allowed)
  }

  /* Handing out a challenge is cheap and stateless, so it sits behind the
     origin check and the rate limit but nothing else. */
  if (body.action === 'challenge') {
    return reply(200, issueChallenge(ip), allowed)
  }

  if (!challengeValid(body, ip)) {
    // Deliberately vague: naming which half failed tells a bot what to fix.
    return reply(403, { error: 'challenge_failed' }, allowed)
  }

  // Honeypot and timing, answered 200 so a bot learns nothing.
  if (String(body.company ?? '').trim() !== '') return reply(200, { ok: true }, allowed)
  const renderedAt = Number(body.renderedAt)
  if (Number.isFinite(renderedAt) && Date.now() - renderedAt < MIN_FILL_MS) {
    return reply(200, { ok: true }, allowed)
  }

  const participantName = clean(body.participantName, MAX.name)
  const dob = clean(body.dob, 10)
  const email = clean(body.email, MAX.email)
  const phone = clean(body.phone, MAX.phone)
  const emergencyName = clean(body.emergencyName, MAX.name)
  const emergencyPhone = clean(body.emergencyPhone, MAX.phone)
  const signature = clean(body.signature, MAX.name)

  if (!participantName) return reply(400, { error: 'name_required' }, allowed)
  if (!DATE_RE.test(dob)) return reply(400, { error: 'dob_invalid' }, allowed)
  if (!EMAIL_RE.test(email)) return reply(400, { error: 'email_invalid' }, allowed)
  if (!emergencyName || !emergencyPhone) return reply(400, { error: 'emergency_required' }, allowed)
  if (!signature) return reply(400, { error: 'signature_required' }, allowed)

  const age = ageOn(dob)
  if (!Number.isFinite(age) || age < 0 || age > 120) return reply(400, { error: 'dob_invalid' }, allowed)

  /* Every box, individually. Accepting a single "I agree" would lose the
     record of what was specifically acknowledged, which is the reason they
     are separate boxes on the form. */
  const ticked = Array.isArray(body.acknowledgements) ? body.acknowledgements : []
  if (ticked.length !== waiver.acknowledgements.length || !ticked.every(Boolean)) {
    return reply(400, { error: 'acknowledgements_required' }, allowed)
  }

  const isMinor = age < 18
  const guardianName = clean(body.guardianName, MAX.name)
  const guardianRelationship = clean(body.guardianRelationship, MAX.relationship)
  const guardianSignature = clean(body.guardianSignature, MAX.name)

  /* Server-side, not merely hidden in the UI. Age is derived from the date of
     birth here, so a minor cannot be submitted without a guardian by editing
     the page. */
  if (isMinor && (!guardianName || !guardianRelationship || !guardianSignature)) {
    return reply(400, { error: 'guardian_required' }, allowed)
  }

  const id = randomUUID()
  const signedAt = new Date().toISOString()
  const record = {
    id, signedAt, ip, age, isMinor,
    participantName, dob, email, phone,
    emergencyName, emergencyPhone, signature,
    guardianName, guardianRelationship, guardianSignature,
    // Ties this signature to the exact wording, so a later edit to the YAML
    // cannot quietly change what someone appears to have agreed to.
    textHash: createHash('sha256').update(JSON.stringify(waiver)).digest('hex').slice(0, 32),
  }

  let pdf
  try {
    pdf = await buildPdf(record)
  } catch (err) {
    console.error('pdf generation failed', err.message) // message only — never the record
    return reply(500, { error: 'pdf_failed' }, allowed)
  }

  /* Fold accents before stripping, rather than deleting them.
     A plain [^a-zA-Z0-9] filter turns "José Álvarez" into "jos-lvarez" — it
     removes the accented letters outright instead of transliterating them.
     Normalising to NFD first splits each letter from its diacritic, so the
     base letter survives and only the mark is dropped: "jose-alvarez".
     This is somebody's name on a legal document; mangling it is not a
     cosmetic problem. */
  const safeName =
    participantName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'unnamed'
  const filename = `waiver-${safeName}-${signedAt.slice(0, 10)}.pdf`
  const key = `waivers/${signedAt.slice(0, 4)}/${signedAt.slice(5, 7)}/${signedAt.slice(0, 10)}-${safeName}-${id}.pdf`

  /* Archive first, and fail the request if it fails.
     The email is a notification; this is the record. A waiver that was emailed
     but not archived looks fine today and is gone the day it is needed, so a
     failure here has to be visible now rather than discovered later. */
  if (ARCHIVE_BUCKET) {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: ARCHIVE_BUCKET,
          Key: key,
          Body: pdf,
          ContentType: 'application/pdf',
          // Searchable without opening every file; no PII beyond the name.
          Metadata: {
            'waiver-version': String(waiver.version),
            'signed-at': signedAt,
            'is-minor': String(isMinor),
          },
        })
      )
    } catch (err) {
      console.error('archive failed', err.name)
      return reply(502, { error: 'archive_failed' }, allowed)
    }
  } else {
    console.warn('ARCHIVE_BUCKET unset — waiver was emailed but NOT archived')
  }

  const summary = [
    `${participantName} signed the waiver.`,
    '',
    `Age at signing: ${age}${isMinor ? '  (MINOR — guardian section completed)' : ''}`,
    `Email:          ${email}`,
    `Phone:          ${phone || 'not given'}`,
    `Emergency:      ${emergencyName} · ${emergencyPhone}`,
    ...(isMinor ? [`Guardian:       ${guardianName} (${guardianRelationship})`] : []),
    '',
    `Waiver version: ${waiver.version}`,
    `Reference:      ${id}`,
    ARCHIVE_BUCKET ? `Archived:       s3://${ARCHIVE_BUCKET}/${key}` : 'Archived:       NOT ARCHIVED',
    '',
    'The signed PDF is attached.',
  ].join('\n')

  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: WAIVER_FROM,
        Destination: { ToAddresses: [WAIVER_TO] },
        ReplyToAddresses: [email],
        Content: {
          Raw: {
            Data: rawEmail({
              from: WAIVER_FROM,
              to: WAIVER_TO,
              subject: `Waiver signed: ${participantName}${isMinor ? ' (minor)' : ''}`,
              text: summary,
              filename,
              pdf,
            }),
          },
        },
      })
    )
  } catch (err) {
    /* Best effort, because the archive already succeeded. Failing the request
       here would tell someone their waiver did not go through when it is
       safely stored, and they would sign again. */
    console.error('waiver email failed (PDF is archived)', err.name)
  }

  /* Off until SES production access: this goes to an address nobody verified,
     which the sandbox refuses. Swallowed for the same reason as above. */
  if (signerCopyEnabled) {
    try {
      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: WAIVER_FROM,
          Destination: { ToAddresses: [email] },
          Content: {
            Raw: {
              Data: rawEmail({
                from: WAIVER_FROM,
                to: email,
                subject: 'Your signed waiver — BEAST Fitness',
                text: `Hi ${participantName.split(' ')[0]},\n\nYour signed waiver is attached. Keep it for your records.\n\n--\nBEAST Fitness\nhttps://beast-fit.com`,
                filename,
                pdf,
              }),
            },
          },
        })
      )
    } catch (err) {
      console.error('signer copy failed', err.name)
    }
  }

  return reply(200, { ok: true, reference: id }, allowed)
}
