# ---------------------------------------------------------------------------
# DNS
#
# When the hosted zone is reachable from this account, the records SES needs
# are managed here rather than typed into a console. That matters more than it
# sounds: a mistyped DKIM token fails silently — mail simply stops being
# signed — and the only symptom is deliverability quietly getting worse.
#
# The zone is looked up, not created. It already holds the live site's records;
# declaring it here would leave Terraform believing it owned an empty zone.
# ---------------------------------------------------------------------------

# Gated, because the zone is not in this account today.
#
# beast-fit.com resolves through awsdns-* nameservers, so it IS on Route 53 —
# just in whichever account also runs the Lightsail WordPress instance. This
# account has no hosted zones at all. Looking one up unconditionally fails the
# plan with "no matching Route53Zone found", which reads as a Terraform bug
# rather than what it is: DNS living somewhere else.
#
# Set manage_dns = true once the zone is in this account, or run this stack
# with a provider aliased to the account that holds it.
data "aws_route53_zone" "main" {
  count        = var.manage_dns ? 1 : 0
  name         = "${var.domain}."
  private_zone = false
}

locals {
  zone_id = var.manage_dns ? data.aws_route53_zone.main[0].zone_id : null
}

# --- SES -------------------------------------------------------------------

# Three CNAMEs, one per DKIM key. for_each over the tokens rather than count,
# so a rotation that reorders them does not destroy and recreate all three.
resource "aws_route53_record" "dkim" {
  for_each = var.manage_dns ? toset(aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens) : toset([])

  zone_id = local.zone_id
  name    = "${each.value}._domainkey.${var.mail_domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${each.value}.dkim.amazonses.com"]
}

# SPF for the sending subdomain only. Deliberately NOT on the root domain:
# whatever handles the gym's actual mailbox publishes its own SPF there, and a
# domain may only have one SPF record — a second makes receivers treat the
# whole domain as permerror, which breaks mail that currently works.
resource "aws_route53_record" "spf" {
  count   = var.manage_dns ? 1 : 0
  zone_id = local.zone_id
  name    = var.mail_domain
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com -all"]
}

# p=none: report only, enforce nothing. Starting at quarantine or reject on a
# subdomain that has never sent mail is how legitimate mail lands in spam on
# day one. Tighten once the reports show only expected sources.
resource "aws_route53_record" "dmarc" {
  count   = var.manage_dns ? 1 : 0
  zone_id = local.zone_id
  name    = "_dmarc.${var.mail_domain}"
  type    = "TXT"
  ttl     = 1800
  records = ["v=DMARC1; p=none; rua=mailto:${var.notify_to}"]
}

# --- The cutover -----------------------------------------------------------
#
# These point the domain at GitHub Pages, and creating them takes the live
# WordPress site offline. They are behind a flag, default false, so applying
# this stack for the SES records alone cannot cut the site over by accident.
#
# When ready:  terraform apply -var 'point_dns_at_pages=true'
# To roll back: flip it false and apply — the previous records are restored
# from what is declared below, so check them against the live values first.
#
# allow_overwrite is on because the zone already holds records at these names
# for the current site. Without it the apply fails; with it, Terraform takes
# ownership of them.
# ---------------------------------------------------------------------------

resource "aws_route53_record" "apex" {
  count = var.manage_dns && var.point_dns_at_pages ? 1 : 0

  zone_id         = local.zone_id
  name            = var.domain
  type            = "A"
  ttl             = 300 # low, so a rollback propagates in minutes rather than hours
  allow_overwrite = true

  # GitHub Pages' four anycast addresses. An apex cannot be a CNAME, which is
  # why this is four A records rather than one alias.
  records = [
    "185.199.108.153",
    "185.199.109.153",
    "185.199.110.153",
    "185.199.111.153",
  ]
}

resource "aws_route53_record" "www" {
  count = var.manage_dns && var.point_dns_at_pages ? 1 : 0

  zone_id         = local.zone_id
  name            = "www.${var.domain}"
  type            = "CNAME"
  ttl             = 300
  allow_overwrite = true
  records         = ["${var.github_owner}.github.io"]
}
