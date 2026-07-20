---
name: seed-user
description: Create a user in an existing LGR org, fully wired for RBAC + SUPTO — hashed password, atomic operator code, a role with its permission set and a roleHistory activity entry. Use when the user wants to add an admin/manager/accountant/etc. account to an org (e.g. a new tenant's first admin), seed a login for testing, or provision staff accounts. Runs locally against the dev DB or against the production cluster Mongo.
allowed-tools: Bash(bun:*), Bash(kubectl:*), Bash(tmux:*), Bash(docker:*)
---

# Seed a user with role, permissions & activity

Backed by `scripts/seed-user.ts`. Creates one `User` in an existing org, replicating
what the register flow does so the account is immediately usable:

- password hashed with `Bun.password.hash`
- **operatorCode** allocated atomically via the `OPERATOR` sequence (SUPTO — every user needs one)
- **role** + a **roleHistory** entry (the role-assignment activity / audit trail)
- **permissions** from `DEFAULT_ROLE_PERMISSIONS[role]`
- default **permission sets** seeded (idempotent) and the matching set linked (`ROLE_TO_PERMISSION_SET`)

## Options

```
bun run scripts/seed-user.ts --org <slug> --email <e> --username <u> --password <p> --first <F> --last <L> [options]
```

- `--org <slug>` **(required)** — target org, must already exist.
- `--email` `--username` `--password` `--first` `--last` **(required)**. Email/username are unique **per org**, so the same address can exist in multiple orgs.
- `--role <role>` — `admin` (default) `| manager | accountant | warehouse_manager | member | nra_auditor`. Determines permissions + permission set.
- `--middle <m>` — middle name (Bulgarian three-part names).
- `--position <p>` — job title.
- `--inactive` — create inactive (default: **active**, so the account can log in immediately — unlike register, which starts inactive pending email activation).
- `--set-owner` — set `org.ownerId` to this user **if the org has no owner yet**.
- `--execute` — perform writes. **Without it the script is a dry-run** (prints the resolved permissions + permission set, no DB connection).

Idempotency: if a user with the same username or email already exists in the org, it is
reported and left untouched (a missing permission-set link is repaired). Passwords are
never changed for an existing user.

## Run locally (dev DB)

```bash
docker compose up -d mongo
# dry-run
bun run scripts/seed-user.ts --org <slug> --email a@b.com --username admin --password 'Pw12345!!' --first Ann --last Doe --role admin
# execute
MONGODB_URI='mongodb://lgr_admin:LgR_5uper5ecretPa55word@localhost:27018/lgr?authSource=admin&directConnection=true' \
  bun run scripts/seed-user.ts --org <slug> --email a@b.com --username admin --password 'Pw12345!!' --first Ann --last Doe --role admin --execute
```

## Run against production (cluster Mongo)

Use a host with `kubectl` + repo + `bun` — the local **`lgr` tmux session** (SSH'd to
`master-node`) or `ssh mars`. Same port-forward + secret-credential pattern as the
`seed-products` skill:

```bash
cd ~/lgr && git pull --ff-only && { [ -d node_modules ] || bun install; }
kubectl -n lgr port-forward svc/mongodb 27017:27017 >/tmp/pf.log 2>&1 &
set +H
U=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_USERNAME}' | base64 -d)
P=$(kubectl -n lgr get secret mongodb-secret -o jsonpath='{.data.MONGO_INITDB_ROOT_PASSWORD}' | base64 -d)
export MONGODB_URI="mongodb://$U:$P@localhost:27017/lgr?authSource=admin&directConnection=true"
bun run scripts/seed-user.ts --org <slug> ... --execute
kill %1
```

Password note: put passwords containing `!` in **single quotes** and run `set +H` first,
otherwise the interactive shell's history expansion mangles them.

## Bootstrapping a brand-new org

`seed-user` needs the org to exist. A `regal-pz`-style org can be created via the portal
register flow (then `seed-user` adds the admin), or by extending `scripts/import-regal-pz.ts`
which shows the full org bootstrap (Org settings, OrgApps for every `APP_ID`, warehouse,
category). If an org was created via the portal it will default to **free / EUR / en /
Europe-Berlin** — align `settings.baseCurrency`, `locale`, `timezone`, `taxConfig`, and
`subscription.plan` to intent before seeding data into it.
