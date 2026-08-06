output "checkout_endpoint" {
  description = "Set as the PUBLIC_CHECKOUT_ENDPOINT repository variable."
  value       = aws_lambda_function_url.checkout.function_url
}

output "webhook_endpoint" {
  description = "Register this in the Merchant Interface — see next_steps."
  value       = aws_lambda_function_url.webhook.function_url
}

output "contact_endpoint" {
  description = "Set as the PUBLIC_CONTACT_ENDPOINT repository variable."
  value       = aws_lambda_function_url.contact.function_url
}

output "dkim_tokens" {
  description = "The three DKIM CNAME tokens; see dns_records_to_add."
  value       = aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens
}

locals {
  dns_managed = <<-EOT

    Managed here. Terraform owns these, on ${var.mail_domain}:

      3 x CNAME  DKIM
      1 x TXT    SPF
      1 x TXT    DMARC, p=none (report only)

    All on the mail. subdomain, so the root domain's own mail records are
    untouched and the gym's mailbox is unaffected.

    Pointing at GitHub Pages: ${var.point_dns_at_pages ? "YES - apex and www now serve Pages" : "not yet (point_dns_at_pages = false)"}
  EOT

  dns_manual = <<-EOT

    NOT managed here - manage_dns is false, because the hosted zone for
    ${var.domain} is not in this account. It resolves through awsdns-*
    nameservers, so it is on Route 53, in whichever account also runs the
    Lightsail instance.

    Create these by hand in the account that holds the zone. Nothing sends
    until the DKIM records exist and SES has seen them:

      CNAME  <token>._domainkey.${var.mail_domain}  ->  <token>.dkim.amazonses.com
             one per token, from `terraform output dkim_tokens`

      TXT    ${var.mail_domain}
             "v=spf1 include:amazonses.com -all"

      TXT    _dmarc.${var.mail_domain}
             "v=DMARC1; p=none; rua=mailto:${var.notify_to}"

    Every one is on the mail. subdomain. Do NOT add SPF to the root domain: a
    domain may publish only one SPF record, and a second makes receivers treat
    the whole domain as permerror, breaking mail that works today.

    Move the zone into this account (or add a provider alias for the one that
    holds it) and set manage_dns = true to have Terraform own these instead.
  EOT
}

output "dns_status" {
  description = "DNS: either what Terraform manages, or what to create by hand."
  value       = var.manage_dns ? local.dns_managed : local.dns_manual
}

output "next_steps" {
  description = "What Terraform cannot do for you."
  value       = <<-EOT

    1. Verify the recipient. AWS emails ${var.notify_to} a confirmation link
       that someone has to click. Required while SES is in the sandbox, and
       nothing sends until it is done.

    2. Register the webhook in the Merchant Interface:
         Account -> Settings -> Business Settings -> Webhooks -> Add Endpoint
         URL: ${aws_lambda_function_url.webhook.function_url}

       Subscribe to the payment events the handler allow-lists:
         net.authorize.payment.authcapture.created
         net.authorize.payment.capture.created
         net.authorize.payment.refund.created
         net.authorize.payment.void.created
         net.authorize.payment.fraud.held
         net.authorize.payment.fraud.approved
         net.authorize.payment.fraud.declined

       Anything else is acknowledged and ignored, so subscribing more widely
       is harmless — it just produces no behaviour.

    3. Set the repository variable, then re-run the deploy workflow:
         PUBLIC_CHECKOUT_ENDPOINT = ${aws_lambda_function_url.checkout.function_url}

    4. This stack is currently pointed at: ${var.authnet_env}

       While that says "sandbox" no real money can move, whatever card is
       typed. Flip authnet_env to "production" only after a sandbox
       transaction has been seen working end to end — and swap the
       credentials at the same time, since they differ between environments.

    5. Prove the live path with /checkout/test/ — one real $1.00 charge.
       Sandbox proves the code; only a live charge proves the account, the
       webhook and settlement. Refund it from the Merchant Interface after.
  EOT
}
