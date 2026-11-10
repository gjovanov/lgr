---
name: sync-test-orgs
description: Keep the test copies of the real shops (test-regal-pz from regal-pz, test-regal-sf from regal-sf) current, and set up, mark, reset or check a test org. Use when the user asks to refresh, resync, rebuild or check the test orgs, to add a shop's test copy, to mark an org PROD or DEV (the badge in the org menu), or when the daily job (CronJob lgr-org-sync) failed. Runs against the deployed database.
allowed-tools: Bash(bun:*), Bash(kubectl:*), Bash(ssh:*), Bash(scp:*)
---

# Test copies of the real shops

`test-regal-pz` and `test-regal-sf` hold the same catalogue, contacts, stock, invoices and numbering as
`regal-pz` and `regal-sf`, in orgs marked **DEV** (a gray badge beside the name in the org menu; the real
orgs carry a red **PROD**). Nothing in them can print a fiscal receipt, mail a customer or move a real
shelf. Backed by `scripts/org-clone.ts` and the engine in `packages/services/src/biz/org-clone/` (read
its header for the rules); the daily run is the CronJob `lgr-org-sync` in lgr-deploy.

## What a copy holds, and never holds

- **Held:** every business collection (products, stock levels and movements, invoices, contacts,
  warehouses, tags, sequences, orders and reservations, POS sessions, audit log, the logo, apps, ...).
  A copy's `_id` is a pure function of its source's (`ids.ts`), so a second run changes nothing and no
  table is kept. Every reference is rewritten to point INSIDE the copy; not one id of the real org is left.
- **Never copied** (`policy.ts#NEVER_CLONED`): the file store (files, documents, archives, backups: the
  owner's 2026-11-09 rule), fiscal devices and workstations, enrolled desktops and their keys, invites,
  mail logs, inboxes, sign-in credentials, sealed personal data (a source holding it is refused).
- **People:** a membership already in the test org is matched by WHO it is (the identity), not copied
  twice; a permission set or a role by name; an enabled app by app (the app creates those rows itself the first time
  anyone opens the hub, so a copy made right after a reset meets them). A membership the copy adds arrives **switched off**, except an admin's on the first copy
  (`--activate-admins`): who may enter a test org is decided there. A sync never adds access.
- **Switched off on a copy:** the daily digest, the nightly backup, the integrations, the link to the
  books org. Its numbering never goes backwards (`max(copy, real)`).
- **Source wins** on a document both orgs hold (a tester's edit of a copied document is overwritten at
  the next run); documents only the test org holds are never touched; a deletion in the real org is not
  propagated. `--insert-only` leaves even a drifted copy alone.
- **A unique-index clash** (the test org already issued that invoice number) is reported as a `clash`
  and the run goes on.
- **Guards:** a copy is written only into an org marked `dev`, never from one. Every command is a dry run
  until `--execute`.

## The commands

```bash
bun scripts/org-clone.ts status  --pairs regal-pz:test-regal-pz,regal-sf:test-regal-sf    # counts, real vs copy
bun scripts/org-clone.ts sync    --pairs regal-pz:test-regal-pz,regal-sf:test-regal-sf [--execute]
bun scripts/org-clone.ts mark    --org regal-pz --env prod [--execute]                      # the badge
bun scripts/org-clone.ts create  --source regal-sf --target test-regal-sf --name "Test Regal SF OOD" [--execute]
bun scripts/org-clone.ts convert --org regal --to test-regal-pz --name "Test Regal PZ OOD" --source regal-pz [--execute]
bun scripts/org-clone.ts reset   --org test-regal-pz [--execute]     # empties a DEV org, after a verified bundle
```

## Run it against production

Same pattern as `seed-user` (see its skill): on `master-node` (`ssh -o BatchMode=yes -o IdentitiesOnly=yes -i
~/.ssh/id_ed25519 mars`), a private port-forward (never the default 27017), the root URI from `mongodb-secret`
URL-encoded, `PATH="$HOME/.bun/bin:$PATH"`, and `cd ~/lgr && git pull --ff-only origin master` first (the
script must be at the deployed commit). One script file that does port-forward + secret + the command, `scp`'d
and run with `bash`. `MONGODB_URI=mongodb://<u>:<p>@127.0.0.1:27117/lgr?authSource=admin&directConnection=true`.

## The one-time setup (done 2026-11-09), in order

1. `mark --org regal-pz --env prod --execute`, and the same for `regal-sf` (and `regal-acc` if wanted).
2. `convert --org regal --to test-regal-pz --name "Test Regal PZ OOD" --source regal-pz --execute`. `regal`
   was an old test org: its people, permission sets, invites, enrolled desktops and test fiscal devices
   are kept; its other settings (the till's printer gate) stay as they were.
3. `reset --org test-regal-pz --execute` (takes a verified bundle first: the way back is a restore of it).
4. `sync --source regal-pz --target test-regal-pz --activate-admins --relink-hardware pz --execute`
   (the kept fiscal devices pointed at warehouses that no longer exist; this re-points them at `pz`).
5. `create --source regal-sf --target test-regal-sf --name "Test Regal SF OOD" --execute`, then
   `sync --source regal-sf --target test-regal-sf --activate-admins --execute`.
6. `status --pairs ...` must show every row level (the copy may hold MORE: what only it created).

## The daily job

CronJob `lgr-org-sync` (namespace `lgr`, 04:30 Europe/Sofia, `lgr-deploy/k8s/base/cronjob-org-sync.yaml`)
runs `sync --execute` over `ORG_SYNC_PAIRS`. No uploads volume: the copy has no file store.

```bash
kubectl -n lgr get cronjob lgr-org-sync                                   # schedule, last run
kubectl -n lgr get jobs -l app=lgr-org-sync                               # recent runs (3 kept, 5 failed)
kubectl -n lgr logs job/<name>                                            # the per-model table
kubectl -n lgr create job --from=cronjob/lgr-org-sync lgr-org-sync-manual-$(date +%s)   # run now
kubectl -n lgr patch cronjob lgr-org-sync -p '{"spec":{"suspend":true}}'  # pause (selfHeal reverts it: change git)
```

Exit 1 means a pair or a model FAILED (a missing org, `[target_not_dev]`, a model error); clashes alone exit 0.
A new shop = one more pair in the manifest's `ORG_SYNC_PAIRS`, after `create` + `mark` for its test org.

## When something looks wrong

- `[target_not_dev]`: the org is not marked dev. Never "fix" it by marking a real org dev.
- Many `clash` lines: the test org issued numbers the real org later issued too. Harmless for a test org;
  `reset` + `sync` rebuilds it clean (this deletes what only the test org holds).
- Stock differs after a day of testing: the next run sets every copied stock level back to the real one.
- Rollback of a `reset`: restore the pre-reset bundle (printed by `reset`, under `backups/pre-test-org-reset/`)
  with the backup restore screen, or `buildBundle`'s reader. It holds password hashes: keep it on the host.
- A tester cannot see the test org: they are not a member of it (memberships are never added by a sync).
  Add them as a user of the test org, or switch their membership on in Admin > Users there.
