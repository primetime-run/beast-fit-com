/* ---------------------------------------------------------------------------
   Contact form handler — Lambda Function URL + SES

   Every check runs server-side; nothing trusts the browser. Cheapest checks
   first, so abuse costs the least:

     1. Origin allow-list   — blocks casual cross-site posting
     2. Honeypot            — free, catches naive bots
     3. Submit timing       — a person cannot fill this in under 3 seconds
     4. Payload validation  — length caps, email shape, header-injection guard
     5. Turnstile           — a network call, so it runs last
     6. Per-IP rate limit   — in-memory, best effort

   Two emails leave here, and they are not equally safe to send:

     - The ENQUIRY goes to one fixed, verified address. That works while the
       SES account is in the sandbox.
     - The ACKNOWLEDGEMENT goes to whatever address the visitor typed. SES
       refuses that in the sandbox, which is why it is behind a flag and why
       its failure must never fail the request — see notify() below.
--------------------------------------------------------------------------- */

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

const ses = new SESv2Client({})

const {
  CONTACT_TO,
  CONTACT_FROM,
  AUTOREPLY_FROM,
  AUTOREPLY = 'off',
  TURNSTILE_SECRET = '',
  ALLOWED_ORIGINS = '',
} = process.env

const origins = ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
const autoreplyEnabled = AUTOREPLY === 'on'

const MAX = { firstName: 80, lastName: 80, email: 160, phone: 40, message: 4000 }
const MIN_FILL_MS = 3000

/* Allow-list rather than echoing what was posted — the label lands in a
   subject line, and a subject line is a header. */
const TOPICS = {
  membership: 'Membership',
  'drop-in': 'Drop-in class',
  'personal-training': 'Personal training',
  schedule: 'Class schedule',
  other: 'Something else',
}

/* Per-container and short-lived, so this throttles one abuser hammering a warm
   container rather than providing a global limit. Turnstile is the real
   defence; this blunts a burst. */
const hits = new Map()
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 5

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

/** Strip CR/LF so user input can never inject extra email headers. */
const clean = (v, max) =>
  String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max)

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true // not configured; the other checks still apply
  if (!token) return false
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: ip ?? '' }),
      signal: AbortSignal.timeout(5000),
    })
    return (await res.json()).success === true
  } catch {
    return false // fail closed
  }
}

function send({ to, from, subject, text, replyTo }) {
  return ses.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
    })
  )
}

export const handler = async (event) => {
  const headers = event.headers ?? {}
  const origin = headers.origin ?? headers.Origin ?? ''
  const allowed = origins.includes(origin) ? origin : null
  const method = event.requestContext?.http?.method ?? 'POST'
  const ip = event.requestContext?.http?.sourceIp ?? 'unknown'

  if (method === 'OPTIONS') return reply(allowed ? 204 : 403, {}, allowed)
  if (method !== 'POST') return reply(405, { error: 'Method not allowed' }, allowed)

  // 1. Origin allow-list. Without it this endpoint sends mail for anyone.
  if (origins.length && !allowed) {
    console.warn('rejected origin', origin)
    return reply(403, { error: 'Forbidden' }, null)
  }

  if (rateLimited(ip)) {
    return reply(429, { error: 'Too many messages. Please wait a minute and try again.' }, allowed)
  }

  let body
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return reply(400, { error: 'Malformed request.' }, allowed)
  }

  // 2. Honeypot — the field is hidden, so a person never fills it in.
  //    Answer 200: telling a bot which check caught it teaches it to pass.
  if (String(body.company ?? '').trim() !== '') {
    console.warn('honeypot tripped', ip)
    return reply(200, { ok: true }, allowed)
  }

  // 3. Timing — the page stamps renderedAt when it loads.
  const renderedAt = Number(body.renderedAt)
  if (Number.isFinite(renderedAt) && Date.now() - renderedAt < MIN_FILL_MS) {
    console.warn('submitted too fast', ip)
    return reply(200, { ok: true }, allowed)
  }

  // 4. Validate.
  const firstName = clean(body.firstName, MAX.firstName)
  const lastName = clean(body.lastName, MAX.lastName)
  const email = clean(body.email, MAX.email)
  const phone = clean(body.phone, MAX.phone)
  const message = String(body.message ?? '').trim().slice(0, MAX.message)

  if (!firstName || !lastName) return reply(400, { error: 'Please enter your name.' }, allowed)
  if (!EMAIL_RE.test(email)) return reply(400, { error: 'Please enter a valid email address.' }, allowed)
  if (!message) return reply(400, { error: 'Please tell us what you are after.' }, allowed)

  // 5. Turnstile — last, because it costs a network round trip.
  if (!(await verifyTurnstile(body.turnstileToken ?? body['cf-turnstile-response'], ip))) {
    return reply(400, { error: 'Could not verify you are human. Please try again.' }, allowed)
  }

  const topic = TOPICS[String(body.topic ?? '')] ?? 'General enquiry'
  const name = `${firstName} ${lastName}`

  /* The enquiry. This one must succeed — if it fails the visitor is told, so
     they know to try again rather than assuming it arrived. */
  try {
    await send({
      to: CONTACT_TO,
      from: CONTACT_FROM,
      // Reply-To the sender, so hitting reply in the inbox reaches them.
      replyTo: email,
      subject: `Enquiry: ${topic}`,
      text: [
        `From:     ${name} <${email}>`,
        `Phone:    ${phone || 'not given'}`,
        `About:    ${topic}`,
        '',
        message,
        '',
        '--',
        `Sent from the contact form on beast-fit.com  ·  ${ip}`,
      ].join('\n'),
    })
  } catch (err) {
    console.error('SES send failed', err)
    return reply(502, { error: 'Could not send your message. Please try again shortly.' }, allowed)
  }

  /* The acknowledgement. Deliberately best-effort.

     It goes to an address nobody verified, which SES refuses outright while
     the account is in the sandbox. Letting that failure bubble up would tell
     a visitor their message failed when the gym has it — the worst possible
     lie, because they will either give up or send it twice. Log and move on. */
  if (autoreplyEnabled) {
    try {
      await send({
        to: email,
        from: AUTOREPLY_FROM,
        replyTo: CONTACT_TO,
        subject: 'We got your message — BEAST Fitness',
        text: [
          `Hi ${firstName},`,
          '',
          'Thanks for getting in touch. We have your message and will come back',
          'to you shortly.',
          '',
          'For reference, here is what you sent:',
          '',
          `  About: ${topic}`,
          ...message.split('\n').map((l) => `  ${l}`),
          '',
          'No need to reply to this — it is automatic. Replying will reach us',
          'though, if you want to add anything.',
          '',
          '--',
          'BEAST Fitness',
          'https://beast-fit.com',
        ].join('\n'),
      })
    } catch (err) {
      console.error('auto-reply failed (enquiry was delivered)', err)
    }
  }

  return reply(200, { ok: true }, allowed)
}
