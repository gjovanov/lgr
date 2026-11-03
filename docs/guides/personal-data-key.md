# The personal-data key

FR-25 §3.12. Employees' ЕГН, bank details, health data and pay are sealed in the database, under a
key per org (`PersonalDataKey`), which is wrapped by one key outside the database: `PERSONAL_DATA_KEK`.

⚠ **Payroll is kept for 50 years (ЗСч чл. 12). Lose the KEK and every copy of it, and that data is
gone, backups included.** So there are always two copies: the sealed secret the cluster reads, and an
escrow sealed to the backup key. Its custody belongs with the backup seal key's.

## What happens without it

The app starts and everything else works. Writing or reading personal data answers **503
`personal_data_locked`**: never a blank, and never a value stored in clear instead. At startup the app
tries every org's keys and logs an error for those it cannot open, and the morning digest says so too.
A restore refuses a bundle whose keys this server's KEK cannot open.

## First time

Where a browser and the backup seal key are at hand:

```bash
# Writes the KEK to a file and an escrow sealed to BACKUP_ENCRYPTION_PUBLIC_KEY. Prints neither.
bun --env-file=.env scripts/personal-data-key.ts generate \
  --out .secrets/personal-data-kek.env --escrow .secrets/personal-data-kek.sealed

# Proves the escrow opens, with the private half, and holds the same key.
bun scripts/personal-data-key.ts verify --env .secrets/personal-data-kek.env \
  --escrow .secrets/personal-data-kek.sealed --identity .secrets/lgr-backup-seal.key
```

Then seal the value into `lgr-secret` with `kubeseal --raw`, as one key on its own, commit it to
`lgr-deploy`, let ArgoCD sync, and restart the pods. Keep the `.sealed` file beside the seal key, in
both of its places. Once the cluster reads the key and `check` passes, delete the plain `.env` file.
The escrow is what you keep.

```bash
bun --env-file=.env scripts/personal-data-key.ts check   # against the database, with the KEK in the env
```

## Rotating the KEK

Rotate it if it may have leaked, and otherwise when policy says. It touches no data.

1. Generate a new one, as above, under new file names.
2. Deploy with `PERSONAL_DATA_KEK` = the new one and `PERSONAL_DATA_KEK_PREVIOUS` = the old one. Both
   open everything meanwhile.
3. `bun --env-file=.env scripts/personal-data-key.ts rewrap` shows how many; `--execute` does it.
4. `check`, then remove `PERSONAL_DATA_KEK_PREVIOUS` and deploy.
5. Keep the old escrow until no backup wrapped under the old key is still wanted: **a bundle carries
   its key row as it was**, so opening an old backup needs the KEK of its day.

## The drill

Once a year, and before any real payroll first goes in (P1's gate):

1. Open the escrow: `verify` proves it, and the private half unseals it.
2. Take a backup of an org with personal data, and restore it into a throwaway server running with the
   opened KEK.
3. Read a made-up person back with `reveal`, and confirm that a wrong KEK refuses the same restore.

A drill that has never been run proves nothing about the escrow.

## What is not covered

A compromised running app holds the key. Permissions (`payroll.personal`), masking, and the audit row
written before every reveal are what answer misuse of the app itself.
