terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = ">= 5.40" }
    archive = { source = "hashicorp/archive", version = ">= 2.4" }
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  # Hard stop if the credentials resolve to anything else. This machine has a
  # default profile pointing at another client's account; without this, a
  # forgotten --profile silently builds a payment stack in the wrong place.
  allowed_account_ids = [var.expected_account_id]

  default_tags {
    tags = {
      Project   = "beast-fit-com"
      ManagedBy = "terraform"
    }
  }
}

locals {
  checkout_name = "beast-fit-checkout"
  webhook_name  = "beast-fit-webhook"
  contact_name  = "beast-fit-contact"
}

# ---------------------------------------------------------------------------
# SES — payment notifications
#
# The webhook is the only thing that learns, authoritatively, that money moved.
# Its output is an email, so that email has to actually arrive: sent from our
# own domain, DKIM-signed, rather than from an address a spam filter has never
# heard of.
# ---------------------------------------------------------------------------

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.mail_domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# Recipients, verified because the SES sandbox only delivers to verified
# addresses. Harmless to keep once production access is granted.
#
# for_each over a set, not one resource per variable: notify_to and contact_to
# are usually the same inbox, and declaring that address twice makes the apply
# fail with "already exists" — which reads as drift rather than as two
# resources fighting over one identity.
resource "aws_sesv2_email_identity" "recipients" {
  for_each       = toset([var.notify_to, var.contact_to])
  email_identity = each.value
}

# ---------------------------------------------------------------------------
# Webhook idempotency
#
# Authorize.Net retries any non-2xx and can redeliver even after a 200. A
# conditional put on this table is what stops one payment producing two
# notifications: DynamoDB arbitrates the race, so two concurrent deliveries
# cannot both win.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "dedupe" {
  name         = "beast-fit-webhook-dedupe"
  billing_mode = "PAY_PER_REQUEST" # a handful of writes a day; provisioned capacity would be pure waste
  hash_key     = "notificationId"

  attribute {
    name = "notificationId"
    type = "S"
  }

  # The handler writes expiresAt 30 days out — comfortably past Authorize.Net's
  # retry window, so the table stays small without ever forgetting something
  # still in flight.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false # contents are disposable by design; the TTL deletes them anyway
  }
}

# ---------------------------------------------------------------------------
# Shared IAM
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------------------
# Checkout — mints Accept Hosted form tokens
#
# Holds the transaction key and talks to Authorize.Net. It needs no AWS
# permissions beyond writing its own logs, so it gets none: a role with only
# the basic execution policy.
# ---------------------------------------------------------------------------

data "archive_file" "checkout" {
  type = "zip"
  # Includes catalog.json, which is generated from data/training.yaml by
  # `npm run build`. Regenerate before applying or a price change ships to the
  # site without reaching the thing that actually charges for it.
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/.build/checkout.zip"
}

resource "aws_iam_role" "checkout" {
  name               = local.checkout_name
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "checkout_logs" {
  role       = aws_iam_role.checkout.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "checkout" {
  function_name    = local.checkout_name
  role             = aws_iam_role.checkout.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  filename         = data.archive_file.checkout.output_path
  source_code_hash = data.archive_file.checkout.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      AUTHNET_LOGIN_ID        = var.authnet_login_id
      AUTHNET_TRANSACTION_KEY = var.authnet_transaction_key
      AUTHNET_ENV             = var.authnet_env
      ALLOWED_ORIGINS         = join(",", var.allowed_origins)
      SITE_URL                = var.site_url
      NODE_OPTIONS            = "--enable-source-maps"
    }
  }
}

# Function URL rather than API Gateway: no per-request gateway cost and nothing
# to configure. Public by design — the function checks the origin, rate limits
# per IP, and resolves prices server-side, so an unauthenticated caller can do
# nothing but request a token for a price it does not control.
resource "aws_lambda_function_url" "checkout" {
  function_name      = aws_lambda_function.checkout.function_name
  authorization_type = "NONE"
}

resource "aws_cloudwatch_log_group" "checkout" {
  name              = "/aws/lambda/${local.checkout_name}"
  retention_in_days = 14
}

# ---------------------------------------------------------------------------
# Webhook — the authoritative record that money moved
# ---------------------------------------------------------------------------

data "archive_file" "webhook" {
  type        = "zip"
  source_dir  = "${path.module}/lambda-webhook"
  output_path = "${path.module}/.build/webhook.zip"
}

resource "aws_iam_role" "webhook" {
  name               = local.webhook_name
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "webhook_logs" {
  role       = aws_iam_role.webhook.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "webhook" {
  # One table, one action. The handler only ever conditionally puts.
  statement {
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.dedupe.arn]
  }

  # Both identities, not just the sending domain.
  #
  # A domain-only grant is not enough while the SES account is in the sandbox:
  # there the verified recipient is itself an identity and the call is
  # authorised against it too, failing with
  #
  #   not authorized to perform `ses:SendEmail' on resource
  #   `arn:aws:ses:...:identity/<recipient>'
  #
  # which reads as though the sender is wrong and is not. Testing locally does
  # not catch it — a developer's own IAM user has broader rights than this
  # role, so it passes locally and fails once deployed.
  # The From ADDRESS, not just the domain identity.
  #
  # SES authorises SendEmail against the identity of the address being sent
  # from — no-reply@beast-fit.com — and an ARN for the domain does not cover a
  # mailbox at it. Granting the domain alone fails with
  #
  #   not authorized to perform `ses:SendEmail' on resource
  #   `arn:aws:ses:...:identity/no-reply@beast-fit.com'
  #
  # which reads as though the identity is unverified rather than unauthorised.
  # The wildcard covers whatever local part is used without needing a policy
  # change each time, while still being confined to this one domain.
  statement {
    actions = ["ses:SendEmail"]
    resources = [
      aws_sesv2_email_identity.domain.arn,
      "${aws_sesv2_email_identity.domain.arn}/*",
      aws_sesv2_email_identity.recipients[var.notify_to].arn,
    ]
  }
}

resource "aws_iam_role_policy" "webhook" {
  name   = "dedupe-and-notify"
  role   = aws_iam_role.webhook.id
  policy = data.aws_iam_policy_document.webhook.json
}

resource "aws_lambda_function" "webhook" {
  function_name    = local.webhook_name
  role             = aws_iam_role.webhook.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  filename         = data.archive_file.webhook.output_path
  source_code_hash = data.archive_file.webhook.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      AUTHNET_SIGNATURE_KEY = var.authnet_signature_key
      DEDUPE_TABLE          = aws_dynamodb_table.dedupe.name
      NOTIFY_TO             = var.notify_to
      NOTIFY_FROM           = "BEAST Fitness <no-reply@${var.mail_domain}>"
      NODE_OPTIONS          = "--enable-source-maps"
      # AWS_REGION is set by the Lambda runtime and is reserved — setting it
      # here fails the deploy.
    }
  }
}

resource "aws_lambda_function_url" "webhook" {
  function_name      = aws_lambda_function.webhook.function_name
  authorization_type = "NONE" # Authorize.Net cannot sign SigV4; the HMAC signature is the auth
}

resource "aws_cloudwatch_log_group" "webhook" {
  name              = "/aws/lambda/${local.webhook_name}"
  retention_in_days = 14
}

# ---------------------------------------------------------------------------
# Contact form
#
# Shares the SES identity with the webhook — one verified domain, different
# From addresses. Verifying a second domain would mean a second set of DKIM
# records for no benefit.
# ---------------------------------------------------------------------------

data "archive_file" "contact" {
  type        = "zip"
  source_dir  = "${path.module}/lambda-contact"
  output_path = "${path.module}/.build/contact.zip"
}

resource "aws_iam_role" "contact" {
  name               = local.contact_name
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "contact_logs" {
  role       = aws_iam_role.contact.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Sends as this domain only. Note there is no recipient identity in this list:
# the enquiry goes to var.contact_to, which is verified separately below, and
# the acknowledgement goes to an address nobody verified — which SES refuses
# in the sandbox regardless of IAM. Authorisation is not what gates that; see
# the AUTOREPLY note on the function.
data "aws_iam_policy_document" "contact" {
  # Same as the webhook: the From address, not only the domain. See the note
  # on aws_iam_policy_document.webhook.
  statement {
    actions = ["ses:SendEmail"]
    resources = [
      aws_sesv2_email_identity.domain.arn,
      "${aws_sesv2_email_identity.domain.arn}/*",
      aws_sesv2_email_identity.recipients[var.contact_to].arn,
    ]
  }
}

resource "aws_iam_role_policy" "contact" {
  name   = "ses-send"
  role   = aws_iam_role.contact.id
  policy = data.aws_iam_policy_document.contact.json
}

resource "aws_lambda_function" "contact" {
  function_name    = local.contact_name
  role             = aws_iam_role.contact.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  filename         = data.archive_file.contact.output_path
  source_code_hash = data.archive_file.contact.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      CONTACT_TO      = var.contact_to
      CONTACT_FROM    = "BEAST Fitness <no-reply@${var.mail_domain}>"
      AUTOREPLY_FROM  = "BEAST Fitness <no-reply@${var.mail_domain}>"
      ALLOWED_ORIGINS = join(",", var.allowed_origins)
      # "on" only once SES production access is granted. The acknowledgement
      # goes to whatever address the visitor typed, and the sandbox refuses
      # any unverified recipient — so switching this on early means every
      # submission logs a failure while the gym still gets the enquiry.
      AUTOREPLY        = var.autoreply ? "on" : "off"
      TURNSTILE_SECRET = var.turnstile_secret
      NODE_OPTIONS     = "--enable-source-maps"
    }
  }
}

resource "aws_lambda_function_url" "contact" {
  function_name      = aws_lambda_function.contact.function_name
  authorization_type = "NONE"
}

resource "aws_cloudwatch_log_group" "contact" {
  name              = "/aws/lambda/${local.contact_name}"
  retention_in_days = 14
}
