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

const clientId = process.env.BACKUP_GOOGLE_DRIVE_CLIENT_ID || config.integrations.google.clientId
const clientSecret = process.env.BACKUP_GOOGLE_DRIVE_CLIENT_SECRET || config.integrations.google.clientSecret

if (!clientId || !clientSecret) {
  console.error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.')
  console.error('Register an OAuth client of type "Desktop app" — that type accepts a loopback')
  console.error(`redirect automatically. For a "Web application" client, add ${REDIRECT} to its`)
  console.error('Authorised redirect URIs first, or Google answers redirect_uri_mismatch.')
  process.exit(1)
}

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

console.log('\n── Seal this into lgr-secret, then restart the app ───────────────────────')
console.log(`BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN=${json.refresh_token}`)
console.log('\n⚠ It is deliberately NOT written to the Org document: `orgs` is inside every')
console.log('  backup bundle, so a Drive credential kept there would ride along inside the')
console.log('  thing it protects, and it can delete that copy (FR-13.56).\n')
