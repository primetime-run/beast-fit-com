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

output "dns_records_to_add" {
  description = "DNS for SES. All on the mail. subdomain — nothing here touches the gym's own mailbox."
  value       = <<-EOT

    Every record below is on ${var.mail_subdomain}. The root domain is left
    alone, so whatever handles the gym's actual email is unaffected.

    DKIM (3 records, tokens from `terraform output dkim_tokens`):
      CNAME  <token>._domainkey.${var.mail_subdomain}  ->  <token>.dkim.amazonses.com

    SPF, for the subdomain only:
      TXT    ${var.mail_subdomain}  ->  "v=spf1 include:amazonses.com -all"

    DMARC, for the subdomain only:
      TXT    _dmarc.${var.mail_subdomain}  ->  "v=DMARC1; p=none; rua=mailto:${var.notify_to}"
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
