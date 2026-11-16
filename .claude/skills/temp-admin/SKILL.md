---
name: temp-admin
description: A throwaway LGR admin account (jamesbond-<tag>) for a job that needs API access to production and has no live session - create it in one or more orgs, prove what its session reads, use it, then drop it and prove the drop. Use when a script asks for LGR_USERNAME and LGR_PASSWORD (the importers, the audits, a field test) and when such a job ends or is abandoned.
allowed-tools: Bash(bash:*), Bash(bun:*)
---

# A temp admin

A browser token expires within the day and belongs to a person. A job that needs the API gets its own account, made
for that job and removed with it. The owner's standing rule: no such account outlives its job.

```bash
bash .claude/skills/temp-admin/temp-admin.sh create <tag> <org> [<org> ...]
bash .claude/skills/temp-admin/temp-admin.sh drop   <tag> <org> [<org> ...]
bash .claude/skills/temp-admin/temp-admin.sh status <tag>
```

## Create

`<tag>` is new for every job (letters and digits; the daily import uses `imp<ddmm>`). `create` makes
`jamesbond-<tag>`, role admin, in each org: a dry run of the repository's own `scripts/seed-user.ts` on the build
host, which it shows, then the real one, over a private port-forward to the production database. One person, one
password, a membership per org.

The password exists in one place: the gitignored `<main checkout>/.secrets/lgr-session-<tag>.env`
(`LGR_USERNAME`, `LGR_PASSWORD`). Every API script takes those two from the environment, and
`daily-import/daily.ts` reads the file itself (`--session <tag>`). It is never printed and never passed on a
command line.

`create` ends on a sign-in per org. Then prove what the session reads, before the first real read:

```bash
bun .claude/skills/daily-import/daily.ts grant --org <org> --session <tag>
```

A role can be shown products without cost figures or some price levels. Calls still succeed, and what is read is
less than what is stored. `grant` must say the session reads everything.

If `create` stops part-way, it says so: run `drop` for the same tag, which removes whatever was made, and start
again with a new tag.

## Drop

`drop` is the end of the job, and of an abandoned one. It:

1. signs in once per org while the account still exists, to hold a session of each;
2. deletes the account by e-mail in **every** org, and the person behind it. By e-mail, because the test-org sync
   copies a shop's users into its test copy: an account that existed during a sync is in more orgs than it was
   created in, and "users deleted" then counts those too;
3. proves the result: no row left; sign-in refused in each org, in its test copy, and by username and by e-mail
   with no org; and the sessions of step 1 answering 401 two minutes later (a pod keeps a session's person for
   about a minute);
4. replaces the session file's content with a `DROPPED` note.

It ends on `DROPPED and proven: jamesbond-<tag>`. Anything else is unfinished: read the lines and run it again.
Documents the account created keep its id as their author, like any former employee's.

## When it does not start

- **"port … is busy on the build host"**: another job holds a port-forward there. Wait for it, or give this one its
  own port (`LGR_TEMP_ADMIN_PORT`).
- **"… exists already"**: that tag was used. Take a new one.
- The build host and its key: `LGR_BUILD_HOST`, `LGR_SSH_KEY`; the remote checkout must be at the deployed commit
  (`LGR_REMOTE_CHECKOUT`). All in the header of `temp-admin.sh`.
