import { describe, it, expect, afterEach } from 'bun:test'
import { config } from 'config'
import { s3InEu, s3SkipReason, pushBundleToDrive } from 'services/biz/backup/backup-destinations.service'

/**
 * FR-20.97 (plan step P1-9b) — every off-site backup destination in Bulgaria or the EU (Н-18
 * чл. 52з(14), 52к(1)). A master refuses one that is not; the cloud, for now, is told.
 */

const saved = {
  role: config.node.role,
  s3: { ...config.backup.s3 },
  drive: { ...config.backup.googleDrive },
  key: config.backup.encryptionPublicKey,
}

afterEach(() => {
  ;(config.node as any).role = saved.role
  Object.assign(config.backup.s3, saved.s3)
  Object.assign(config.backup.googleDrive, saved.drive)
  config.backup.encryptionPublicKey = saved.key
})

describe('is this object storage in the EU?', () => {
  const cases: Array<[string, string, boolean]> = [
    ['https://s3.eu-central-003.backblazeb2.com', 'us-east-1', true],
    ['https://s3.us-west-004.backblazeb2.com', 'us-east-1', false],
    ['https://s3.eu-central-1.amazonaws.com', 'eu-central-1', true],
    ['https://s3.us-east-1.amazonaws.com', 'us-east-1', false],
    ['https://0123abcd.eu.r2.cloudflarestorage.com', 'auto', true],
    ['https://0123abcd.r2.cloudflarestorage.com', 'auto', false],
    ['https://fsn1.your-objectstorage.com', 'fsn1', true],
    ['https://s3.fr-par.scw.cloud', 'fr-par', true],
    ['https://s3.gra.io.cloud.ovh.net', 'gra', true],
    ['https://s3.bhs.io.cloud.ovh.net', 'bhs', false],
    ['http://192.168.1.20:9000', 'us-east-1', false],
    ['', 'eu-west-1', true],
  ]
  for (const [endpoint, region, eu] of cases) {
    it(`${endpoint || '(no endpoint)'} / ${region} → ${eu ? 'EU' : 'not known'}`, () => {
      expect(s3InEu(endpoint, region, false)).toBe(eu)
    })
  }

  it('an operator may attest what its name does not say (a self-hosted MinIO in Bulgaria)', () => {
    expect(s3InEu('http://192.168.1.20:9000', 'us-east-1', true)).toBe(true)
  })
})

describe('the rule, on a master and on the cloud', () => {
  function s3Configured(endpoint: string) {
    Object.assign(config.backup.s3, {
      endpoint, region: 'us-east-1', bucket: 'b', accessKeyId: 'id', secretAccessKey: 'secret', scope: 'all', euAttested: false,
    })
    config.backup.encryptionPublicKey = 'a-recipient'
  }

  it('a master refuses object storage not known to be in the EU', () => {
    ;(config.node as any).role = 'master'
    s3Configured('https://s3.us-east-1.amazonaws.com')
    expect(s3SkipReason()).toContain('FR-20.97')
    s3Configured('https://s3.eu-central-003.backblazeb2.com')
    expect(s3SkipReason()).toBeNull()
  })

  it('the cloud keeps sending it until the owner decides (§2.8), and says so in its log', () => {
    ;(config.node as any).role = 'global'
    s3Configured('https://s3.us-east-1.amazonaws.com')
    expect(s3SkipReason()).toBeNull()
  })

  it('a master sends nothing to a Drive whose EU data region is not attested, before any network call', async () => {
    ;(config.node as any).role = 'master'
    Object.assign(config.backup.googleDrive, { refreshToken: 'r', clientId: 'c', clientSecret: 's', euAttested: false })
    config.backup.encryptionPublicKey = 'a-recipient'
    const result = await pushBundleToDrive({
      orgId: 'o', manifest: { orgSlug: 'kasa', kind: 'full' } as any, absolutePath: '/nowhere', filename: 'f', sha256: 'x',
    } as any)
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('FR-20.97')
  })
})
