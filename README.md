# beast-fit.com

The website for **BEAST Fitness**, an outdoor group-training gym in Delray
Beach, Florida.

Classes run on the field at Seacrest Soccer Complex — rain or shine, from
05:30 most weekdays. Five formats rotate through the week: Cardio
Conditioning, three Cross Training splits (chest/shoulders/triceps, legs,
back/biceps) and BEAST BEATDOWN, a full-body session on Saturdays. People pay
by membership, by drop-in, or for personal training.

The site has three jobs: tell people when classes are, let them get those
classes into their own calendar, and take payment.

## How it is built

A static site with three small server-side pieces.

```
Astro ──build──> static HTML ──> GitHub Pages

checkout    ──> Lambda ──> Authorize.Net   (mints a payment form token)
webhook     <── Authorize.Net              (confirms money actually moved)
contact     ──> Lambda ──> SES             (enquiry to the gym)
```

Static because a gym's website has nothing to compute per visitor: no server
to patch, no database to back up, no admin login to compromise. The three
things that genuinely need a server each get one function and nothing more.

## Running it locally

```bash
npm install
npm run dev                    # site on :4321
```

Everything works offline except payment. To exercise the real checkout:

```bash
export AUTHNET_LOGIN_ID='<sandbox api login id>'
export AUTHNET_TRANSACTION_KEY='<sandbox transaction key>'
npm run dev:checkout           # handler on :8788
```

with `PUBLIC_CHECKOUT_ENDPOINT=http://localhost:8788` in `.env.local`
(gitignored). Then visit **/checkout/test/** — a noindex page, linked from
nowhere, that charges $1.00 through the real path.

**Sandbox credentials only**, from developer.authorize.net. `dev:checkout`
forces `AUTHNET_ENV=sandbox` with no override, because live keys reject the
test card numbers anyway — a decline against a live account tells you nothing
except that the card was refused.

Other commands:

```bash
npm run build             # generates the price catalog, then builds
npm run verify-urls       # asserts no published URL has broken
npm run schedule          # print the generated timetable, to eyeball it
npm run verify-holidays   # check the holiday rules against known dates
npm run generate-map      # rebuild the static map image
```

## Content

Everything editable lives in `data/` as YAML. No CMS, no admin login.

| File | Holds |
|---|---|
| `schedule.yaml` | Classes and their weekly slots |
| `holidays.yaml` | Closures, and special sessions that replace them |
| `training.yaml` | Products, options and prices |
| `trainers.yaml` | Who teaches |
| `location.yaml` | Address and coordinates |
| `home.yaml` | Homepage copy |
| `privacy-policy.yaml` | The policy, as structured blocks |

### The schedule generates itself

The timetable is **not** a list of dates. `schedule.yaml` declares the weekly
pattern, `holidays.yaml` declares the exceptions, and the calendar is computed
from both at build time.

That is the difference between a schedule that is correct next February and
one that quietly goes stale. Holiday closures are declared once as rules —
"the fourth Thursday in November" — rather than as dates somebody has to
remember to add each year.

Because the output is dated, **the deploy workflow rebuilds daily**. Without
that, a site that only builds on push starts showing last week's classes.

`npm run schedule` prints the generated timetable so a change can be checked
before it ships.

### Calendar files

Every class offers `.ics` downloads, generated at build time: one per class
per weekday, and one per time slot across the week. Subscribing keeps a
member's calendar in step with schedule changes, rather than copying one
snapshot of it.

Single occurrences are built in the browser instead. On iOS Safari a blob
download frequently opens as text or silently does nothing, while a served
`text/calendar` URL opens Calendar's preview sheet — so recurring options link
to real files and one-offs are generated on the fly.

### URLs are preserved

`url-inventory.json` lists every address the previous site published.
`npm run verify-urls` asserts each one still resolves in `dist/`, and CI runs
it before publishing, so a rename cannot silently break an inbound link.

## Payment

Authorize.Net **Accept Hosted**. Card fields are served by Authorize.Net
inside an iframe on their own domain, so no card number ever reaches this site
or its Lambdas. That is what keeps the merchant in PCI **SAQ A**, the lightest
self-assessment there is. If a change ever starts posting card data through
our own code, that assessment becomes SAQ A-EP or D.

**The browser never sends a price.** It sends a product id and an option key;
the Lambda looks the amount up in `catalog.json`, generated from
`training.yaml` by `npm run build`. A price posted from the client is a price
the customer can edit, and "$1,380 membership for $1.38" is otherwise one form
field away. Generating the catalog from the same YAML the pages render means
the page and the charge cannot disagree.

Amounts are integer **cents** everywhere, formatted to a decimal string only at
the gateway boundary — doing the arithmetic in floats is how you end up
submitting `1379.9999999999998`.

### The webhook is the source of truth

The browser's response after the hosted form closes is a hint from an
untrusted client: it can be replayed, faked, or simply never arrive because
somebody shut their laptop. Fulfilment decisions belong to the webhook.

It verifies an HMAC-SHA512 signature over the **raw** request body — hashing a
re-serialised object never matches, because `JSON.stringify` does not preserve
key order or whitespace. It then claims each notification id with a
conditional DynamoDB put, so a redelivered notification cannot send a second
email for one payment.

Note the credential: the webhook uses the **Signature Key**, which is a
different secret from the Transaction Key the checkout uses. Confusing the two
is the most common way this integration appears broken.

## Contact form

Checks run server-side, cheapest first: origin allow-list, honeypot, a
three-second minimum fill time, length caps with CR/LF stripped to stop header
injection, optional Turnstile, per-IP rate limit. The honeypot and timing
checks answer `200` on failure — telling a bot which check caught it teaches it
to pass.

The enquiry goes to one fixed verified address and must succeed; a failure
returns 502 so the sender knows to retry.

The handler can also acknowledge the enquirer, but **that is off** — the gym
does not want one. If it is ever turned on it needs SES production access, and
note it is deliberately best-effort: telling someone their message failed when
the gym already has it is the worst available outcome.

## Deploy

### 1. AWS profile

The stack pins an explicit profile and refuses to run anywhere else:

```bash
aws configure --profile beast-fit     # account 588307916645
```

`allowed_account_ids` in the provider makes a wrong-account apply fail
immediately. This machine's `default` profile points at a different client's
account, and without the guard a forgotten flag would build this gym's payment
infrastructure inside someone else's bill.

### 2. Infrastructure

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # set notify_to and contact_to
export TF_VAR_authnet_login_id='...'
export TF_VAR_authnet_transaction_key='...'
export TF_VAR_authnet_signature_key='...'
terraform init && terraform plan
terraform apply
terraform output next_steps
```

Three Lambdas with Function URLs, a DynamoDB table for webhook idempotency,
SES identities, per-function IAM, and 14-day log groups.

`authnet_env` defaults to **sandbox**. A half-configured deploy that quietly
starts taking real money is worse than one that quietly does not. Flip it to
`production` only once a sandbox transaction has worked end to end — and swap
the credentials at the same time, since they differ between environments.

Terraform state is local and unencrypted. Move it to an S3 backend if more
than one person ever runs `apply`.

### 3. Repository variables

Settings → Secrets and variables → Actions → **Variables** (not Secrets —
Function URLs are not secret, they validate server-side, and masking them only
makes build logs useless):

| Variable | Source |
|---|---|
| `PUBLIC_CHECKOUT_ENDPOINT` | `terraform output checkout_endpoint` |
| `PUBLIC_CONTACT_ENDPOINT` | `terraform output contact_endpoint` |

Without these the forms ship a "not configured yet" message. Variables are
read at workflow start, so re-run the workflow after setting them.

### 4. Pages

Settings → Pages → **Source: GitHub Actions**. Pushing to `main` then builds
and publishes, and `verify-urls` fails the deploy if a published URL stopped
resolving.

### 5. Email DNS

`terraform output dns_status` prints what is needed. Five records on
`beast-fit.com`: three DKIM CNAMEs, SPF, and DMARC at `p=none`.

Mail is sent from the **root domain** as `no-reply@beast-fit.com`. The usual
reason to send from a `mail.` subdomain is to keep SES's records clear of
whatever already handles the domain's mailbox — but beast-fit.com publishes no
MX and no TXT records at all, so there is nothing to collide with.

They are printed rather than created because **the Route 53 zone is in a
different AWS account** — beast-fit.com resolves through `awsdns-*`
nameservers, but account 588307916645 has no hosted zones. Move the zone here
and set `manage_dns = true`, and Terraform owns them instead.

If the gym ever starts receiving mail at this domain, whoever sets that up
must **merge** `amazonses` into the SPF record rather than adding a second
one. A domain may publish only one SPF record; two makes receivers treat the
whole domain as `permerror` and fail the lot.

### 6. Cutover

Set the custom domain in Pages settings **first**, then point DNS. Doing it in
the other order gives a "Site not found" page that looks exactly like a DNS
fault and is not.

With `manage_dns = true`:

```bash
terraform apply -var 'point_dns_at_pages=true'
```

Otherwise, by hand: apex `A` to the four `185.199.108–111.153` addresses, and
`www` `CNAME` to `primetime-run.github.io`. TTL 300 while cutting over, so a
rollback propagates in minutes rather than hours.

## Email

Three emails exist, and only two of them come from here.

| Email | To | Sent by |
|---|---|---|
| Contact enquiry | the gym | this stack, from `no-reply@beast-fit.com` |
| New order alert | the gym | this stack, from `no-reply@beast-fit.com` |
| Order receipt | the customer | **Authorize.Net**, not us |

### SES production access is not needed

The account is in the SES sandbox: 200 emails a day, **only to verified
addresses**. Both emails this stack sends go to the gym's own verified inbox,
so the sandbox is sufficient — and it is a useful safety ceiling, since even
if every other control failed nothing could reach a stranger.

Customer receipts are handled by Authorize.Net's own email, enabled in the
Merchant Interface under Settings → Email Receipt. The hosted payment form
already collects the customer's email (`requiredEmail: true`), so Authorize.Net
has it and we do not need to.

That last point is not just convenience. **The webhook notification does not
include the customer's email address** — it carries only the transaction id,
amount, response code and AVS result. Sending a receipt ourselves would mean
calling `getTransactionDetails` to fetch the address back, which means giving
the webhook the Transaction Key on top of the Signature Key it needs for
verification. Letting Authorize.Net send the receipt avoids widening that
function's access to a credential it has no other reason to hold.

The contact handler can also acknowledge the enquirer. It is off, the gym does
not want one, and it is the only remaining thing that would require production
access.

## Cost

| | Monthly |
|---|---|
| GitHub Pages | $0 |
| Lambda (free tier covers this many times over) | $0 |
| DynamoDB (pay-per-request, a few writes a day) | ~$0.00 |
| SES (~$0.10 per 1,000 emails) | ~$0.00 |
| CloudWatch logs (14-day retention) | ~$0.03 |

Authorize.Net's own gateway and processing fees are separate and are the only
real cost of running this.

## Outstanding

- **Prices need owner confirmation.** Those in `training.yaml` carry over from
  the previous site and are years old. The product pages currently say so; that
  caveat should come off before launch, once the numbers are checked.
- **Florida sales tax.** Membership fees at a physical fitness facility may be
  taxable under FL Admin Code 12A-1.005. If it applies, tax has to be computed
  before the payment token is minted, not after.
- **The privacy policy needs a rewrite.** It carried over verbatim and still
  describes cookies, analytics and a mobile app that do not exist here.
- **Instagram feed.** The previous site embedded `@beast_fitness1`. Blocked on
  account access.
- **Live Authorize.Net keys need rotating.** They sat in plaintext in the
  migration folder. Rotate before go-live and pass the new key via `TF_VAR_`.

## Notes

- No webfonts from a third party, no analytics, no trackers. The browser loads
  nothing from another domain, so there is no cookie banner to show.
- The map is a static image generated from OpenStreetMap tiles and committed,
  not an embedded iframe — self-hosted, cacheable, and no visitor makes a
  request to a third party just to see where the gym is. ODbL attribution is
  baked into the image and printed beneath it; keep both.
- The theme follows the device. There is no toggle and nothing stored, so the
  browser resolves it before first paint and there is no flash to script
  around.
