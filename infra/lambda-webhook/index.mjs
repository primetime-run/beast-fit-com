/* ---------------------------------------------------------------------------
   Authorize.Net webhook receiver

   This is the ONLY place that learns, authoritatively, that money moved. The
   browser's "transactResponse" after the hosted form closes is a hint from an
   untrusted client — it can be replayed, faked, or simply never arrive because
   somebody shut the laptop. Fulfilment decisions belong here.

   Three properties this endpoint has to have, in order:

   1. It must verify the signature. The URL is public and unauthenticated, so
      without verification anyone can POST a fake "payment received".
   2. It must be idempotent. Authorize.Net retries on any non-2xx and can
      deliver the same notification more than once even after a 200. Handling a
      duplicate must not send a second email or double-credit anything.
   3. It must answer 200 quickly. A slow or failing endpoint gets retried, then
      eventually disabled by Authorize.Net, and the failure is silent from the
      merchant's side.

   The signature uses the SIGNATURE KEY, which is a different credential from
   the transaction key used to mint form tokens:
     Merchant Interface -> Account -> Settings -> Security Settings
       -> API Credentials & Keys -> Signature Key
--------------------------------------------------------------------------- */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

const {
  AUTHNET_SIGNATURE_KEY,
  DEDUPE_TABLE,
  NOTIFY_TO,
  NOTIFY_FROM,
  AWS_REGION,
} = process.env

const ddb = new DynamoDBClient({ region: AWS_REGION })
const ses = new SESv2Client({ region: AWS_REGION })

/* Events worth acting on. Anything else is acknowledged and ignored — an
   allow-list rather than a deny-list, so enabling a new event type in the
   portal cannot quietly start driving behaviour here. */
const HANDLED = new Set([
  'net.authorize.payment.authcapture.created', // paid, captured — the normal case
  'net.authorize.payment.capture.created', // capture of a prior auth
  'net.authorize.payment.refund.created',
  'net.authorize.payment.void.created',
  'net.authorize.payment.fraud.held', // held by the fraud filters
  'net.authorize.payment.fraud.approved',
  'net.authorize.payment.fraud.declined',
])

/* Held is deliberately loud: money has NOT settled and somebody has to go and
   approve or decline it in the Merchant Interface. Silence there means a
   customer who thinks they have paid and a gym that never sees the money. */
const NEEDS_ATTENTION = new Set([
  'net.authorize.payment.fraud.held',
  'net.authorize.payment.fraud.declined',
  'net.authorize.payment.refund.created',
  'net.authorize.payment.void.created',
])

const ok = (body = { ok: true }) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * HMAC-SHA512 of the RAW body, compared in constant time.
 *
 * Two ways this goes wrong and looks like a gateway problem:
 *  - Comparing with `===` leaks timing. Use timingSafeEqual.
 *  - Hashing a re-serialised object instead of the raw bytes. JSON.stringify
 *    does not round-trip key order or whitespace, so the digest will never
 *    match. Hash exactly what arrived.
 */
function signatureValid(rawBody, header) {
  if (!header || !AUTHNET_SIGNATURE_KEY) return false

  // Header looks like "sha512=ABC123…". Case of the hex varies.
  const sent = header.includes('=') ? header.split('=')[1] : header
  if (!/^[0-9a-fA-F]{128}$/.test(sent)) return false

  const expected = createHmac('sha512', AUTHNET_SIGNATURE_KEY)
    .update(rawBody, 'utf8')
    .digest('hex')

  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(sent.toLowerCase(), 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Claim this notification. Returns false if we have already handled it.
 *
 * A conditional put is the whole mechanism: DynamoDB decides the race, so two
 * concurrent deliveries cannot both win. Without this, a retry after a slow
 * 200 sends the gym a second "payment received" for one payment.
 */
async function claim(notificationId) {
  if (!DEDUPE_TABLE) {
    console.warn('DEDUPE_TABLE unset — duplicate deliveries WILL be reprocessed')
    return true
  }
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: DEDUPE_TABLE,
        Item: {
          notificationId: { S: notificationId },
          // 30 days is well past Authorize.Net's retry window; the table stays
          // small without ever forgetting something still in flight.
          expiresAt: { N: String(Math.floor(Date.now() / 1000) + 30 * 86400) },
        },
        ConditionExpression: 'attribute_not_exists(notificationId)',
      })
    )
    return true
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false
    throw err
  }
}

const money = (n) =>
  typeof n === 'number' ? `$${n.toFixed(2)}` : String(n ?? 'unknown amount')

async function notify(subject, lines) {
  if (!NOTIFY_TO || !NOTIFY_FROM) {
    console.warn('SES not configured; would have sent:', subject)
    return
  }
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: NOTIFY_FROM,
      Destination: { ToAddresses: [NOTIFY_TO] },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: { Text: { Data: lines.join('\n') } },
        },
      },
    })
  )
}

export async function handler(event) {
  /* Function URLs may base64 the body. The signature is over the bytes that
     were actually sent, so decode before hashing — and hash this string, not
     a parsed-and-restringified version of it. */
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '')

  // Function URLs lower-case header names.
  const sig = event.headers?.['x-anet-signature'] ?? event.headers?.['X-ANET-Signature']

  if (!signatureValid(raw, sig)) {
    console.error('rejected: bad or missing signature')
    // 401 rather than 200: this was not a legitimate delivery, and we do not
    // want Authorize.Net to consider it accepted.
    return { statusCode: 401, body: JSON.stringify({ error: 'bad_signature' }) }
  }

  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    console.error('signed but unparseable body')
    return { statusCode: 400, body: JSON.stringify({ error: 'bad_json' }) }
  }

  const { notificationId, eventType, payload = {} } = msg

  if (!HANDLED.has(eventType)) {
    console.log('ignoring event type', eventType)
    return ok({ ignored: eventType })
  }

  if (notificationId && !(await claim(notificationId))) {
    console.log('duplicate delivery, already handled', notificationId)
    return ok({ duplicate: true })
  }

  const transactionId = payload.id ?? 'unknown'
  const amount = money(payload.authAmount)
  const attention = NEEDS_ATTENTION.has(eventType)

  console.log('handled', JSON.stringify({ eventType, transactionId, amount, notificationId }))

  try {
    await notify(
      `${attention ? 'ACTION NEEDED — ' : ''}BEAST Fitness payment: ${amount}`,
      [
        `Event:          ${eventType}`,
        `Transaction ID: ${transactionId}`,
        `Amount:         ${amount}`,
        `Response code:  ${payload.responseCode ?? '—'}`,
        `AVS:            ${payload.avsResponse ?? '—'}`,
        `When:           ${msg.eventDate ?? '—'}`,
        '',
        attention
          ? 'This transaction has NOT settled normally. Open the Merchant\n' +
            'Interface and review it before treating it as paid.'
          : 'Look up the customer details against this transaction ID in the\n' +
            'Merchant Interface.',
      ]
    )
  } catch (err) {
    /* The notification failed, but the payment is real and already recorded by
       Authorize.Net. Returning non-2xx would make them retry the whole
       delivery — and we have already claimed the id, so the retry would be
       swallowed as a duplicate and the email lost for good. Log loudly, ack. */
    console.error('NOTIFY FAILED for transaction', transactionId, err)
  }

  return ok()
}
