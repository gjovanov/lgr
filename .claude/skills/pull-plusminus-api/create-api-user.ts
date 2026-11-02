#!/usr/bin/env bun
// create-api-user.ts — creates ONE dedicated PlusMinus account for the LGR tooling on a store's server, then proves it works.
//
// Why: PlusMinus allows one session per account NAME. Every tool that signs in as the shared admin account collides with the store's
// own admin GUI (userLogin answers -2, the tools exit 3). A dedicated account has its own slot and never does.
//
// How the call is known: the vendor's JS wrapper forwards 8 positional strings and says nothing about them. The meaning was read from
// pmapi.UserDataAdd's machine code in the unpacked pmserver.exe (regal-pz, 2026-11-02):
//     userDataAdd(user, role, password, code, name, job, signature, actingUser)
// It is a REPLACE-by-user write: it first deletes every stored field of `user` (role, password, code and its code index, name, job,
// signature, group, pin), then writes the NON-EMPTY ones and stamps modifiedBy/createdBy = actingUser. Two consequences this tool is
// built on:
//   * the account name MUST be new, so it refuses a name `users()` already lists (it would be wiped and rewritten);
//   * an empty value is simply not stored: no code means the account cannot sign in by code.
// That reading is evidence about ONE build, so the tool also refuses a server whose buildTime() differs unless --allow-other-build.
//
//   bun create-api-user.ts --org regal-pz --role <existing role> --creds-out <path>             DRY RUN (default): checks, prints the call
//   bun create-api-user.ts --org regal-pz --role <existing role> --creds-out <path> --execute   writes, diffs every other account
//                                                                                               (must be identical), signs in as the new one
//   [--name lgr-api] [--base-url URL (a tunnelled org)] [--admin-creds FILE] [--allow-other-build]
//
// The admin credentials come from --admin-creds, else PM_ADMIN_CREDS, else PM_CREDS (see stores-env.ts). It never evicts a session: if
// the admin account is connected it exits 3 and touches nothing. It prints no secret; the new credentials are written to --creds-out
// (`un:` / `pw:` lines, refusing to overwrite) BEFORE the call, so a crash cannot lose the password.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomInt } from 'node:crypto'
import { getOrg } from './orgs'
import { optional } from './stores-env'

const VERIFIED_BUILD = '20260805:101606' // pmserver.exe buildTime whose pmapi.UserDataAdd was read
const tls = { rejectUnauthorized: false } as any

const argv = process.argv.slice(2)
const flag = (k: string) => argv.includes(k)
const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const die = (msg: string, code = 2): never => { console.error(`create-api-user: ${msg}`); process.exit(code) }

const orgId = opt('--org') ?? die('--org is required (regal-pz | regal-sf)')
const role = opt('--role') ?? die('--role is required: an existing role of that server (roles() lists them)')
const credsOut = opt('--creds-out') ?? die('--creds-out is required: where the new `un:` / `pw:` file goes (under .secrets/)')
const name = opt('--name') ?? 'lgr-api'
const person = 'LGR API'
const job = 'LGR automation (API)'
const execute = flag('--execute')

const org = getOrg(orgId)
const baseUrl = opt('--base-url') ?? org.baseUrl ?? die(`${orgId} has no fixed address: open a tunnel and pass --base-url (see SKILL.md)`)
const adminFile = opt('--admin-creds') ?? optional('PM_ADMIN_CREDS') ?? optional('PM_CREDS') ?? die('no admin credentials file: --admin-creds, PM_ADMIN_CREDS or PM_CREDS')

const readCreds = (path: string) => {
  const raw = readFileSync(path, 'utf8').replace(/^﻿/, '')
  return { un: raw.match(/^un:\s*(.*)$/m)?.[1]?.trim() ?? '', pw: raw.match(/^pw:\s*(.*)$/m)?.[1]?.trim() ?? '' }
}
const admin = readCreds(adminFile)
if (!admin.un || !admin.pw) die('the admin credentials file did not parse (expected `un: ...` and `pw: ...` lines)')
if (admin.un === name) die(`--name ${name} is the admin account itself`)

// 1) the new credentials file first
let pw: string
if (existsSync(credsOut)) {
  const have = readCreds(credsOut)
  if (have.un !== name || !have.pw) die(`${credsOut} exists but does not hold "${name}" with a password: not touching it`)
  pw = have.pw
  console.log('credentials file already present: reusing its password')
} else {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789' // no look-alikes, nothing that needs escaping
  pw = Array.from({ length: 24 }, () => alphabet[randomInt(alphabet.length)]).join('')
  if (execute) {
    mkdirSync(dirname(credsOut), { recursive: true })
    writeFileSync(credsOut, `# PlusMinus API account for the LGR tooling (${orgId} server only). Written by create-api-user.ts.\nun: ${name}\npw: ${pw}\n`, { flag: 'wx' })
    console.log(`credentials written to ${credsOut}`)
  } else {
    console.log('(dry run: a 24-character password would be generated and written to --creds-out)')
  }
}

const post = async (path: string, token: string, body: string, contentType = 'application/json; charset=utf-8') =>
  (await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': contentType, ...(token ? { Authorization: token } : {}) }, body, tls, signal: AbortSignal.timeout(60000) } as any)).text()
const consoleLogin = async (un: string, pass: string) =>
  (await post('/login', '', new URLSearchParams({ name: un, password: pass }).toString(), 'application/x-www-form-urlencoded'))
    .match(/id=token name=token style=display:none value=([0-9a-f-]+)/)?.[1]
const mobile = (token: string, arr: any[]) => post('/mobile', token, JSON.stringify(arr))

// 2) the guards that need the admin console: slot not held, build as verified
const consoleToken = await consoleLogin(admin.un, admin.pw) ?? die('admin console login failed', 1)
const server = (arr: any[]) => post('/server', consoleToken, JSON.stringify(arr))
if ((await server(['clients'])).split(',').map(s => s.trim()).includes(admin.un)) {
  console.error(`create-api-user: the admin account "${admin.un}" is connected (the store's own GUI?). Not evicting; try later.`)
  process.exit(3)
}
const build = (await server(['buildTime'])).trim().replace(/^"|"$/g, '')
console.log(`server buildTime: ${build}${build === VERIFIED_BUILD ? ' (the build whose code was read)' : ''}`)
if (build !== VERIFIED_BUILD && !flag('--allow-other-build')) die(`this server is not the build whose userDataAdd was read (${VERIFIED_BUILD}); read its pmapi.UserDataAdd first (see pclntab-tools/) or pass --allow-other-build`, 4)

// 3) the admin session: check, write, diff
let wrote = false
const adminToken = await mobile('', ['userLogin', admin.un, admin.pw])
if (adminToken === '-2') die('userLogin -> -2: the admin account is connected. Not evicting.', 3)
if (adminToken.length <= 10) die(`admin userLogin failed: ${JSON.stringify(adminToken)}`, 1)
// Nothing inside the session may call process.exit() or die(): that skips the `finally` below and leaves the admin
// account connected on the store's server (one session per name, so its GUI and the nightly jobs are locked out).
// A failure records itself in `stop` and breaks out; the process exits after the disconnect.
let stop: { code: number; msg?: string } | undefined
session: try {
  if ((await mobile(adminToken, ['companySelect', org.company])) !== 'true') { stop = { code: 1, msg: 'companySelect failed' }; break session }
  const acting = (await mobile(adminToken, ['currentUser'])).trim()
  const snapshot = async () => {
    const users: string[] = JSON.parse(await mobile(adminToken, ['users']))
    const data: any[] = JSON.parse(await mobile(adminToken, ['usersData']))
    const per: Record<string, string> = {}
    for (const u of users) per[u] = (await mobile(adminToken, ['userData', u])) + '|' + (await mobile(adminToken, ['userPermissions', u]))
    return { users, data, per }
  }
  const before = await snapshot()
  console.log(`acting user: ${JSON.stringify(acting)}; existing accounts: ${before.users.length}`)
  // A server can keep no role table at all: regal-sf answers roles() with an empty body and its role labels exist only on the
  // accounts, so the roles it knows are the labels its accounts carry.
  const rolesAnswer = (await mobile(adminToken, ['roles'])).trim()
  const roles: string[] = rolesAnswer ? JSON.parse(rolesAnswer) : [...new Set<string>(before.data.map(d => d.role).filter(Boolean))]
  if (before.users.includes(name)) {
    console.log(`"${name}" already exists: NOT writing (userDataAdd would replace it). Verifying only.`)
  } else if (!roles.includes(role)) {
    stop = { code: 2, msg: `role ${JSON.stringify(role)} is not one of this server's roles: ${roles.join(', ')}` }; break session
  } else {
    console.log('planned call:', JSON.stringify(['userDataAdd', name, role, '<password>', '', person, job, '', acting]))
    if (!execute) { console.log('dry run: nothing written'); stop = { code: 0 }; break session }
    const answer = await mobile(adminToken, ['userDataAdd', name, role, pw, '', person, job, '', acting])
    wrote = true
    console.log('userDataAdd answered:', JSON.stringify(answer.length > 120 ? answer.slice(0, 120) + '…' : answer))
    const after = await snapshot()
    const added = after.users.filter(u => !before.users.includes(u))
    const gone = before.users.filter(u => !after.users.includes(u))
    const same = before.users.filter(u => JSON.stringify(before.data.find(d => d.user === u)) === JSON.stringify(after.data.find(d => d.user === u)) && before.per[u] === after.per[u]).length
    console.log(`accounts added: ${JSON.stringify(added)}; removed: ${JSON.stringify(gone)}; existing accounts unchanged: ${same} of ${before.users.length}`)
    console.log('new record:', JSON.stringify(after.data.find(d => d.user === name)))
    if (added.length !== 1 || added[0] !== name || gone.length || same !== before.users.length) { console.error('UNEXPECTED DIFF: stop and look'); process.exitCode = 5 }
  }
} finally {
  await mobile(adminToken, ['disconnect']).catch(() => {})
}
if (stop) { if (stop.msg) die(stop.msg, stop.code); process.exit(stop.code) }

// 4) prove the new account
if (execute || wrote) {
  const li = await mobile('', ['userLogin', name, pw])
  const ok = li.length > 10
  console.log(`new account userLogin: ${ok ? 'OK (session token received)' : JSON.stringify(li)}`)
  if (ok) {
    try {
      console.log('currentUser as the new account:', (await mobile(li, ['currentUser'])).trim(), '| companySelect:', await mobile(li, ['companySelect', org.company]))
    } finally { await mobile(li, ['disconnect']).catch(() => {}) }
  } else process.exitCode = 6
  // The admin console takes ANY account's login, so this account is not read-only in any sense that matters: whoever holds the
  // password can reach /server (archive, restore, disconnectClient). Say so each time rather than assume.
  console.log(`admin console login with the new account: ${(await consoleLogin(name, pw)) ? 'ACCEPTED: it can reach /server (archive, restore, disconnectClient)' : 'refused'}`)
}
