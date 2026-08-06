#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Runs the checkout Lambda locally, so the whole payment flow can be tested
   without deploying anything.

   It wraps infra/lambda/index.mjs in the same event shape the Lambda Function
   URL sends, which means you are exercising the real handler — not a mock of
   it. Bugs found here are bugs that would have shipped.

   Usage:
     export AUTHNET_LOGIN_ID=<your SANDBOX api login id>
     export AUTHNET_TRANSACTION_KEY=<your SANDBOX transaction key>
     npm run dev:checkout          # this, on :8788
     npm run dev                   # the site, on :4321

   SANDBOX credentials only — from developer.authorize.net, not the live
   merchant account. AUTHNET_ENV is forced to sandbox below and there is no
   switch to change it: a local dev script has no business talking to the
   production gateway, where test cards are rejected anyway.
--------------------------------------------------------------------------- */

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8788)
const SITE = process.env.SITE_URL ?? 'http://localhost:4321'

process.env.AUTHNET_ENV = 'sandbox'
process.env.SITE_URL = SITE
process.env.ALLOWED_ORIGINS = [SITE, 'http://127.0.0.1:4321'].join(',')

if (!process.env.AUTHNET_LOGIN_ID || !process.env.AUTHNET_TRANSACTION_KEY) {
  console.error(
    '\n  Missing sandbox credentials.\n\n' +
      '    export AUTHNET_LOGIN_ID=...\n' +
      '    export AUTHNET_TRANSACTION_KEY=...\n\n' +
      '  Get them free at developer.authorize.net — NOT the live account.\n'
  )
  process.exit(1)
}

const { handler } = await import('../infra/lambda/index.mjs')

createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)

  const event = {
    headers: { origin: req.headers.origin ?? '' },
    requestContext: {
      http: { method: req.method, sourceIp: req.socket.remoteAddress ?? '127.0.0.1' },
    },
    body: Buffer.concat(chunks).toString('utf8'),
  }

  const out = await handler(event)
  console.log(`${req.method} ${req.url} -> ${out.statusCode}`, out.body ?? '')
  res.writeHead(out.statusCode, out.headers ?? {})
  res.end(out.body ?? '')
}).listen(PORT, () => {
  console.log(`checkout (sandbox) on http://localhost:${PORT}`)
  console.log(`allowing origin  ${SITE}`)
  console.log(`\nset PUBLIC_CHECKOUT_ENDPOINT=http://localhost:${PORT} in .env.local\n`)
})
