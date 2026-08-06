/* ---------------------------------------------------------------------------
   Accept Hosted form-token endpoint

   The browser asks this function for a token; it never sees a card. The card
   fields are served by Authorize.Net inside an iframe on their own domain,
   which is what keeps the merchant in PCI SAQ A — the lightest self-assessment
   there is. Nothing here, and nothing in the page, may ever touch a PAN. If a
   future change starts posting card data through this function, the merchant
   moves to SAQ A-EP or D and this comment is the thing that was ignored.

   What the client sends:  { product: "membership", option: "membership-3-months" }
   What it does NOT send:  the price.

   The price comes from catalog.json, generated from data/training.yaml at
   build time. A price in the request body is a price the customer controls.
--------------------------------------------------------------------------- */

import catalog from './catalog.json' with { type: 'json' }

const {
  AUTHNET_LOGIN_ID,
  AUTHNET_TRANSACTION_KEY,
  AUTHNET_ENV = 'sandbox',
  ALLOWED_ORIGINS = '',
  SITE_URL = 'https://beast-fit.com',
} = process.env

/* Sandbox unless explicitly told otherwise. Defaulting to production is how a
   half-configured deploy takes real money. */
const API_URL =
  AUTHNET_ENV === 'production'
    ? 'https://api.authorize.net/xml/v1/request.api'
    : 'https://apitest.authorize.net/xml/v1/request.api'

const origins = ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)

/* In-memory, per-container, best-effort. Lambda gives no shared state, so this
   only slows down a single warm container — it is a speed bump against casual
   hammering, not a security control. The real limits are the origin check and
   Authorize.Net's own fraud filters. */
const hits = new Map()
const RATE_MAX = 20
const RATE_WINDOW_MS = 60_000

function rateLimited(ip) {
  const now = Date.now()
  const rec = hits.get(ip)
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, n: 1 })
    return false
  }
  rec.n += 1
  if (hits.size > 1000) hits.clear() // crude, but unbounded maps are worse
  return rec.n > RATE_MAX
}

const json = (status, body, origin) => ({
  statusCode: status,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  },
  body: JSON.stringify(body),
})

/** Cents -> the decimal string Authorize.Net expects. No float arithmetic. */
const amountString = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

export async function handler(event) {
  const origin = event.headers?.origin ?? ''
  const allowed = origins.includes(origin) ? origin : null

  if (event.requestContext?.http?.method === 'OPTIONS') {
    return {
      statusCode: allowed ? 204 : 403,
      headers: allowed
        ? {
            'access-control-allow-origin': allowed,
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '86400',
            vary: 'Origin',
          }
        : {},
    }
  }

  if (event.requestContext?.http?.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' }, allowed)
  }

  // Origin allow-list. Without it this endpoint mints tokens for anyone's
  // checkout page, and the charges land on this merchant account.
  if (!allowed) return json(403, { error: 'origin_not_allowed' }, null)

  const ip = event.requestContext?.http?.sourceIp ?? 'unknown'
  if (rateLimited(ip)) return json(429, { error: 'rate_limited' }, allowed)

  let body
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return json(400, { error: 'bad_json' }, allowed)
  }

  const product = catalog[body.product]
  if (!product) return json(400, { error: 'unknown_product' }, allowed)

  const option = product.options[body.option]
  if (!option) return json(400, { error: 'unknown_option' }, allowed)

  if (!AUTHNET_LOGIN_ID || !AUTHNET_TRANSACTION_KEY) {
    console.error('missing Authorize.Net credentials')
    return json(500, { error: 'not_configured' }, allowed)
  }

  const amount = amountString(option.cents)

  /* Accept Hosted settings are a list of name/value pairs whose values are
     themselves JSON strings. It is an odd shape, and the API rejects the
     request without explaining which setting was malformed, so keep each one
     small and obviously correct. */
  const settings = {
    // The page this iframe posts its resize/cancel/success messages to. It
    // MUST be on our own origin or the browser drops the postMessage, and the
    // lightbox then hangs with no error anywhere. See /checkout/communicator/.
    hostedPaymentIFrameCommunicatorUrl: {
      url: `${SITE_URL}/checkout/communicator/`,
    },
    // No Authorize.Net receipt page: we are in an iframe and handle the
    // result ourselves.
    hostedPaymentReturnOptions: {
      showReceipt: false,
    },
    hostedPaymentButtonOptions: { text: 'Pay' },
    hostedPaymentPaymentOptions: { cardCodeRequired: true },
    // Billing address is collected because AVS and CVV together are what make
    // the fraud filters worth anything on a card-not-present charge.
    hostedPaymentBillingAddressOptions: { show: true, required: true },
    hostedPaymentCustomerOptions: { showEmail: true, requiredEmail: true },
    hostedPaymentOrderOptions: { show: true, merchantName: 'BEAST Fitness' },
    hostedPaymentSecurityOptions: { captcha: true },
    hostedPaymentStyleOptions: { bgColor: '#8bc34a' },
  }

  const request = {
    getHostedPaymentPageRequest: {
      merchantAuthentication: {
        name: AUTHNET_LOGIN_ID,
        transactionKey: AUTHNET_TRANSACTION_KEY,
      },
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount,
        order: {
          // 20 chars max, and it shows on the customer's statement descriptor
          // in some configurations, so keep it legible.
          invoiceNumber: `BF${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
          description: `${product.name} — ${option.label}`.slice(0, 255),
        },
        lineItems: {
          lineItem: {
            itemId: body.option.slice(0, 31),
            name: option.label.slice(0, 31),
            description: product.name.slice(0, 255),
            quantity: '1',
            unitPrice: amount,
          },
        },
      },
      hostedPaymentSettings: {
        setting: Object.entries(settings).map(([settingName, value]) => ({
          settingName,
          settingValue: JSON.stringify(value),
        })),
      },
    },
  }

  let res
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch (err) {
    console.error('authorize.net unreachable', err)
    return json(502, { error: 'gateway_unreachable' }, allowed)
  }

  /* Authorize.Net's JSON endpoint returns a UTF-8 BOM in front of the body.
     JSON.parse chokes on it, and the resulting "Unexpected token" is
     completely misleading. Strip it before parsing — this is the single most
     common way a working integration looks broken. */
  const text = (await res.text()).replace(/^﻿/, '')

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    console.error('unparseable gateway response', text.slice(0, 500))
    return json(502, { error: 'gateway_bad_response' }, allowed)
  }

  if (payload.messages?.resultCode !== 'Ok' || !payload.token) {
    // Log the gateway's reason, return a generic one: their messages can
    // include account detail that should not reach the browser.
    console.error('gateway refused', JSON.stringify(payload.messages))
    return json(502, { error: 'gateway_refused' }, allowed)
  }

  return json(
    200,
    {
      token: payload.token,
      // The browser needs to know which host to post the token to, and it
      // must match the environment the token was minted in.
      action:
        AUTHNET_ENV === 'production'
          ? 'https://accept.authorize.net/payment/payment'
          : 'https://test.authorize.net/payment/payment',
      // Echoed back so the page can show what is being bought without
      // trusting its own copy of the price.
      summary: { product: product.name, option: option.label, amount },
    },
    allowed
  )
}
