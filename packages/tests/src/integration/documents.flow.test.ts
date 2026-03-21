import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { getRepos } from 'services/context'
import {
  sendSignatureRequest,
  recordSignature,
  cancelSignatureRequest,
  checkExpiredSignatures,
} from 'services/biz/documents.service'
import type { Types } from 'mongoose'

let repos: ReturnType<typeof getRepos>

beforeAll(async () => {
  await setupTestDB()
  repos = getRepos()
})

afterAll(async () => {
  await teardownTestDB()
})

beforeEach(async () => {
  await clearCollections()
})

async function createTestWorkspace(orgId: Types.ObjectId) {
  return repos.documentWorkspaces.create({
    orgId: String(orgId),
    name: 'Test Workspace',
    ownerId: String(orgId),
    memberIds: [],
    isActive: true,
  } as any)
}

async function createTestDocument(orgId: Types.ObjectId, workspaceId: string) {
  return repos.documents.create({
    orgId: String(orgId),
    name: 'contract.pdf',
    workspaceId,
    fileId: String(orgId), // placeholder
    mimeType: 'application/pdf',
    size: 1024,
    ownerId: String(orgId),
    accessLevel: 'workspace',
    sharedWith: [],
    version: 1,
    versions: [{ version: 1, fileId: String(orgId), uploadedBy: String(orgId), uploadedAt: new Date(), size: 1024 }],
    isArchived: false,
  } as any)
}

async function createTestSignatureRequest(orgId: Types.ObjectId, documentId: string, overrides: any = {}) {
  return repos.signatureRequests.create({
    orgId: String(orgId),
    documentId,
    state: 'draft',
    signers: [
      { email: 'alice@example.com', name: 'Alice', role: 'Customer', order: 1, state: 'waiting', smsVerification: false },
      { email: 'bob@example.com', name: 'Bob', role: 'Manager', order: 2, state: 'waiting', smsVerification: false },
    ],
    sequentialSigning: false,
    auditTrail: [],
    createdBy: String(orgId),
    ...overrides,
  } as any)
}

describe('Document Workspaces', () => {
  it('creates a workspace', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    expect(ws.name).toBe('Test Workspace')
    expect(ws.isActive).toBe(true)
  })

  it('creates nested workspaces', async () => {
    const org = await createTestOrg()
    const parent = await createTestWorkspace(org._id)
    const child = await repos.documentWorkspaces.create({
      orgId: String(org._id),
      name: 'Sub Workspace',
      parentId: parent.id,
      ownerId: String(org._id),
      memberIds: [],
      isActive: true,
    } as any)
    expect(child.parentId).toBe(parent.id)
  })
})

describe('Document Management', () => {
  it('creates a document in a workspace', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)

    expect(doc.name).toBe('contract.pdf')
    expect(doc.workspaceId).toBe(ws.id)
    expect(doc.version).toBe(1)
    expect(doc.versions).toHaveLength(1)
    expect(doc.isArchived).toBe(false)
  })

  it('archives and unarchives a document', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)

    await repos.documents.update(doc.id, { isArchived: true } as any)
    const archived = await repos.documents.findById(doc.id)
    expect(archived!.isArchived).toBe(true)

    await repos.documents.update(doc.id, { isArchived: false } as any)
    const unarchived = await repos.documents.findById(doc.id)
    expect(unarchived!.isArchived).toBe(false)
  })

  it('shares a document with a user', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)

    await repos.documents.update(doc.id, {
      sharedWith: [{ userId: '000000000000000000000088', permission: 'view' }],
    } as any)

    const updated = await repos.documents.findById(doc.id)
    expect(updated!.sharedWith).toHaveLength(1)
    expect(updated!.sharedWith[0].permission).toBe('view')
  })
})

describe('E-Signature Flow', () => {
  it('creates a signature request', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)
    const req = await createTestSignatureRequest(org._id, doc.id)

    expect(req.state).toBe('draft')
    expect(req.signers).toHaveLength(2)
    expect(req.sequentialSigning).toBe(false)
  })

  it('sends a signature request (parallel signing)', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)
    const req = await createTestSignatureRequest(org._id, doc.id)

    const sent = await sendSignatureRequest(req.id, String(org._id), repos)
    expect(sent.state).toBe('sent')
    // Both signers should be notified (parallel)
    expect(sent.signers[0].state).toBe('sent')
    expect(sent.signers[1].state).toBe('sent')
    expect(sent.auditTrail).toHaveLength(1)
  })

  it('sends a signature request (sequential signing)', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)
    const req = await createTestSignatureRequest(org._id, doc.id, {
      sequentialSigning: true,
    })

    const sent = await sendSignatureRequest(req.id, String(org._id), repos)
    expect(sent.state).toBe('sent')
    // Only first signer notified
    expect(sent.signers[0].state).toBe('sent')
    expect(sent.signers[1].state).toBe('waiting')
  })

  it('records a signature', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)
    const req = await createTestSignatureRequest(org._id, doc.id)
    await sendSignatureRequest(req.id, String(org._id), repos)

    const signed = await recordSignature(req.id, String(org._id), 'alice@example.com', 'base64data', repos)
    expect(signed.signers[0].state).toBe('signed')
    expect(signed.signers[0].signatureData).toBe('base64data')
    expect(signed.state).toBe('partially_signed')
  })

  it('completes when all signers sign', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)
    const req = await createTestSignatureRequest(org._id, doc.id)
    await sendSignatureRequest(req.id, String(org._id), repos)

    await recordSignature(req.id, String(org._id), 'alice@example.com', 'sig1', repos)
    const completed = await recordSignature(req.id, String(org._id), 'bob@example.com', 'sig2', repos)

    expect(completed.state).toBe('completed')
    expect(completed.completedDate).toBeTruthy()
    expect(completed.signers.every((s: any) => s.state === 'signed')).toBe(true)
  })

  it('cancels a signature request', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)
    const req = await createTestSignatureRequest(org._id, doc.id)
    await sendSignatureRequest(req.id, String(org._id), repos)

    const cancelled = await cancelSignatureRequest(req.id, String(org._id), repos)
    expect(cancelled.state).toBe('cancelled')
  })

  it('rejects cancel on completed request', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)
    const req = await createTestSignatureRequest(org._id, doc.id)
    await sendSignatureRequest(req.id, String(org._id), repos)
    await recordSignature(req.id, String(org._id), 'alice@example.com', 'sig1', repos)
    await recordSignature(req.id, String(org._id), 'bob@example.com', 'sig2', repos)

    await expect(cancelSignatureRequest(req.id, String(org._id), repos))
      .rejects.toThrow(/Cannot cancel/)
  })

  it('expires overdue signature requests', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)
    await createTestSignatureRequest(org._id, doc.id, {
      state: 'sent',
      expiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000), // yesterday
    })

    const expired = await checkExpiredSignatures(String(org._id), repos)
    expect(expired).toBe(1)

    const requests = await repos.signatureRequests.findMany({ orgId: String(org._id) } as any)
    expect(requests[0].state).toBe('expired')
  })

  it('rejects sending non-draft request', async () => {
    const org = await createTestOrg()
    const ws = await createTestWorkspace(org._id)
    const doc = await createTestDocument(org._id, ws.id)
    const req = await createTestSignatureRequest(org._id, doc.id, { state: 'sent' })

    await expect(sendSignatureRequest(req.id, String(org._id), repos))
      .rejects.toThrow(/Can only send draft/)
  })
})
