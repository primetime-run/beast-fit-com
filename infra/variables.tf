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

variable "mail_subdomain" {
  description = <<-EOT
    Subdomain SES sends from, e.g. mail.beast-fit.com.

    A subdomain rather than the root domain so the DKIM, SPF and DMARC records
    this needs cannot collide with whatever handles the gym's actual mailbox.
  EOT
  type        = string
  default     = "mail.beast-fit.com"
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
