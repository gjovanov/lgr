---
name: seed-clients
description: Idempotently upsert customer contacts into an LGR org from a legacy ap_КЛИЕНТИ_*.json export (Bulgarian clients list, CP1251-encoded). Use when the user wants to bulk-load or refresh a tenant's customers/clients from the accounting-system export. Runs locally against the dev DB or against the production cluster Mongo.
allowed-tools: Bash(bun:*), Bash(kubectl:*), Bash(tmux:*), Bash(docker:*)
---

# Seed clients (customer contacts)

Backed by `scripts/seed-contacts.ts` with `--type customer`. Upserts `Contact`
documents (type `customer`) from a legacy `ap_КЛИЕНТИ_*.json` export.

## Source format

Array of `{ ap: "КЛИЕНТИ:<name> - <legal form>", params: { АДРЕС, БУЛСТАТ (EIK),
ГРАД (city), ИНДДС (VAT no), МОЛ (contact person), ТЕЛЕФОН (phone) } }`. Files are
usually **Windows-1251 (CP1251)** encoded — the script auto-detects and decodes
(falls back from UTF-8). These `ap_*.json` files are **gitignored** (business data),
so transfer them to the build host out-of-band (see production section).

Mapping → Contact: `companyName` (the `ap` value minus the `КЛИЕНТИ:` label),
`taxId` ← БУЛСТАТ, `vatNumber` ← ИНДДС, `phone` ← ТЕЛЕФОН, `notes` ← АДРЕС / ГРАД / МОЛ.
The `*Lower` search mirrors are set explicitly (bulkWrite bypasses the plugin hooks)
so Cyrillic search works. No structured address (schema requires a postalCode the
source lacks — street+city live in `notes`).

## Idempotency

Upsert key: `(orgId, type=customer, taxId)` when EIK present, else `vatNumber`, else
`companyName`. Re-running never duplicates — it re-`$set`s the mapped fields. Rows that
share a key (duplicate EIK in the export) collapse to one contact.

## Run

```
bun run scripts/seed-contacts.ts --org <slug> --type customer --file ap_КЛИЕНТИ_*.json [--execute]
```

Local (dev DB):
```bash
docker compose up -d mongo
bun run scripts/seed-contacts.ts --org <slug> --type customer --file ap_КЛИЕНТИ_112500982.json            # dry-run
MONGODB_URI='mongodb://lgr_admin:LgR_5uper5ecretPa55word@localhost:27018/lgr?authSource=admin&directConnection=true' \
  bun run scripts/seed-contacts.ts --org <slug> --type customer --file ap_КЛИЕНТИ_112500982.json --execute
```

Production (cluster Mongo) — the `ap_*.json` is gitignored, so ship it to the build
host separately (the script is in git; only the data needs transferring):
```bash
# from local: gzip+base64 the file, paste it into the master-node/mars tmux session, then:
#   base64 -d /tmp/clients.b64 | gunzip > ~/lgr/ap_КЛИЕНТИ.json
cd ~/lgr && git pull --ff-only && { [ -d node_modules ] || bun install; }
kubectl -n lgr port-forward svc/mongodb 27017:27017 >/tmp/pf.log 2>&1 &
set +H
U=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_USERNAME}' | base64 -d)
P=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_PASSWORD}' | base64 -d)
export MONGODB_URI="mongodb://$U:$P@localhost:27017/lgr?authSource=admin&directConnection=true"
bun run scripts/seed-contacts.ts --org <slug> --type customer --file ap_КЛИЕНТИ.json --execute
kill %1
```

Verify: `Contact.countDocuments({ orgId, type: 'customer' })`, and a Cyrillic search
via `companyNameLower` (`{ companyNameLower: { $regex: '<lower-cyrillic>' } }`).
See also the **seed-suppliers** skill for the suppliers list.
