terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = ">= 5.40" }
    archive = { source = "hashicorp/archive", version = ">= 2.4" }
    random  = { source = "hashicorp/random", version = ">= 3.6" }
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

# Used to make the waiver bucket name globally unique — S3 names are shared
# across every AWS account, so "beast-fit-waivers" alone would collide.
data "aws_caller_identity" "current" {}

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
  # 512MB, not for the memory — for the CPU.
  #
  # Lambda scales CPU with memory, so this roughly halves both init and
  # execution. Measured cold starts were 152ms (checkout), 363ms (contact) and
  # 406ms (webhook), the last two carrying the AWS SDK imports.
  #
  # It is free in practice. At this volume the monthly total is a few hundred
  # GB-seconds against a 400,000 GB-second free tier, and the shorter durations
  # partly offset the higher rate anyway.
  #
  # Provisioned concurrency was the alternative and is not worth it: ~$2.74 per
  # function per month to remove 150-400ms, when the checkout's real latency is
  # the Authorize.Net round trip it would not affect.
  memory_size = 512

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
  # 512MB, not for the memory — for the CPU.
  #
  # Lambda scales CPU with memory, so this roughly halves both init and
  # execution. Measured cold starts were 152ms (checkout), 363ms (contact) and
  # 406ms (webhook), the last two carrying the AWS SDK imports.
  #
  # It is free in practice. At this volume the monthly total is a few hundred
  # GB-seconds against a 400,000 GB-second free tier, and the shorter durations
  # partly offset the higher rate anyway.
  #
  # Provisioned concurrency was the alternative and is not worth it: ~$2.74 per
  # function per month to remove 150-400ms, when the checkout's real latency is
  # the Authorize.Net round trip it would not affect.
  memory_size = 512

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
  # 512MB, not for the memory — for the CPU.
  #
  # Lambda scales CPU with memory, so this roughly halves both init and
  # execution. Measured cold starts were 152ms (checkout), 363ms (contact) and
  # 406ms (webhook), the last two carrying the AWS SDK imports.
  #
  # It is free in practice. At this volume the monthly total is a few hundred
  # GB-seconds against a 400,000 GB-second free tier, and the shorter durations
  # partly offset the higher rate anyway.
  #
  # Provisioned concurrency was the alternative and is not worth it: ~$2.74 per
  # function per month to remove 150-400ms, when the checkout's real latency is
  # the Authorize.Net round trip it would not affect.
  memory_size = 512

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

# ---------------------------------------------------------------------------
# Waiver
#
# Renders a signed PDF, archives it, emails it. The archive is the point: an
# emailed waiver is a notification, and an inbox gets migrated, pruned and
# lost. This bucket is what you produce in a dispute years later.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "waivers" {
  bucket = "beast-fit-waivers-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    # These are legal records. Destroying the bucket destroys evidence.
    prevent_destroy = true
  }
}

# Nothing here is ever public. Signed waivers carry names, dates of birth and
# emergency contacts; a bucket policy mistake would expose all of it at once.
resource "aws_s3_bucket_public_access_block" "waivers" {
  bucket                  = aws_s3_bucket.waivers.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versioning so an overwrite or a delete is recoverable — the document has to
# survive mistakes, not just disk failures.
resource "aws_s3_bucket_versioning" "waivers" {
  bucket = aws_s3_bucket.waivers.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "waivers" {
  bucket = aws_s3_bucket.waivers.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# No expiry rule on the objects themselves. How long a signed waiver must be
# kept is a legal question, not an infrastructure one, and quietly deleting
# them on a schedule nobody chose is worse than paying for storage. Old
# versions of a replaced file are cleaned up; the current one never is.
resource "aws_s3_bucket_lifecycle_configuration" "waivers" {
  bucket     = aws_s3_bucket.waivers.id
  depends_on = [aws_s3_bucket_versioning.waivers]

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 365
    }
  }
}

# pdf-lib has to be in the zip. Bundling is triggered by a change to the
# lockfile, so a fresh clone or a dependency bump reinstalls before archiving
# rather than shipping whatever happens to be on disk.
resource "terraform_data" "waiver_deps" {
  triggers_replace = [
    filemd5("${path.module}/lambda-waiver/package.json"),
  ]

  provisioner "local-exec" {
    command = "npm --prefix ${path.module}/lambda-waiver install --omit=dev --no-audit --no-fund"
  }
}

data "archive_file" "waiver" {
  depends_on  = [terraform_data.waiver_deps]
  type        = "zip"
  source_dir  = "${path.module}/lambda-waiver"
  output_path = "${path.module}/.build/waiver.zip"
}

resource "aws_iam_role" "waiver" {
  name               = "beast-fit-waiver"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "waiver_logs" {
  role       = aws_iam_role.waiver.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "waiver" {
  # Write only, and only into this bucket. The function has no reason to read
  # back what it has stored, and not granting GetObject means a compromised
  # function cannot enumerate everyone who ever signed.
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.waivers.arn}/waivers/*"]
  }

  # The From address as well as the domain — see the note on the webhook
  # policy. The recipient identity covers the gym's inbox while SES is in the
  # sandbox.
  statement {
    actions = ["ses:SendEmail"]
    resources = [
      aws_sesv2_email_identity.domain.arn,
      "${aws_sesv2_email_identity.domain.arn}/*",
      aws_sesv2_email_identity.recipients[var.contact_to].arn,
    ]
  }
}

resource "aws_iam_role_policy" "waiver" {
  name   = "archive-and-send"
  role   = aws_iam_role.waiver.id
  policy = data.aws_iam_policy_document.waiver.json
}

# Generated once and kept in state rather than asked for as a variable. Nobody
# needs to know this value — it only has to be stable, secret, and identical
# across invocations. Rotating it invalidates challenges issued in the previous
# two minutes, which is not worth thinking about.
resource "random_password" "challenge_secret" {
  length  = 48
  special = false
}

resource "aws_lambda_function" "waiver" {
  function_name    = "beast-fit-waiver"
  role             = aws_iam_role.waiver.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  filename         = data.archive_file.waiver.output_path
  source_code_hash = data.archive_file.waiver.output_base64sha256

  # Longer and larger than the others: this one renders a PDF, and pdf-lib's
  # font work is CPU-bound.
  timeout     = 20
  memory_size = 1024

  environment {
    variables = {
      WAIVER_TO       = var.contact_to
      WAIVER_FROM     = "BEAST Fitness <no-reply@${var.mail_domain}>"
      ARCHIVE_BUCKET  = aws_s3_bucket.waivers.id
      ALLOWED_ORIGINS = join(",", var.allowed_origins)
      # "on" only once SES production access is granted — the signer's address
      # is not verified, and the sandbox refuses it.
      SIGNER_COPY  = var.waiver_signer_copy ? "on" : "off"
      NODE_OPTIONS = "--enable-source-maps"

      # Without this the challenge check passes unconditionally — the handler
      # treats an unset secret as "not configured" so a half-finished deploy
      # cannot lock everyone out. It has to be set for the gate to exist.
      CHALLENGE_SECRET = random_password.challenge_secret.result

      # ~65,000 hashes: about 70ms in a browser, and the same again for every
      # attempt a bot makes. Each extra bit doubles the cost to both sides.
      POW_BITS = "16"
    }
  }
}

resource "aws_lambda_function_url" "waiver" {
  function_name      = aws_lambda_function.waiver.function_name
  authorization_type = "NONE"
}

resource "aws_cloudwatch_log_group" "waiver" {
  name              = "/aws/lambda/beast-fit-waiver"
  retention_in_days = 14
}
