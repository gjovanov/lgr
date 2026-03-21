import type { RepositoryRegistry } from 'dal'
import type { ISignatureRequest } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

/**
 * Send a signature request to signers.
 */
export async function sendSignatureRequest(
  requestId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<ISignatureRequest> {
  const r = repos ?? getRepos()
  const request = await r.signatureRequests.findOne({ id: requestId, orgId } as any)
  if (!request) throw new Error('Signature request not found')
  if (request.state !== 'draft') throw new Error('Can only send draft requests')
  if (request.signers.length === 0) throw new Error('No signers defined')

  // Determine which signers to notify
  const signersToNotify = request.sequentialSigning
    ? [request.signers.find((s: any) => s.state === 'waiting')]
    : request.signers.filter((s: any) => s.state === 'waiting')

  const updatedSigners = request.signers.map((s: any) => {
    const shouldNotify = signersToNotify.some((n: any) => n?.email === s.email)
    return shouldNotify ? { ...s, state: 'sent' } : s
  })

  const updated = await r.signatureRequests.findOneAndUpdate(
    { id: requestId, orgId, state: 'draft' } as any,
    {
      state: 'sent',
      signers: updatedSigners,
      auditTrail: [
        ...request.auditTrail,
        { action: 'sent', date: new Date() },
      ],
    } as any,
  )
  if (!updated) throw new Error('Concurrent modification on signature request')

  logger.info({ requestId, signerCount: signersToNotify.length }, 'Signature request sent')
  return updated
}

/**
 * Record a signer's signature.
 */
export async function recordSignature(
  requestId: string,
  orgId: string,
  signerEmail: string,
  signatureData: string,
  repos?: RepositoryRegistry,
): Promise<ISignatureRequest> {
  const r = repos ?? getRepos()
  const request = await r.signatureRequests.findOne({ id: requestId, orgId } as any)
  if (!request) throw new Error('Signature request not found')
  if (!['sent', 'partially_signed'].includes(request.state)) {
    throw new Error('Request is not in a signable state')
  }

  const signerIndex = request.signers.findIndex((s: any) => s.email === signerEmail)
  if (signerIndex === -1) throw new Error('Signer not found in request')
  const signer = request.signers[signerIndex]
  if (signer.state === 'signed') throw new Error('Signer has already signed')
  if (signer.state === 'waiting' && request.sequentialSigning) {
    throw new Error('Not this signer\'s turn yet')
  }

  const updatedSigners = request.signers.map((s: any, idx: number) => {
    if (idx === signerIndex) {
      return { ...s, state: 'signed', signedDate: new Date(), signatureData }
    }
    // In sequential mode, notify next waiting signer
    if (request.sequentialSigning && s.state === 'waiting' && idx === signerIndex + 1) {
      return { ...s, state: 'sent' }
    }
    return s
  })

  const allSigned = updatedSigners.every((s: any) => s.state === 'signed')
  const newState = allSigned ? 'completed' : 'partially_signed'

  const updated = await r.signatureRequests.update(requestId, {
    state: newState,
    signers: updatedSigners,
    ...(allSigned ? { completedDate: new Date() } : {}),
    auditTrail: [
      ...request.auditTrail,
      { action: `signed:${signerEmail}`, date: new Date() },
      ...(allSigned ? [{ action: 'completed', date: new Date() }] : []),
    ],
  } as any)
  if (!updated) throw new Error('Failed to update signature request')

  logger.info({ requestId, signerEmail, newState }, 'Signature recorded')
  return updated
}

/**
 * Cancel a signature request.
 */
export async function cancelSignatureRequest(
  requestId: string,
  orgId: string,
  repos?: RepositoryRegistry,
): Promise<ISignatureRequest> {
  const r = repos ?? getRepos()
  const request = await r.signatureRequests.findOne({ id: requestId, orgId } as any)
  if (!request) throw new Error('Signature request not found')
  if (['completed', 'cancelled'].includes(request.state)) {
    throw new Error('Cannot cancel completed or already cancelled request')
  }

  const updated = await r.signatureRequests.update(requestId, {
    state: 'cancelled',
    auditTrail: [
      ...request.auditTrail,
      { action: 'cancelled', date: new Date() },
    ],
  } as any)
  if (!updated) throw new Error('Failed to cancel signature request')

  logger.info({ requestId }, 'Signature request cancelled')
  return updated
}

/**
 * Check for expired signature requests.
 * Called by background job (daily).
 */
export async function checkExpiredSignatures(orgId: string, repos?: RepositoryRegistry): Promise<number> {
  const r = repos ?? getRepos()
  const now = new Date()

  const expiredCount = await r.signatureRequests.updateMany(
    {
      orgId,
      state: { $in: ['sent', 'partially_signed'] },
      expiryDate: { $lt: now },
    } as any,
    { state: 'expired' } as any,
  )

  if (expiredCount > 0) {
    logger.info({ orgId, expiredCount }, 'Expired signature requests')
  }
  return expiredCount
}
