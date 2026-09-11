import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestContact,
  createTestProduct,
  createTestFiscalYear,
  createTestFiscalDevice,
  createTestWarehouse,
} from '../helpers/factories'
import { config } from 'config'
import { BackupRun, Contact, DocFile, Product, RestoreRun, Sequence } from 'db/models'
import { backupController } from '../../../portal-api/src/controllers/backup.controller'
import { runBackupForOrg } from 'services/biz/backup/backup-runner.service'
import { inspectBundle, applyRestore } from 'services/biz/backup/backup-restore.service'
import { bundleDir } from 'services/biz/backup/backup-bundle.service'
import { orgDocsDir, restoreFilesSidecar } from 'services/biz/backup/backup-files.service'
import type { Types } from 'mongoose'

/**
 * FR-13.26–13.37 (#24) — §5.7, the system-administrator restore surface.
 *
 * These are acceptance criteria 14–25 from the spec, written as tests rather than as a
 * checklist, because every one of them describes a failure that is invisible until it is
 * expensive: an org admin reaching a restore button, a flipped byte reaching the database,
 * rows written under an orgId that hides them from every query, an invoice number reissued
 * into a customer's hands.
 *
 * ⚠ `config.backup.sysAdmins` is mutated per test. It is read at call time, not captured at
 * import, so a test can prove BOTH halves of a fail-closed gate — that it refuses when unset
 * and that the same caller works when listed. Restored in `afterEach`.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock. Rejections are caught
 * explicitly with try/catch, which also lets each test assert the MESSAGE, and a wrong
 * message is usually a different refusal than the one under test.
 */

let TMP = ''
let app: Elysia
const SYS_ADMINS_WERE = config.backup.sysAdmins

beforeAll(async () => {
  await setupTestDB()
  TMP = mkdtempSync(join(tmpdir(), 'lgr-restore-'))
  config.upload.dir = TMP
  app = new Elysia().use(backupController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
  rmSync(TMP, { recursive: true, force: true })
}, 60_000)

afterEach(async () => {
  config.backup.sysAdmins = SYS_ADMINS_WERE
  await clearCollections()
}, 30_000)

const DAY = '2026-09-10'

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(user: { id: string; orgId: string; role: string; email: string }) {
  const ctx: any = (signer as any).decorator
  return ctx.jwt.sign({ ...user, username: 'admin', permissions: [] })
}

async function call(
  path: string,
  opts: { method?: string; token?: string; body?: any } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }))
  let json: any = null
  try { json = await res.clone().json() } catch { /* streams */ }
  return { status: res.status, json }
}

async function orgWithAdmin(slug: string) {
  const org = await createTestOrg({ slug, settings: { timezone: 'Europe/Sofia' } } as any)
  const orgId = String(org._id as Types.ObjectId)
  const email = `${slug}@restore.test`
  const user = await createTestUser(org._id as Types.ObjectId, { email, role: 'admin' } as any)
  const token = await tokenFor({ id: String(user._id), orgId, role: 'admin', email })
  return { org, orgId, user, userId: String(user._id), email, token }
}

/** A bundle of `orgId` on disk, plus the `BackupRun` that points at it. */
async function bundleFor(orgId: string, date = DAY) {
  const outcome = await runBackupForOrg(orgId, date, { kind: 'full' })
  expect(outcome?.status).toBe('completed')
  const run: any = await BackupRun.findOne({ orgId, date }).lean().exec()
  return { run, absolutePath: join(bundleDir(orgId), run.filename) }
}

const actor = (u: { userId: string; email: string }) => ({ userId: u.userId, email: u.email })

// ─────────────────────────────────────────────────────────────────────────────
// AC 14 — the allow-list, and that it fails closed
// ─────────────────────────────────────────────────────────────────────────────

describe('the sys-admin allow-list (FR-13.26, AC 14)', () => {
  it('403s EVERY §5.7 route when unset — including for an org admin', async () => {
    const a = await orgWithAdmin('closed-co')
    config.backup.sysAdmins = []

    const routes: [string, string][] = [
      ['POST', `/org/${a.orgId}/backup/create`],
      ['POST', `/org/${a.orgId}/backup/upload`],
      ['POST', `/org/${a.orgId}/backup/restore/inspect`],
      ['POST', `/org/${a.orgId}/backup/restore/apply`],
      ['GET', `/org/${a.orgId}/backup/restores`],
      ['GET', `/org/${a.orgId}/backup/restore/6a99000000000000000000ff`],
    ]
    for (const [method, path] of routes) {
      const res = await call(path, {
        method, token: a.token,
        // A body the schema accepts, so a 403 is the AUTHORISATION answering and not the
        // validator — a 422 here would pass a sloppier assertion while proving nothing.
        body: method === 'POST'
          ? { source: { type: 'run', runId: '6a99000000000000000000ff' }, inspectionId: '6a99000000000000000000ff' }
          : undefined,
      })
      expect([method, path, res.status]).toEqual([method, path, 403])
    }

    // And the org-admin half of the controller still works, so the 403s above are about §5.7
    // and not about the controller being broken for everyone.
    expect((await call(`/org/${a.orgId}/backup/runs`, { token: a.token })).status).toBe(200)
  })

  it('admits a listed caller with no re-login — the JWT is the one they already hold', async () => {
    const a = await orgWithAdmin('listed-co')
    // ⚠ The token was signed BEFORE the allow-list changed and carries `permissions: []`.
    // That is the whole argument for FR-13.26 P1 over a real permission: a PermissionSet
    // change would need this token reissued, and the operator told to sign out.
    config.backup.sysAdmins = [a.email]

    const res = await call(`/org/${a.orgId}/backup/restores`, { token: a.token })
    expect(res.status).toBe(200)
    expect(res.json.runs).toEqual([])
  })

  it('admits by user id as well as by email', async () => {
    const a = await orgWithAdmin('byid-co')
    config.backup.sysAdmins = [a.userId.toUpperCase()]   // and case-insensitively
    expect((await call(`/org/${a.orgId}/backup/restores`, { token: a.token })).status).toBe(200)
  })

  it('refuses a listed sys admin pointed at another organisation', async () => {
    const a = await orgWithAdmin('sys-a')
    const b = await orgWithAdmin('sys-b')
    config.backup.sysAdmins = [a.email]

    // Listed, yes — but the org guard runs first and this is not their org. A sys admin
    // crosses a tenant boundary by uploading a bundle, never by pointing a URL at one.
    expect((await call(`/org/${b.orgId}/backup/restores`, { token: a.token })).status).toBe(403)
  })

  it('reports capability through /access without making the question itself an error', async () => {
    const a = await orgWithAdmin('probe-co')
    config.backup.sysAdmins = []
    let res = await call(`/org/${a.orgId}/backup/access`, { token: a.token })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ sysAdmin: false, configured: false })

    config.backup.sysAdmins = [a.email]
    res = await call(`/org/${a.orgId}/backup/access`, { token: a.token })
    expect(res.json).toEqual({ sysAdmin: true, configured: true })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC 15/16 — Inspect writes nothing; a corrupted bundle is refused before any write
// ─────────────────────────────────────────────────────────────────────────────

describe('Inspect (FR-13.33, AC 15)', () => {
  it('writes nothing — neither counts nor updatedAt move', async () => {
    const a = await orgWithAdmin('inspect-co')
    await createTestContact(a.org._id as Types.ObjectId, { companyName: 'Кирил' } as any)
    await createTestProduct(a.org._id as Types.ObjectId, {} as any)
    const { run } = await bundleFor(a.orgId)

    // ⚠ Counts alone would not prove this: an UPDATE changes nothing countable. The maximum
    // `updatedAt` is what catches a restore that silently rewrote rows it also kept.
    const before = await snapshot(a.orgId)
    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))
    const after = await snapshot(a.orgId)

    expect(after).toEqual(before)
    expect(inspection.status).toBe('completed')
    expect(inspection.mode).toBe('inspect')
    // Everything in the bundle is already live, so nothing is missing and nothing differs.
    const contacts = inspection.collections.find((c: any) => c.name === 'Contact')
    expect(contacts.inBundle).toBe(1)
    expect(contacts.inLive).toBe(1)
    expect(contacts.missing).toBe(0)
    expect(contacts.differing).toBe(0)
  })

  it('counts what a Merge would insert after rows are deleted', async () => {
    const a = await orgWithAdmin('diff-co')
    await createTestContact(a.org._id as Types.ObjectId, { companyName: 'Ще изчезне' } as any)
    const { run } = await bundleFor(a.orgId)

    await Contact.deleteMany({ orgId: a.orgId }).exec()
    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))
    const contacts = inspection.collections.find((c: any) => c.name === 'Contact')
    expect(contacts.inLive).toBe(0)
    expect(contacts.missing).toBe(1)
  })
})

describe('a tampered bundle (FR-13.31, AC 16)', () => {
  it('is rejected on checksum before a single document is written', async () => {
    const a = await orgWithAdmin('flip-co')
    await createTestContact(a.org._id as Types.ObjectId, { companyName: 'Оригинал' } as any)
    const { run, absolutePath } = await bundleFor(a.orgId)

    // Flip one byte in the middle of the compressed artifact.
    const raw = readFileSync(absolutePath)
    raw[Math.floor(raw.length / 2)] ^= 0xff
    writeFileSync(absolutePath, raw)

    const before = await snapshot(a.orgId)
    let message = ''
    try {
      await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))
    } catch (e: any) {
      message = String(e?.message || '')
    }
    expect(message).toContain('verification')
    expect(await snapshot(a.orgId)).toEqual(before)

    // The refusal is itself recorded: a rejected bundle is an event, not a non-event.
    const failed: any = await RestoreRun.findOne({ orgId: a.orgId, status: 'failed' }).lean().exec()
    expect(failed).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC 17 — the cross-tenant refusal, and what remap must leave behind
// ─────────────────────────────────────────────────────────────────────────────

describe('a bundle from another organisation (FR-13.32, AC 17)', () => {
  it('is refused without a remap', async () => {
    const a = await orgWithAdmin('remap-a')
    const b = await orgWithAdmin('remap-b')
    await createTestContact(b.org._id as Types.ObjectId, { companyName: 'Чужд контакт' } as any)
    const { absolutePath } = await bundleFor(b.orgId)

    // Stage B's bundle inside A's directory, the way an upload would.
    const staged = stageInto(a.orgId, absolutePath, 'from-b.ndjson.zst')
    const inspection: any = await inspectBundle(a.orgId, { type: 'path', path: staged }, actor(a))
    expect(inspection.warnings.join(' ')).toContain('remap')

    let message = ''
    try {
      await applyRestore(a.orgId, { type: 'path', path: staged }, {
        mode: 'merge', inspectionId: String(inspection._id), actor: actor(a),
      })
    } catch (e: any) { message = String(e?.message || '') }
    expect(message).toContain('remap')
    expect(await Contact.countDocuments({ orgId: a.orgId })).toBe(0)
  })

  it('leaves no document carrying the original orgId once remapped', async () => {
    const a = await orgWithAdmin('remap2-a')
    const b = await orgWithAdmin('remap2-b')
    await createTestContact(b.org._id as Types.ObjectId, { companyName: 'Мигриран' } as any)
    const { absolutePath } = await bundleFor(b.orgId)
    const staged = stageInto(a.orgId, absolutePath, 'from-b2.ndjson.zst')

    const inspection: any = await inspectBundle(a.orgId, { type: 'path', path: staged }, actor(a))
    const applied: any = await applyRestore(a.orgId, { type: 'path', path: staged }, {
      mode: 'merge', remap: true, inspectionId: String(inspection._id), actor: actor(a),
    })
    expect(applied.status).toBe('completed')

    // The document is IN org A and reachable by org A's own queries — the thing an unremapped
    // restore silently fails to achieve.
    const mine = await Contact.find({ orgId: a.orgId }).lean().exec()
    expect(mine.length).toBe(1)
    expect((mine[0] as any).companyName).toBe('Мигриран')

    // And nothing anywhere still carries B's orgId as a result of this restore. Counting B's
    // own rows would be misleading (B still legitimately has its own), so the assertion is
    // that A gained nothing under B's id.
    const leaked = await Contact.countDocuments({ orgId: b.orgId }).exec()
    expect(leaked).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC 18/19 — Merge only inserts; Replace is blocked for a SUPTO org
// ─────────────────────────────────────────────────────────────────────────────

describe('Merge (FR-13.33, AC 18)', () => {
  it('restores only the documents that are missing, and updates nothing', async () => {
    const a = await orgWithAdmin('merge-co')
    const kept = await createTestContact(a.org._id as Types.ObjectId, { companyName: 'Остава' } as any)
    const lost = await createTestContact(a.org._id as Types.ObjectId, { companyName: 'Изтрит по грешка' } as any)
    const { run } = await bundleFor(a.orgId)

    // The accident this mode exists for.
    await Contact.deleteOne({ _id: lost._id }).exec()
    // And a change to the survivor that Merge must NOT undo.
    await Contact.updateOne({ _id: kept._id }, { $set: { companyName: 'Преименуван след бекъпа' } }).exec()

    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))
    const applied: any = await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
      mode: 'merge', inspectionId: String(inspection._id), actor: actor(a),
    })

    expect(applied.status).toBe('completed')
    expect(applied.documentsDeleted).toBe(0)

    const names = (await Contact.find({ orgId: a.orgId }).lean().exec()).map((c: any) => c.companyName).sort()
    // The deleted one is back; the renamed one keeps its NEW name. Merge inserts, never updates.
    expect(names).toEqual(['Изтрит по грешка', 'Преименуван след бекъпа'])
  })

  it('refuses to apply without an inspection of THIS bundle', async () => {
    const a = await orgWithAdmin('gate-co')
    await createTestContact(a.org._id as Types.ObjectId, {} as any)
    const { run } = await bundleFor(a.orgId)

    let message = ''
    try {
      await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
        mode: 'merge', inspectionId: '6a99000000000000000000ff', actor: actor(a),
      })
    } catch (e: any) { message = String(e?.message || '') }
    expect(message).toContain('Inspect')
    expect(await RestoreRun.countDocuments({ orgId: a.orgId, mode: 'merge', status: 'completed' })).toBe(0)
  })
})

describe('Replace (FR-13.36, AC 19)', () => {
  it('is blocked for an org with an active fiscal device — and Merge still is not', async () => {
    const a = await orgWithAdmin('supto-co')
    await createTestContact(a.org._id as Types.ObjectId, {} as any)
    const wh = await createTestWarehouse(a.org._id as Types.ObjectId, {} as any)
    await createTestFiscalDevice(a.org._id as Types.ObjectId, wh._id as Types.ObjectId, { isActive: true } as any)
    const { run } = await bundleFor(a.orgId)
    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))

    let message = ''
    try {
      await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
        mode: 'replace', confirmSlug: 'supto-co', inspectionId: String(inspection._id), actor: actor(a),
      })
    } catch (e: any) { message = String(e?.message || '') }
    expect(message).toContain('Н-18')
    expect(await Contact.countDocuments({ orgId: a.orgId })).toBe(1)

    // Merge remains available for the same org — the ordinance forbids deletion, not recovery.
    const merged: any = await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
      mode: 'merge', inspectionId: String(inspection._id), actor: actor(a),
    })
    expect(merged.status).toBe('completed')
  })

  it('is blocked by a locked fiscal year inside the bundle’s range', async () => {
    const a = await orgWithAdmin('locked-co')
    await createTestFiscalYear(a.org._id as Types.ObjectId, {
      name: '2025', status: 'locked',
      startDate: new Date('2025-01-01'), endDate: new Date('2030-12-31'),
    } as any)
    const { run } = await bundleFor(a.orgId)
    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))

    let message = ''
    try {
      await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
        mode: 'replace', confirmSlug: 'locked-co', inspectionId: String(inspection._id), actor: actor(a),
      })
    } catch (e: any) { message = String(e?.message || '') }
    expect(message).toContain('locked')
  })

  it('requires the org slug typed to confirm', async () => {
    const a = await orgWithAdmin('slug-co')
    const { run } = await bundleFor(a.orgId)
    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))

    let message = ''
    try {
      await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
        mode: 'replace', confirmSlug: 'wrong', inspectionId: String(inspection._id), actor: actor(a),
      })
    } catch (e: any) { message = String(e?.message || '') }
    expect(message).toContain('slug')
  })

  it('deletes and reinstates when nothing fiscal blocks it', async () => {
    const a = await orgWithAdmin('replace-co')
    await createTestContact(a.org._id as Types.ObjectId, { companyName: 'В бекъпа' } as any)
    const { run } = await bundleFor(a.orgId)
    await createTestContact(a.org._id as Types.ObjectId, { companyName: 'След бекъпа' } as any)

    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))
    const applied: any = await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
      mode: 'replace', confirmSlug: 'replace-co', inspectionId: String(inspection._id), actor: actor(a),
    })

    expect(applied.status).toBe('completed')
    expect(applied.documentsDeleted).toBeGreaterThan(0)
    const names = (await Contact.find({ orgId: a.orgId }).lean().exec()).map((c: any) => c.companyName)
    expect(names).toEqual(['В бекъпа'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC 20/21 — the safety bundle, and sequences that never move backwards
// ─────────────────────────────────────────────────────────────────────────────

describe('the mandatory safety bundle (FR-13.34, AC 20)', () => {
  it('is taken, verified and recorded before any writing restore', async () => {
    const a = await orgWithAdmin('safety-co')
    await createTestContact(a.org._id as Types.ObjectId, {} as any)
    const { run } = await bundleFor(a.orgId)
    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))

    const applied: any = await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
      mode: 'merge', inspectionId: String(inspection._id), actor: actor(a),
    })

    expect(applied.safetyFilename).toBeTruthy()
    expect(applied.safetySha256).toBeTruthy()
    // In `safety/`, which `pruneBundles` does not walk — the copy taken immediately before an
    // operator changed live data must not be evictable by generation counting.
    expect(String(applied.safetyPath)).toContain('safety')
    expect(readFileSync(join(config.upload.dir, applied.safetyPath)).length).toBe(applied.safetyBytes)

    // ⚠ And it is NOT a BackupRun: the unique {orgId,kind,date} claim would collide with the
    // day's own run, or overwrite it.
    expect(await BackupRun.countDocuments({ orgId: a.orgId })).toBe(1)
  })

  it('rolls back byte-for-byte from a restore that fails part-way', async () => {
    const a = await orgWithAdmin('rollback-co')
    const before = await createTestContact(a.org._id as Types.ObjectId, { companyName: 'Преди' } as any)
    await createTestProduct(a.org._id as Types.ObjectId, {} as any)
    const { run, absolutePath } = await bundleFor(a.orgId)
    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))

    // Break the artifact AFTER the inspection, so the failure lands where a real one would:
    // past the gates, with the safety bundle already taken.
    const good = readFileSync(absolutePath)
    const raw = Buffer.from(good)
    raw[Math.floor(raw.length / 2)] ^= 0xff
    writeFileSync(absolutePath, raw)

    let caught: any = null
    try {
      await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
        mode: 'replace', confirmSlug: 'rollback-co', inspectionId: String(inspection._id), actor: actor(a),
      })
    } catch (e: any) { caught = e }
    expect(caught).toBeTruthy()

    // Live data is exactly where it started.
    const still = await Contact.find({ orgId: a.orgId }).lean().exec()
    expect(still.length).toBe(1)
    expect(String((still[0] as any)._id)).toBe(String(before._id))

    writeFileSync(absolutePath, good)
  })
})

describe('sequences never move backwards (FR-13.35, AC 21)', () => {
  it('clamps to max(live, bundle) and reports the clamp', async () => {
    const a = await orgWithAdmin('seq-co')
    await Sequence.create({ orgId: a.org._id, prefix: 'INV', year: 2026, lastNumber: 10 })
    const { run } = await bundleFor(a.orgId)

    // Ten more invoices were issued after the backup was taken. Their numbers are in
    // customers' hands; restoring the bundle's 10 would reissue every one of them.
    await Sequence.updateOne({ orgId: a.orgId, prefix: 'INV', year: 2026 }, { $set: { lastNumber: 20 } }).exec()

    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))
    const applied: any = await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
      // Replace is the dangerous one: it deletes and reinstates everything else, so if any
      // mode could roll a counter back it is this one.
      mode: 'replace', confirmSlug: 'seq-co', inspectionId: String(inspection._id), actor: actor(a),
    })

    expect(applied.status).toBe('completed')
    const live: any = await Sequence.findOne({ orgId: a.orgId, prefix: 'INV', year: 2026 }).lean().exec()
    expect(live.lastNumber).toBe(20)

    const clamp = applied.sequenceClamps.find((c: any) => c.prefix === 'INV')
    expect(clamp).toBeTruthy()
    expect([clamp.live, clamp.bundle, clamp.kept]).toEqual([20, 10, 20])
  })

  it('inserts a sequence the live org does not have at all', async () => {
    const a = await orgWithAdmin('seq2-co')
    await Sequence.create({ orgId: a.org._id, prefix: 'CASH', year: 2026, lastNumber: 7 })
    const { run } = await bundleFor(a.orgId)
    await Sequence.deleteMany({ orgId: a.orgId }).exec()

    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))
    await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
      mode: 'merge', inspectionId: String(inspection._id), actor: actor(a),
    })
    const live: any = await Sequence.findOne({ orgId: a.orgId, prefix: 'CASH' }).lean().exec()
    expect(live.lastNumber).toBe(7)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC 22 — a path that tries to leave the org's directory
// ─────────────────────────────────────────────────────────────────────────────

describe('the source path (FR-13.31)', () => {
  it('refuses a traversal rather than reading whatever it finds', async () => {
    const a = await orgWithAdmin('path-co')
    let message = ''
    try {
      await inspectBundle(a.orgId, { type: 'path', path: '../../../../etc/passwd' }, actor(a))
    } catch (e: any) { message = String(e?.message || '') }
    expect(message).toContain('outside')
  })
})

/** Per-collection counts AND the newest `updatedAt`, which a count alone cannot see. */
async function snapshot(orgId: string) {
  const contacts = await Contact.find({ orgId }).sort({ updatedAt: -1 }).lean().exec()
  const products = await Product.find({ orgId }).sort({ updatedAt: -1 }).lean().exec()
  return {
    contacts: contacts.length,
    products: products.length,
    contactTouched: contacts.length ? String((contacts[0] as any).updatedAt) : '',
    productTouched: products.length ? String((products[0] as any).updatedAt) : '',
  }
}

/** Copy a bundle into an org's own backup directory, as `POST /upload` would. */
function stageInto(orgId: string, absolutePath: string, name: string): string {
  const dir = bundleDir(orgId)
  require('node:fs').mkdirSync(dir, { recursive: true })
  const dest = join(dir, name)
  writeFileSync(dest, readFileSync(absolutePath))
  return name
}

// ─────────────────────────────────────────────────────────────────────────────
// AC 23 — the `full` variant: the org's docs/ bytes, and what a data-only restore omits
// ─────────────────────────────────────────────────────────────────────────────

describe('the full variant (FR-13.29/13.37)', () => {
  /** Put a file where `doc-store.service.ts` would have put it. */
  function writeDoc(orgId: string, rel: string, content: string): string {
    const abs = join(orgDocsDir(orgId), rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    return abs
  }

  it('packs the docs tree beside the rows, and restores it byte-for-byte', async () => {
    const a = await orgWithAdmin('files-co')
    writeDoc(a.orgId, '2026-09-10/фактура-1234.pdf', 'PDF-ish bytes, Кирилица included')
    writeDoc(a.orgId, '2026-09-10/nested/deeper.txt', 'second file')

    const outcome = await runBackupForOrg(a.orgId, DAY, { kind: 'full', variant: 'full' })
    expect(outcome?.status).toBe('completed')
    expect(outcome?.variant).toBe('full')
    expect(outcome?.filesCount).toBe(2)

    // ⚠ Two artifacts, not one. A failure to pack 6.9 GB of PDFs must not cost the org the
    // rows that would have restored its ledger.
    const run: any = await BackupRun.findOne({ orgId: a.orgId }).lean().exec()
    expect(run.filesFilename).toBe(run.filename.replace('.ndjson.zst', '.files.ndjson.zst'))
    expect(run.filesSha256).toBeTruthy()

    // Lose the files, then put them back from the sidecar.
    rmSync(orgDocsDir(a.orgId), { recursive: true, force: true })
    const res = await restoreFilesSidecar(join(bundleDir(a.orgId), run.filesFilename), a.orgId)
    expect(res.written).toBe(2)
    expect(res.checksumFailures).toEqual([])
    expect(readFileSync(join(orgDocsDir(a.orgId), '2026-09-10/фактура-1234.pdf'), 'utf8'))
      .toBe('PDF-ish bytes, Кирилица included')
  })

  it('refuses a sidecar entry that names a path outside the org’s own docs tree', async () => {
    const a = await orgWithAdmin('escape-co')
    // Hand-built, because the builder would never produce this — and an operator-supplied
    // artifact is exactly the input that will.
    const zlib: any = require('node:zlib')
    const lines = [
      JSON.stringify({ format: 'lgr-backup-files-1', orgId: a.orgId, createdAt: new Date().toISOString() }),
      JSON.stringify({ path: '../../../escaped.txt', size: 3, b64: Buffer.from('bad').toString('base64') }),
      JSON.stringify({ path: 'ok.txt', size: 2, b64: Buffer.from('ok').toString('base64') }),
    ].join('\n') + '\n'
    const evil = join(bundleDir(a.orgId), 'evil.files.ndjson.zst')
    mkdirSync(bundleDir(a.orgId), { recursive: true })
    writeFileSync(evil, zlib.zstdCompressSync(Buffer.from(lines, 'utf8')))

    const res = await restoreFilesSidecar(evil, a.orgId)
    expect(res.refused).toEqual(['../../../escaped.txt'])
    // The rest of the sidecar still lands: one refused entry is not a reason to abandon the
    // documents that were fine.
    expect(res.written).toBe(1)
  })

  it('counts DocFile rows whose bytes are not on the volume, and says so', async () => {
    const a = await orgWithAdmin('dangling-co')
    await DocFile.create({
      orgId: a.org._id, docType: 'invoice', docNumber: '0000001234', docDate: '2026-09-10',
      originalName: 'gone.pdf',
      currentPath: join(orgDocsDir(a.orgId), '2026-09-10/gone.pdf'),
      currentChecksum: 'f'.repeat(64), version: 1, mimeType: 'application/pdf', size: 10,
      status: 'uploaded', uploadedBy: a.user._id, uploadedAt: new Date(),
    })
    const { run } = await bundleFor(a.orgId)
    await DocFile.deleteMany({ orgId: a.orgId }).exec()

    const inspection: any = await inspectBundle(a.orgId, { type: 'run', runId: String(run._id) }, actor(a))
    const applied: any = await applyRestore(a.orgId, { type: 'run', runId: String(run._id) }, {
      mode: 'merge', inspectionId: String(inspection._id), actor: actor(a),
    })

    // ⚠ The row came back; the PDF did not. An operator who is not told this finds out when a
    // customer asks for the invoice.
    expect(applied.danglingFileCount).toBe(1)
    expect(applied.warnings.join(' ')).toContain('not on the volume')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FR-13.29 — "Create backup now" as a background job
// ─────────────────────────────────────────────────────────────────────────────

describe('manual create (FR-13.29)', () => {
  /** Poll the task route the way the screen does, bounded so a hang fails instead of hanging. */
  async function awaitTask(orgId: string, token: string, taskId: string) {
    for (let i = 0; i < 60; i++) {
      const res = await call(`/org/${orgId}/backup/task/${taskId}`, { token })
      if (res.status !== 200) return res.json
      if (res.json.status === 'completed' || res.json.status === 'failed') return res.json
      await new Promise(r => setTimeout(r, 100))
    }
    return { status: 'timeout' }
  }

  it('returns a task id immediately and finishes the bundle in the background', async () => {
    const a = await orgWithAdmin('create-co')
    config.backup.sysAdmins = [a.email]
    await createTestContact(a.org._id as Types.ObjectId, {} as any)

    const started = await call(`/org/${a.orgId}/backup/create`, {
      method: 'POST', token: a.token, body: { variant: 'data' },
    })
    // ⚠ The response carries a task id, never the bundle. At year-10 volumes the build
    // outlives the ingress proxy timeout — the lesson the Files app's OCR sidecar paid for.
    expect(started.status).toBe(200)
    expect(started.json.taskId).toBeTruthy()

    const done = await awaitTask(a.orgId, a.token, started.json.taskId)
    expect(done.status).toBe('completed')

    const run: any = await BackupRun.findOne({ orgId: a.orgId }).lean().exec()
    expect(run.source).toBe('manual')
    expect(run.variant).toBe('data')
  })

  it('does not write over the night’s already-verified artifact', async () => {
    const a = await orgWithAdmin('nooverwrite-co')
    config.backup.sysAdmins = [a.email]
    await createTestContact(a.org._id as Types.ObjectId, {} as any)

    // The scheduler's run for today, and the bytes it produced.
    const nightly = await runBackupForOrg(a.orgId, todayLocal(), { kind: 'full' })
    const nightlyPath = join(bundleDir(a.orgId), nightly!.filename!)
    const nightlyBytes = readFileSync(nightlyPath)

    // An operator adds data and asks for a backup NOW. It takes over the day's claim — but
    // the file it writes must be its own: a crash mid-write over the nightly artifact would
    // truncate a backup that has already been verified and shipped off-site.
    await createTestContact(a.org._id as Types.ObjectId, { companyName: 'След нощния' } as any)
    const started = await call(`/org/${a.orgId}/backup/create`, {
      method: 'POST', token: a.token, body: { variant: 'data' },
    })
    const done = await awaitTask(a.orgId, a.token, started.json.taskId)
    expect(done.status).toBe('completed')

    expect(readFileSync(nightlyPath)).toEqual(nightlyBytes)
    // ⚠ Explicitly the MANUAL row. A manual create no longer shares the night's claim, so
    // `findOne({ orgId })` now has two rows to choose between and returns them in storage
    // order — this assertion passed on natural order rather than on meaning.
    const run: any = await BackupRun.findOne({ orgId: a.orgId, source: 'manual' }).lean().exec()
    expect(run.filename).not.toBe(nightly!.filename)
    expect(run.filename).toContain('manual-')

    // The night's row survives the operator's create intact — same claim, same artifact.
    const night: any = await BackupRun.findOne({ orgId: a.orgId, claimKey: 'scheduled' }).lean().exec()
    expect(night.filename).toBe(nightly!.filename)
  })

  it('keeps a row per manual create instead of overwriting the previous one', async () => {
    const a = await orgWithAdmin('multicreate-co')
    config.backup.sysAdmins = [a.email]
    await createTestContact(a.org._id as Types.ObjectId, {} as any)

    // ⚠ The regression. Both creates land on the same org-local DAY, and `kind` is `full` for
    // either — which used to make them the same `{orgId, kind, date}` claim, so the second
    // upserted over the first. The file was written both times and the older one was left
    // with no row pointing at it: absent from the history list, and unreachable by `runId`
    // for a restore. An operator taking a `data` bundle and then a `full` one saw a single
    // entry and had no way to get back to the other artifact sitting on the volume.
    const first = await call(`/org/${a.orgId}/backup/create`, {
      method: 'POST', token: a.token, body: { variant: 'data' },
    })
    expect(await awaitTask(a.orgId, a.token, first.json.taskId)).toMatchObject({ status: 'completed' })

    const second = await call(`/org/${a.orgId}/backup/create`, {
      method: 'POST', token: a.token, body: { variant: 'full' },
    })
    expect(await awaitTask(a.orgId, a.token, second.json.taskId)).toMatchObject({ status: 'completed' })

    const runs: any[] = await BackupRun.find({ orgId: a.orgId, source: 'manual' })
      .sort({ startedAt: 1 }).lean().exec()
    expect(runs).toHaveLength(2)
    expect(runs.map(r => r.variant)).toEqual(['data', 'full'])
    // Distinct claims, distinct artifacts, and the variant legible in both names — the
    // segment that reads `full` in every manual filename is `kind`, never the variant.
    expect(runs[0].claimKey).not.toBe(runs[1].claimKey)
    expect(runs[0].filename).not.toBe(runs[1].filename)
    expect(runs[0].filename).toContain('manual-data-')
    expect(runs[1].filename).toContain('manual-full-')
    // Both are on the volume, and each row points at its own.
    for (const r of runs) expect(existsSync(join(bundleDir(a.orgId), r.filename))).toBe(true)
    // Only the `full` one carries a sidecar; the `data` row must not inherit the other's.
    expect(runs[0].filesFilename).toBeFalsy()
    expect(runs[1].filesFilename).toBeTruthy()
  })

  it('a manual create does not consume the night’s scheduled run', async () => {
    const a = await orgWithAdmin('nightsurvives-co')
    config.backup.sysAdmins = [a.email]
    await createTestContact(a.org._id as Types.ObjectId, {} as any)

    // The operator backs up in the morning, before the scheduler's hour.
    const started = await call(`/org/${a.orgId}/backup/create`, {
      method: 'POST', token: a.token, body: { variant: 'data' },
    })
    expect(await awaitTask(a.orgId, a.token, started.json.taskId)).toMatchObject({ status: 'completed' })

    // ⚠ The scheduled run must still be available to claim. While both shared a claim, the
    // manual row carried a `completedAt` for today, `backupTick` read the day as done, and
    // the org's real nightly backup never ran — a rows-only artifact quietly standing in for
    // the full one, on a day nobody was watching.
    const nightly = await runBackupForOrg(a.orgId, todayLocal(), { kind: 'full' })
    expect(nightly?.status).toBe('completed')
    expect(await BackupRun.countDocuments({ orgId: a.orgId, claimKey: 'scheduled' })).toBe(1)
  })

  it('403s the create route for an admin who is not on the allow-list', async () => {
    const a = await orgWithAdmin('create-denied-co')
    config.backup.sysAdmins = []
    const res = await call(`/org/${a.orgId}/backup/create`, {
      method: 'POST', token: a.token, body: { variant: 'data' },
    })
    expect(res.status).toBe(403)
    expect(await BackupRun.countDocuments({ orgId: a.orgId })).toBe(0)
  })
})

/** The org-local day the create route claims under, computed the way the route computes it. */
function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' })
}
