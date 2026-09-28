#!/usr/bin/env bun
/**
 * FR-13.48/13.51/13.55 (#24) — obtain a Google Drive refresh token from a terminal.
 *
 * The web callback (`POST /org/:orgId/integration/google-drive/callback`) does the same thing
 * for someone with a browser and an admin session. This exists for the operator case: setting
 * up the backup destination on mars, before there is a UI to click, and without granting
 * anyone an admin session to do it.
 *
 *   bun --env-file=.env scripts/google-drive-consent.ts
 *   bun --env-file=.env scripts/google-drive-consent.ts --append-env .env
 *   bun --env-file=.env scripts/google-drive-consent.ts --client-file <path> --append-env .env
 *
 * With no client configured in the environment it uses `.secrets/google-oauth-client.json`,
 * the Desktop-app client JSON downloaded from the Cloud console. Everything the resulting
 * token can touch lives under ONE root folder in that Drive — `LGR/<org slug>/<kind>/` — and
 * `drive.file` means it cannot see anything in the account it did not create itself.
 *
 * `--append-env` writes the refresh token straight into that file instead of printing it.
 * Prefer it: a credential printed once lives on in scrollback, shell history, and whatever
 * captured the session.
 *
 * ⚠ Use a DEDICATED Google account, never a personal one. The credential this produces can
 * DELETE the off-site copy, and it must be revocable without taking anything else with it
 * (FR-13.56).
 *
 * ⚠ There is no API-key alternative and this is worth knowing before someone looks for one: a
 * Google API key authenticates anonymous access to PUBLIC data and cannot write to a private
 * Drive at all. A service account is not a shortcut either — service accounts have no storage
 * quota and cannot own files, so uploading to one's own My Drive fails `403
 * storageQuotaExceeded` even against an empty Drive (FR-13.48). OAuth with a long-lived
 * refresh token is the only shape Google permits.
 */

import { createInterface } from 'node:readline/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { config } from '../packages/config/src/index.js'
import { GOOGLE_DRIVE_SCOPE } from '../packages/services/src/biz/cloud-storage.service.js'

/**
 * ⚠ LOOPBACK, not out-of-band.
 *
 * The obvious shape for a terminal tool is `urn:ietf:wg:oauth:2.0:oob` — Google prints the
 * code, the operator pastes it back, no socket required. **Google removed that flow.** OOB has
 * been blocked since 2023 and now answers `invalid_request`, so a script built on it fails at
 * the first screen. The supported replacement for an installed app is a loopback redirect,
 * which is also what `rclone authorize` uses.
 *
 * This therefore listens on 127.0.0.1 for exactly one request — which means RUN IT ON A
 * MACHINE WITH A BROWSER, your laptop, not mars. The refresh token it produces is portable;
 * being portable is the entire point of a refresh token.
 */
const PORT = Number(process.env.BACKUP_GOOGLE_DRIVE_CONSENT_PORT) || 53682
const REDIRECT = `http://127.0.0.1:${PORT}`

/**
 * Where the OAuth client comes from, in order:
 *
 *   1. `--client-file <path>`                       an explicit Desktop-app client JSON
 *   2. `BACKUP_GOOGLE_DRIVE_CLIENT_ID` + `…_SECRET` the dedicated Drive client, already in env
 *   3. `.secrets/google-oauth-client.json`          the file an operator dropped in
 *   4. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`  the shared cloud-storage integration client
 *
 * ⚠ The dropped file outranks (4) deliberately. Putting a client JSON in `.secrets/` is an
 * explicit act; silently consenting with a different, older client instead would mint a token
 * the backup job cannot refresh, and the mismatch only shows up as `invalid_grant` on the first
 * nightly run.
 */
const clientFileArg = (() => {
  const i = process.argv.indexOf('--client-file')
  return i === -1 ? undefined : process.argv[i + 1]
})()
const defaultClientFile = new URL('../.secrets/google-oauth-client.json', import.meta.url)

function readClientFile(where: string | URL): { clientId: string; clientSecret: string } | undefined {
  try {
    if (!existsSync(where)) return undefined
    const raw = JSON.parse(readFileSync(where, 'utf8'))
    // Google hands out `{ "installed": {…} }` for a Desktop app and `{ "web": {…} }` otherwise.
    const c = raw.installed ?? raw.web ?? raw
    if (!c?.client_id || !c?.client_secret) return undefined
    return { clientId: String(c.client_id), clientSecret: String(c.client_secret) }
  } catch (e: any) {
    console.error(`Could not read the OAuth client file ${where}: ${e?.message}`)
    process.exit(1)
  }
}

const fromFile = clientFileArg ? readClientFile(clientFileArg) : undefined
if (clientFileArg && !fromFile) {
  console.error(`${clientFileArg} has no client_id / client_secret in it.`)
  process.exit(1)
}
const fromEnv = process.env.BACKUP_GOOGLE_DRIVE_CLIENT_ID && process.env.BACKUP_GOOGLE_DRIVE_CLIENT_SECRET
  ? { clientId: process.env.BACKUP_GOOGLE_DRIVE_CLIENT_ID, clientSecret: process.env.BACKUP_GOOGLE_DRIVE_CLIENT_SECRET }
  : undefined
const dropped = fromFile || fromEnv ? undefined : readClientFile(defaultClientFile)
const shared = config.integrations.google.clientId && config.integrations.google.clientSecret
  ? { clientId: config.integrations.google.clientId, clientSecret: config.integrations.google.clientSecret }
  : undefined

const source = fromFile ? `--client-file ${clientFileArg}`
  : fromEnv ? 'BACKUP_GOOGLE_DRIVE_CLIENT_ID / …_SECRET'
  : dropped ? '.secrets/google-oauth-client.json'
  : shared ? 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET' : ''
const client = fromFile || fromEnv || dropped || shared

if (!client) {
  console.error('No OAuth client to consent with.')
  console.error('Drop the Desktop-app client JSON at .secrets/google-oauth-client.json (that path is')
  console.error('gitignored), pass --client-file <path>, or set BACKUP_GOOGLE_DRIVE_CLIENT_ID and')
  console.error('BACKUP_GOOGLE_DRIVE_CLIENT_SECRET.')
  console.error('Register the client as type "Desktop app" — that type accepts a loopback redirect')
  console.error(`automatically. For a "Web application" client, add ${REDIRECT} to its Authorised`)
  console.error('redirect URIs first, or Google answers redirect_uri_mismatch.')
  process.exit(1)
}
const { clientId, clientSecret } = client
console.log(`\nOAuth client: ${clientId.split('-')[0]}… (from ${source})`)
// The pair only needs writing back when it did not come from the environment the server reads.
const clientNeedsSealing = !fromEnv

const params = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: 'code',
  // ⚠ `drive.file` — per-file access to what this app creates. NOT full `drive`: a backup job
  // only ever touches its own artifacts, so a leaked token must not be able to read the
  // account's other documents (FR-13.51).
  scope: GOOGLE_DRIVE_SCOPE,
  // `offline` is what makes Google issue a refresh token at all; `consent` forces a new one
  // even when this app has been approved before — without it, a second run returns an access
  // token that dies within the hour and nothing durable to store.
  access_type: 'offline',
  prompt: 'consent',
})

console.log('\n1. Open this URL as the DEDICATED backup Google account:\n')
console.log(`   https://accounts.google.com/o/oauth2/v2/auth?${params}\n`)
console.log(`2. Approve. Google redirects to ${REDIRECT} and this script catches the code.\n`)

/**
 * Wait for Google's redirect — or accept a paste.
 *
 * The paste fallback is not decoration. If the browser is on another machine, the redirect
 * lands on a page that cannot load, and the operator can still copy the whole
 * `http://127.0.0.1:…/?code=…` out of the address bar. Losing a consent that Google has
 * already granted, to a networking detail, would mean going round the entire loop again —
 * including revoking the app first, because a second consent without `prompt=consent`
 * returns no refresh token at all.
 */
const code = await new Promise<string>((resolve, reject) => {
  const server = Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url)
      const c = u.searchParams.get('code')
      const err = u.searchParams.get('error')
      queueMicrotask(() => {
        server.stop(true)
        if (c) resolve(c)
        else reject(new Error(err || 'the redirect carried no code'))
      })
      return new Response(
        c
          ? '<h2>Connected.</h2><p>Return to the terminal — the refresh token is printed there.</p>'
          : `<h2>Consent failed</h2><p>${err || 'no code in the redirect'}</p>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    },
  })

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.question('   …or paste the full redirected URL here, if your browser is on another machine: ')
    .then(answer => {
      const trimmed = answer.trim()
      if (!trimmed) return
      const c = trimmed.startsWith('http') ? new URL(trimmed).searchParams.get('code') : trimmed
      if (c) { server.stop(true); resolve(c) }
    })
    .catch(() => {})
    .finally(() => rl.close())
})

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: REDIRECT, grant_type: 'authorization_code',
  }),
})
const body = await res.text()
if (!res.ok) {
  console.error(`\nGoogle rejected the code (${res.status}): ${body}`)
  process.exit(1)
}

const json = JSON.parse(body)
if (!json.refresh_token) {
  // Storing the access token instead would produce a connection that works for one hour and
  // then silently stops — the failure mode this whole FR is about.
  console.error('\nGoogle returned no refresh_token. Revoke the app at')
  console.error('https://myaccount.google.com/permissions and run this again.')
  process.exit(1)
}

let email = ''
try {
  const who = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota', {
    headers: { Authorization: `Bearer ${json.access_token}` },
  })
  const about = await who.json() as any
  email = about?.user?.emailAddress || ''
  if (about?.storageQuota?.limit) {
    const free = (Number(about.storageQuota.limit) - Number(about.storageQuota.usage)) / 1024 / 1024 / 1024
    console.log(`\nConnected as ${email} — ${free.toFixed(2)} GB free.`)
    // ⚠ 15 GB on a free account is shared with Gmail and Photos. The mongodb chain fits; the
    // uploads rotation does not (FR-13.57).
    if (free < 1) console.log('⚠ Under 1 GB free. The nightly upload will refuse rather than fail mid-transfer.')
  } else {
    console.log(`\nConnected as ${email}.`)
  }
} catch {
  // Not knowing the account is cosmetic; a token that was issued correctly must not be thrown
  // away over it.
}

/**
 * ⚠ Google puts a clock on some refresh tokens and says so in this response. The usual cause
 * is a consent screen left External + "Testing": seven days, after which the nightly job fails
 * `reconsent_required` every night. The token is still written below — it works until then —
 * but a token that works today is not the test.
 */
const refreshTtl = Number(json.refresh_token_expires_in) || 0
if (refreshTtl > 0) {
  console.error(`\n⚠ This refresh token EXPIRES in ${(refreshTtl / 86400).toFixed(1)} days (Google's refresh_token_expires_in).`)
  console.error('  The client\'s consent screen is most likely External + "Testing". Publish it')
  console.error('  (Google Auth Platform → Audience → Publish app) or make it Internal, then run this again.')
}

/**
 * ⚠ `--append-env <file>` keeps the token off stdout entirely.
 *
 * Printing a credential once puts it in four places nobody is thinking about: the terminal's
 * scrollback, the shell's history, whatever is capturing the session, and — if a tool ran the
 * command for you — its transcript. This token can DELETE the off-site backups, so the
 * default of printing it is the convenience, not the safe choice.
 */
const appendEnv = (() => {
  const i = process.argv.indexOf('--append-env')
  return i === -1 ? undefined : process.argv[i + 1]
})()

if (appendEnv) {
  const existing = existsSync(appendEnv) ? readFileSync(appendEnv, 'utf8') : ''
  if (/^BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN=.+$/m.test(existing)) {
    // Appending a second one would leave two lines whose precedence depends on the loader —
    // a config that works today and silently uses the stale token after the next restart.
    console.error(`\n⚠ ${appendEnv} already has a BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN with a value.`)
    console.error('  Replace it by hand rather than ending up with two lines and no idea which wins.')
    console.error('  Re-run without --append-env to print the new token instead.')
    process.exit(1)
  }

  /**
   * ⚠ The client pair is written alongside the token, not just the token.
   *
   * The server refreshes with `config.backup.googleDrive`, which reads
   * BACKUP_GOOGLE_DRIVE_CLIENT_ID/SECRET and only then falls back to GOOGLE_CLIENT_ID. If the
   * consent was granted with a client that exists solely in `.secrets/`, sealing the token
   * alone produces a token the running app cannot refresh — `invalid_client`, discovered on
   * the first nightly run rather than here.
   */
  const lines = [`BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN=${json.refresh_token}`]
  const alreadyHasClient = /^BACKUP_GOOGLE_DRIVE_CLIENT_ID=.+$/m.test(existing)
  if (clientNeedsSealing && !alreadyHasClient) {
    lines.push(`BACKUP_GOOGLE_DRIVE_CLIENT_ID=${clientId}`, `BACKUP_GOOGLE_DRIVE_CLIENT_SECRET=${clientSecret}`)
  }

  writeFileSync(
    appendEnv,
    existing.replace(/^BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN=\s*$\n?/m, '') +
      (existing && !existing.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n',
  )
  console.log(`\n── Written to ${appendEnv} — nothing was printed ─────────────────────────`)
  for (const l of lines) console.log(`  ${l.split('=')[0]}`)
  if (clientNeedsSealing && alreadyHasClient) {
    console.log(`  ⚠ ${appendEnv} already sets BACKUP_GOOGLE_DRIVE_CLIENT_ID — left as it is.`)
    console.log(`    Confirm it is ${clientId.split('-')[0]}…, the client this consent was granted to,`)
    console.log('    or the app will fail to refresh with invalid_client.')
  }
  console.log('  ⚠ Check that file is gitignored before you commit anything.')
} else {
  console.log('\n── Seal this into lgr-secret, then restart the app ───────────────────────')
  console.log(`BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN=${json.refresh_token}`)
  if (clientNeedsSealing) {
    // Without the pair the consent was granted to, the server refreshes with a different
    // client and Google answers `invalid_client` on the first nightly run.
    console.log(`BACKUP_GOOGLE_DRIVE_CLIENT_ID=${clientId}`)
    console.log(`BACKUP_GOOGLE_DRIVE_CLIENT_SECRET=${clientSecret}`)
  }
  console.log('  ⚠ Now in this terminal\'s scrollback and your shell history. `--append-env <file>`')
  console.log('    writes it straight to a file instead.')
}
console.log('\n⚠ It is deliberately NOT written to the Org document: `orgs` is inside every')
console.log('  backup bundle, so a Drive credential kept there would ride along inside the')
console.log('  thing it protects, and it can delete that copy (FR-13.56).\n')
