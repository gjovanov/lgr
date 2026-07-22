---
name: seed-suppliers
description: Idempotently upsert supplier contacts into an LGR org from a legacy ap_ДОСТАВЧИЦИ_*.json export (Bulgarian suppliers list, CP1251-encoded). Use when the user wants to bulk-load or refresh a tenant's suppliers/vendors from the accounting-system export. Runs locally against the dev DB or against the production cluster Mongo.
allowed-tools: Bash(bun:*), Bash(kubectl:*), Bash(tmux:*), Bash(docker:*)
---

# Seed suppliers (supplier contacts)

Backed by `scripts/seed-contacts.ts` with `--type supplier`. Upserts `Contact`
documents (type `supplier`) from a legacy `ap_ДОСТАВЧИЦИ_*.json` export.

## Source format

Array of `{ ap: "ДОСТАВЧИЦИ:<name> - <legal form>", params: { АДРЕС, БУЛСТАТ (EIK),
ГРАД (city), ИНДДС (VAT no) } }`. Files are usually **Windows-1251 (CP1251)** encoded —
the script auto-detects and decodes (falls back from UTF-8). These `ap_*.json` files
are **gitignored** (business data); transfer them to the build host out-of-band.

Mapping → Contact: `companyName` (the `ap` value minus the `ДОСТАВЧИЦИ:` label),
`taxId` **and `taxNumber`** ← БУЛСТАТ (falling back to the digits of ИНДДС — the
contact form's "Tax Number (EIK)" field reads `taxNumber`), `vatNumber` ← ИНДДС,
`addresses[0]` ← `{ type: billing, street: АДРЕС, city: ГРАД minus the "гр." label,
country: BG }` (the address subschema's city/postalCode are optional since 2026-07-22),
`notes` ← МОЛ only. The `*Lower` search mirrors are set explicitly (bulkWrite
bypasses the plugin hooks) for Cyrillic search.

## Idempotency

Upsert key: `(orgId, type=supplier, taxId=БУЛСТАТ)` when БУЛСТАТ present, else
`vatNumber`, else `companyName` — keyed on the **source** fields so re-runs match
docs created by earlier seeder versions (which never derived taxId from ИНДДС).
Re-running never duplicates; rows sharing a key collapse to one contact. A re-run
replaces `notes` (old runs stored Адрес/Град there — the address now lands in
`addresses[]`) and overwrites `addresses[0]` from the export.

## Run

```
bun run scripts/seed-contacts.ts --org <slug> --type supplier --file ap_ДОСТАВЧИЦИ_*.json [--execute]
```

Local (dev DB):
```bash
docker compose up -d mongo
bun run scripts/seed-contacts.ts --org <slug> --type supplier --file ap_ДОСТАВЧИЦИ_112500982.json            # dry-run
MONGODB_URI='mongodb://lgr_admin:LgR_5uper5ecretPa55word@localhost:27018/lgr?authSource=admin&directConnection=true' \
  bun run scripts/seed-contacts.ts --org <slug> --type supplier --file ap_ДОСТАВЧИЦИ_112500982.json --execute
```

Production (cluster Mongo) — the `ap_*.json` is gitignored, so ship it to the build
host separately (script is in git; only the data needs transferring):
```bash
# from local: gzip+base64 the file, paste into the master-node/mars tmux session, then:
#   base64 -d /tmp/suppliers.b64 | gunzip > ~/lgr/ap_ДОСТАВЧИЦИ.json
cd ~/lgr && git pull --ff-only && { [ -d node_modules ] || bun install; }
kubectl -n lgr port-forward svc/mongodb 27017:27017 >/tmp/pf.log 2>&1 &
set +H
U=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_USERNAME}' | base64 -d)
P=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_PASSWORD}' | base64 -d)
export MONGODB_URI="mongodb://$U:$P@localhost:27017/lgr?authSource=admin&directConnection=true"
bun run scripts/seed-contacts.ts --org <slug> --type supplier --file ap_ДОСТАВЧИЦИ.json --execute
kill %1
```

Verify: `Contact.countDocuments({ orgId, type: 'supplier' })` and a Cyrillic
`companyNameLower` regex search. See also the **seed-clients** skill.
