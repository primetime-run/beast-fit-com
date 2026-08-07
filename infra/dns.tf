# ---------------------------------------------------------------------------
# DNS
#
# The domain is REGISTERED in this account (Route 53 Domains) but its hosted
# zone is not: the registration delegates to nameservers whose zone lives in
# an account nobody has identified. So DNS cannot be edited from here until a
# zone exists here and the registration points at it.
#
# manage_dns = true creates that zone, carrying the two records the live site
# actually depends on, so switching the delegation changes nothing a visitor
# can see. Only once that is verified should point_dns_at_pages flip.
#
# Sequence:
#   1. terraform apply -var 'manage_dns=true'
#   2. terraform output nameservers  ->  set these on the registered domain
#      (Route 53 -> Registered domains -> beast-fit.com -> Edit name servers)
#   3. wait for propagation, confirm beast-fit.com still serves WordPress
#   4. terraform apply -var 'manage_dns=true' -var 'point_dns_at_pages=true'
#
# Step 3 is the one that gets skipped. Do not skip it: it is the difference
# between a reversible delegation change and an outage with no known-good
# state to go back to.
# ---------------------------------------------------------------------------

resource "aws_route53_zone" "main" {
  count   = var.manage_dns ? 1 : 0
  name    = var.domain
  comment = "beast-fit.com - managed by terraform"

  lifecycle {
    # Destroying this zone takes the domain off the internet entirely, rather
    # than merely reverting a record.
    prevent_destroy = true
  }
}

locals {
  zone_id = var.manage_dns ? aws_route53_zone.main[0].zone_id : null
}

# --- what the live site depends on ------------------------------------------
#
# Carried across so the new zone answers exactly as the old one does. Without
# these, repointing the nameservers resolves the domain to nothing.
#
# Superseded when point_dns_at_pages flips, which is why they are conditional
# on it being false rather than simply present.

resource "aws_route53_record" "legacy_apex" {
  count = var.manage_dns && !var.point_dns_at_pages ? 1 : 0

  # Needed in the rollback direction for the same reason.
  allow_overwrite = true

  zone_id = local.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [var.legacy_apex_ip]
}

resource "aws_route53_record" "legacy_www" {
  count = var.manage_dns && !var.point_dns_at_pages ? 1 : 0

  allow_overwrite = true

  zone_id = local.zone_id
  name    = "www.${var.domain}"
  type    = "CNAME"
  ttl     = 300
  records = [var.legacy_www_target]
}

# --- SES --------------------------------------------------------------------

# Three CNAMEs, one per DKIM key. for_each over the tokens rather than count,
# so a rotation that reorders them does not destroy and recreate all three.
#
# Until these exist the identity sits at DKIM PENDING and SES sends nothing,
# which is the state it is in today.
resource "aws_route53_record" "dkim" {
  for_each = var.manage_dns ? toset(aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens) : toset([])

  zone_id = local.zone_id
  name    = "${each.value}._domainkey.${var.mail_domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${each.value}.dkim.amazonses.com"]
}

# This domain publishes no SPF today and receives no mail, so there is nothing
# to merge with. If it ever starts receiving mail, whoever sets that up must
# MERGE amazonses into this record rather than adding a second one — a domain
# may publish only one SPF record, and two makes receivers fail the lot.
resource "aws_route53_record" "spf" {
  count   = var.manage_dns ? 1 : 0
  zone_id = local.zone_id
  name    = var.mail_domain
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com -all"]
}

# p=none: report only, enforce nothing. Starting at quarantine or reject on a
# domain that has never sent mail is how legitimate mail lands in spam on day
# one. Tighten once the reports show only expected sources.
resource "aws_route53_record" "dmarc" {
  count   = var.manage_dns ? 1 : 0
  zone_id = local.zone_id
  name    = "_dmarc.${var.mail_domain}"
  type    = "TXT"
  ttl     = 1800
  records = ["v=DMARC1; p=none; rua=mailto:${var.notify_to}"]
}

# --- the cutover ------------------------------------------------------------
#
# Replaces the legacy records above with GitHub Pages, taking the WordPress
# site offline the moment it propagates. Hence its own flag and its own step.
#
# Set the custom domain in the repository's Pages settings FIRST. DNS alone is
# not enough: GitHub has to know the hostname belongs to that Pages site, and
# when it does not the result is a "Site not found" page that looks exactly
# like a DNS fault and is not.
#
# Rolling back is flipping the flag and applying — the legacy records return
# from what is declared above. TTL 300 throughout, so that takes minutes.
# ---------------------------------------------------------------------------

resource "aws_route53_record" "apex" {
  count = var.manage_dns && var.point_dns_at_pages ? 1 : 0

  # allow_overwrite, because these replace records at the same name.
  #
  # Flipping the flag destroys legacy_apex/legacy_www and creates these. Route
  # 53 is not transactional across that pair, so the create can land while the
  # old record is still present and fail with "already exists" — leaving the
  # zone with the old records deleted and the new ones never made, which is a
  # domain that resolves to nothing. UPSERT instead of CREATE removes the race.
  allow_overwrite = true

  zone_id = local.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300

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

  # Same reason as the apex above.
  allow_overwrite = true

  zone_id = local.zone_id
  name    = "www.${var.domain}"
  type    = "CNAME"
  ttl     = 300
  records = ["${var.github_owner}.github.io"]
}
