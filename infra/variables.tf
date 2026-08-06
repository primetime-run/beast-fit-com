variable "aws_profile" {
  description = <<-EOT
    Named AWS CLI profile to deploy with.

    Deliberately explicit rather than relying on whichever credentials happen
    to be ambient. This machine's `default` profile points at a DIFFERENT
    client's account, and an apply that landed there would create this gym's
    payment infrastructure inside someone else's bill and blast radius.

      aws configure --profile beast-fit
  EOT
  type        = string
  default     = "beast-fit"
}

variable "expected_account_id" {
  description = <<-EOT
    The AWS account this stack belongs in. Enforced by allowed_account_ids on
    the provider, so a misconfigured profile fails immediately with a clear
    message rather than creating resources in the wrong place.
  EOT
  type        = string
  default     = "588307916645"
}

variable "region" {
  description = "Region for Lambda, DynamoDB and SES. Must be one where SES is available."
  type        = string
  default     = "us-east-1"
}

variable "site_url" {
  description = <<-EOT
    Public origin of the site, no trailing slash.

    Used to build the Accept Hosted IFrame communicator URL. It MUST be the
    real origin the checkout page is served from — Authorize.Net posts its
    resize, cancel and success messages to that page, and the browser silently
    drops them if the origin does not match. The symptom is a lightbox that
    opens and then hangs with no error anywhere.
  EOT
  type        = string
  default     = "https://beast-fit.com"
}

variable "allowed_origins" {
  description = <<-EOT
    Origins permitted to request a payment form token.

    This is the only thing stopping someone else's checkout page from minting
    tokens against this merchant account, with the charges landing here. Add
    the GitHub Pages origin temporarily if you need to test before the DNS
    cutover, and remove it afterwards.
  EOT
  type        = list(string)
  default     = ["https://beast-fit.com", "https://www.beast-fit.com"]
}

# ---------------------------------------------------------------------------
# Authorize.Net
#
# All three have no default and are marked sensitive. Pass them by environment
# so they never touch disk:
#
#   export TF_VAR_authnet_login_id='...'
#   export TF_VAR_authnet_transaction_key='...'
#   export TF_VAR_authnet_signature_key='...'
#
# Note they still land in terraform.tfstate in plaintext — `sensitive` only
# suppresses console output. Keep that file local and gitignored.
# ---------------------------------------------------------------------------

variable "authnet_env" {
  description = <<-EOT
    "sandbox" or "production".

    Defaults to sandbox on purpose: a half-configured deploy that quietly
    starts taking real money is far worse than one that quietly does not.
    Flip this only once a sandbox transaction has been seen working end to
    end, and remember the credentials differ between the two — sandbox keys
    sent to the live host fail with an unhelpful generic error.
  EOT
  type        = string
  default     = "sandbox"

  validation {
    condition     = contains(["sandbox", "production"], var.authnet_env)
    error_message = "authnet_env must be exactly \"sandbox\" or \"production\"."
  }
}

variable "authnet_login_id" {
  description = "Authorize.Net API Login ID, for the environment named in authnet_env."
  type        = string
  sensitive   = true
}

variable "authnet_transaction_key" {
  description = "Authorize.Net Transaction Key. Mints hosted payment form tokens."
  type        = string
  sensitive   = true
}

variable "authnet_signature_key" {
  description = <<-EOT
    Authorize.Net Signature Key — a DIFFERENT credential from the transaction
    key, and the single most common thing to get wrong here. It verifies the
    HMAC-SHA512 on incoming webhooks.

    Merchant Interface -> Account -> Settings -> Security Settings
      -> API Credentials & Keys -> Signature Key
  EOT
  type        = string
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

variable "domain" {
  description = "Root domain. Its Route 53 hosted zone is looked up, never created."
  type        = string
  default     = "beast-fit.com"
}

variable "github_owner" {
  description = "GitHub account serving Pages — the www CNAME target, <owner>.github.io."
  type        = string
  default     = "primetime-run"
}

variable "point_dns_at_pages" {
  description = <<-EOT
    Point the domain at GitHub Pages.

    FALSE until the cutover. Setting this true takes the live WordPress site
    offline the moment DNS propagates, so it is a deliberate, separate act
    rather than a side effect of applying this stack for its SES records.

      terraform apply -var 'point_dns_at_pages=true'

    Before flipping it, set the custom domain in the repository's Pages
    settings. The DNS alone is not enough — GitHub has to know the hostname
    belongs to that Pages site, and the failure mode when it does not is a
    "Site not found" page that looks exactly like a DNS problem.
  EOT
  type        = bool
  default     = false
}

variable "mail_domain" {
  description = <<-EOT
    Domain SES sends from.

    The root domain, not a subdomain. The usual reason to send from mail.* is
    to keep SES's SPF and DKIM clear of whatever already handles the domain's
    mailbox — but beast-fit.com publishes no MX and no TXT records at all, so
    there is nothing to collide with. A plain no-reply@beast-fit.com is what
    recipients expect to see, and it is one fewer name to explain.

    If the gym ever starts receiving mail at this domain, whoever sets that up
    must MERGE amazonses into the SPF record rather than adding a second one —
    a domain may publish only one, and two makes receivers fail the lot.
  EOT
  type        = string
  default     = "beast-fit.com"
}

variable "contact_to" {
  description = <<-EOT
    Address that receives contact form enquiries.

    No default: this repository is public. Put it in terraform.tfvars, which
    is gitignored. Often the same address as notify_to, but kept separate so
    payment alerts and sales enquiries can be split later without a code
    change.
  EOT
  type        = string
}

variable "autoreply" {
  description = <<-EOT
    Send the enquirer an acknowledgement as well as the gym.

    Leave false until SES production access is granted. The acknowledgement
    goes to whatever address the visitor typed, and the SES sandbox refuses
    any unverified recipient — so enabling it early means every submission
    logs a failure. The enquiry itself still reaches the gym either way; the
    handler treats the acknowledgement as best-effort on purpose.
  EOT
  type        = bool
  default     = false
}

variable "turnstile_secret" {
  description = <<-EOT
    Cloudflare Turnstile secret key. Pass via TF_VAR_turnstile_secret; never
    commit it. Empty means the CAPTCHA check is skipped — the honeypot,
    timing check, origin allow-list and rate limit all still apply.
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

variable "notify_to" {
  description = <<-EOT
    Address that receives payment notifications from the webhook.

    No default: this repository is public and a plaintext address here is an
    address in a scraper's list. Put it in terraform.tfvars, which is
    gitignored.

    While the SES account is in the sandbox this address must itself be a
    verified SES identity, which the stack creates — AWS then emails it a
    confirmation link that someone has to click.
  EOT
  type        = string
}

variable "manage_dns" {
  description = <<-EOT
    Manage the Route 53 records for this domain from here.

    FALSE today, because the hosted zone is not in this account. beast-fit.com
    resolves through awsdns-* nameservers, so it is on Route 53 — but in
    whichever account also runs the Lightsail WordPress instance. This account
    has no hosted zones at all.

    While false, `terraform output dns_records_to_add` prints what to create by
    hand in the account that does hold the zone. Flip it true once the zone
    lives here, and the records become managed instead.
  EOT
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Records the live site depends on, carried into the new zone so that
# repointing the nameservers changes nothing a visitor can see.
#
# Captured from live DNS on 2026-08-06. Re-check before applying if any time
# has passed — if the WordPress host has moved, copying a stale address here
# is how the delegation switch becomes an outage.
# ---------------------------------------------------------------------------

variable "legacy_apex_ip" {
  description = "Current A record for the apex — the Lightsail WordPress instance."
  type        = string
  default     = "54.85.191.186"
}

variable "legacy_www_target" {
  description = "Current CNAME target for www — a CloudFront distribution."
  type        = string
  default     = "d29euly5651axl.cloudfront.net"
}
