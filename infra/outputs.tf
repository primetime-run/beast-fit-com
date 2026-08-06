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

output "dns_status" {
  description = "What this stack has done to DNS."
  value       = <<-EOT

    The Route 53 zone for ${var.domain} is in this account, so the SES records
    are managed by Terraform — nothing to type by hand:

      3 x CNAME  DKIM, on ${var.mail_subdomain}
      1 x TXT    SPF,  on ${var.mail_subdomain}
      1 x TXT    DMARC, p=none (report only)

    All on the mail. subdomain. The root domain's own mail records are
    untouched, so whatever handles the gym's mailbox is unaffected.

    Pointing at GitHub Pages: ${var.point_dns_at_pages ? "YES — the apex and www now serve Pages" : "not yet (point_dns_at_pages = false)"}
  EOT
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
