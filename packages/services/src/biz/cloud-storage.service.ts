import { config } from 'config'
import { logger } from '../logger/logger.js'

export interface CloudFileInfo {
  id: string
  name: string
  mimeType: string
  size: number
  path: string
  modifiedAt: Date
  /**
   * Provider metadata carried on the file itself. FR-13.59 requires the remote copy to be
   * SELF-DESCRIBING — checksum, covered window, org, kind — so an operator can tell what an
   * artifact is without downloading it.
   */
  properties?: Record<string, string>
}

export interface CloudTokens {
  accessToken: string
  refreshToken: string
}

export interface CloudQuota {
  /** Bytes still available. `undefined` when the provider does not report one. */
  free?: number
  total?: number
  used?: number
}

/**
 * ⚠ This interface grew three write methods for FR-13, and that widening is deliberate.
 *
 * It was designed for IMPORTING documents — `getAuthUrl` / `handleCallback` / `listFiles` /
 * `downloadFile`, all read-only. Backups need to put bytes there, to remove them for
 * retention, and to find or create the folder they live in. Because the interface is shared,
 * the Dropbox and OneDrive stubs must carry the same signatures or the type stops compiling;
 * they throw `not_implemented`, which is honest, rather than returning a success-shaped empty
 * value the caller would record as a destination reached.
 */
export interface CloudStorageAdapter {
  getAuthUrl(orgId: string): string
  handleCallback(code: string, orgId?: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date; email: string }>
  listFiles(tokens: CloudTokens, folderId?: string, recursive?: boolean): Promise<CloudFileInfo[]>
  downloadFile(tokens: CloudTokens, fileId: string): Promise<Buffer>
  /** Returns the new file's id. MUST NOT resolve on a partial transfer (FR-13.52). */
  uploadFile(tokens: CloudTokens, folderId: string, name: string, content: Buffer, opts?: { mimeType?: string; properties?: Record<string, string> }): Promise<CloudFileInfo>
  deleteFile(tokens: CloudTokens, fileId: string): Promise<void>
  /** Find-or-create, one path segment at a time. Returns the deepest folder's id. */
  ensureFolder(tokens: CloudTokens, path: string[]): Promise<string>
  getQuota(tokens: CloudTokens): Promise<CloudQuota>
}

/**
 * Raised when Google says the refresh token itself is dead — revoked consent, a password
 * change, or ~6 months idle.
 *
 * ⚠ It is a distinct type because the CALLER must treat it differently from a transport
 * error. A network blip is worth retrying tonight; `invalid_grant` will fail identically
 * every night until a human re-consents, and until then the destination is NOT reached. A
 * silently dead Drive token is the roomler `latest`-symlink failure wearing a different
 * costume (FR-13.54).
 */
export class CloudReconsentRequired extends Error {
  readonly provider: string
  constructor(provider: string, detail?: string) {
    super(`${provider}: the stored refresh token is no longer valid — re-consent is required${detail ? ` (${detail})` : ''}`)
    this.name = 'CloudReconsentRequired'
    this.provider = provider
  }
}

// ── Google Drive ────────────────────────────────────────────────────────────
//
// Implemented with plain `fetch`, the house pattern for third-party APIs
// (`oauth.service.ts:42`, `email.service.ts:119`). The placeholder this replaces said it
// "requires googleapis" — it does not: the Drive endpoints are ordinary HTTPS, and pulling
// that dependency into an image that already carries Chromium buys nothing (FR-13.53).

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

/**
 * ⚠ `drive.file`, not `drive.readonly` and not full `drive`.
 *
 * `drive.file` is per-file access limited to what this application itself created. A backup
 * job only ever touches its own artifacts, so it is sufficient — and it means a leaked token
 * cannot read the account's other documents. The previous scope, `drive.readonly`, cannot
 * write at all.
 *
 * ⚠ Changing the scope INVALIDATES consent already granted: any org connected under
 * `drive.readonly` must re-consent (FR-13.51).
 */
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** Quote a value for a Drive `q` expression. Names are user-controlled text. */
function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * Exchange the refresh token for an access token.
 *
 * ⚠ Called at the START of every run, unconditionally. Access tokens last about an hour, so a
 * nightly job ALWAYS begins with an expired one — refreshing is the normal path here, not an
 * error branch (FR-13.54).
 */
export async function refreshGoogleAccessToken(refreshToken: string, opts: { clientId?: string; clientSecret?: string } = {}): Promise<{ accessToken: string; expiresAt: Date }> {
  const clientId = opts.clientId || config.integrations.google.clientId
  const clientSecret = opts.clientSecret || config.integrations.google.clientSecret
  if (!clientId || !clientSecret) throw new Error('google drive: no OAuth client configured')

  let res: Response
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
  } catch (e: any) {
    throw new Error(`google drive: could not reach the token endpoint: ${e?.message}`)
  }

  const body = await res.text()
  if (!res.ok) {
    // `invalid_grant` is the one that never gets better on its own.
    if (/invalid_grant/.test(body)) throw new CloudReconsentRequired('google_drive', `HTTP ${res.status}`)
    throw new Error(`google drive: token refresh failed with ${res.status}: ${body.slice(0, 300)}`)
  }

  const json = JSON.parse(body)
  if (!json.access_token) throw new CloudReconsentRequired('google_drive', 'no access_token in the response')
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000),
  }
}

/**
 * One authenticated Drive call.
 *
 * Refreshes once on a 401 — an access token can expire mid-run on a long upload, and losing a
 * verified bundle to a token that aged out during transfer would be an absurd way to fail.
 */
async function driveFetch(tokens: CloudTokens, url: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${tokens.accessToken}` },
  })
  if (res.status === 401 && !retried && tokens.refreshToken) {
    const fresh = await refreshGoogleAccessToken(tokens.refreshToken)
    tokens.accessToken = fresh.accessToken
    return driveFetch(tokens, url, init, true)
  }
  return res
}

async function driveJson(tokens: CloudTokens, url: string, init: RequestInit = {}): Promise<any> {
  const res = await driveFetch(tokens, url, init)
  const body = await res.text()
  if (!res.ok) throw new Error(`google drive: ${init.method || 'GET'} ${url.split('?')[0]} → ${res.status}: ${body.slice(0, 300)}`)
  return body ? JSON.parse(body) : {}
}

export const googleDriveAdapter: CloudStorageAdapter = {
  getAuthUrl(orgId: string) {
    const { clientId, redirectUri } = config.integrations.google
    // ⚠ `handleCallback` takes no orgId of its own — the existing design smuggles it through
    // the redirect URI, and the deployed configmap already sets GOOGLE_REDIRECT_URI to a
    // path containing `{orgId}`. Keep it rather than break the URIs registered with Google.
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri.replace('{orgId}', orgId),
      response_type: 'code',
      scope: GOOGLE_DRIVE_SCOPE,
      // `offline` is what makes Google issue a refresh token at all; `consent` forces it to
      // be re-issued even when the user has approved this app before — without it a second
      // consent returns an access token only, and the job has nothing durable to store.
      access_type: 'offline',
      prompt: 'consent',
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  },

  async handleCallback(code: string, orgId?: string) {
    const { clientId, clientSecret, redirectUri } = config.integrations.google
    if (!clientId || !clientSecret) throw new Error('google drive: no OAuth client configured')

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        // Google matches this against the URI the code was issued for, character for
        // character — hence the same `{orgId}` substitution as `getAuthUrl`.
        redirect_uri: orgId ? redirectUri.replace('{orgId}', orgId) : redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`google drive: code exchange failed with ${res.status}: ${body.slice(0, 300)}`)
    const json = JSON.parse(body)
    if (!json.refresh_token) {
      // Without this the caller would store an access token that dies within the hour and
      // report success — a connection that works once and then silently stops.
      throw new Error('google drive: no refresh_token returned. Revoke the app at myaccount.google.com/permissions and consent again.')
    }

    let email = ''
    try {
      const who = await driveJson(
        { accessToken: json.access_token, refreshToken: json.refresh_token },
        `${DRIVE_API}/about?fields=user(emailAddress)`,
      )
      email = who?.user?.emailAddress || ''
    } catch {
      // Knowing WHICH account was connected is useful, not essential. A failure here must not
      // discard a refresh token that was issued correctly.
    }

    logger.info({ email }, 'Google Drive OAuth callback completed')
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(Date.now() + (Number(json.expires_in) || 3600) * 1000),
      email,
    }
  },

  async listFiles(tokens, folderId, recursive) {
    const out: CloudFileInfo[] = []
    let pageToken: string | undefined
    const fields = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,appProperties,parents)'

    do {
      const params = new URLSearchParams({
        q: `${folderId ? `${q(folderId)} in parents and ` : ''}trashed = false`,
        fields,
        pageSize: '1000',
        ...(pageToken ? { pageToken } : {}),
      })
      const page = await driveJson(tokens, `${DRIVE_API}/files?${params}`)
      for (const f of page.files || []) {
        out.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: Number(f.size) || 0,
          path: f.name,
          modifiedAt: new Date(f.modifiedTime),
          properties: f.appProperties || undefined,
        })
        if (recursive && f.mimeType === FOLDER_MIME) {
          out.push(...(await googleDriveAdapter.listFiles(tokens, f.id, true)))
        }
      }
      pageToken = page.nextPageToken
    } while (pageToken)

    return out
  },

  async downloadFile(tokens, fileId) {
    const res = await driveFetch(tokens, `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`)
    if (!res.ok) {
      throw new Error(`google drive: download of ${fileId} failed with ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    return Buffer.from(await res.arrayBuffer())
  },

  /**
   * ⚠ RESUMABLE ONLY, at every size, and that is the point.
   *
   * Google's simple and multipart uploads cap at 5 MB. Today's `data` bundle is 3.2 MiB — under
   * the threshold — so a naive multipart implementation works perfectly right up until it
   * silently stops working inside year 1, and a `full` bundle is ~80 MB today. Implementing
   * only the resumable path means there is no size at which the code changes behaviour, which
   * is worth the one extra round trip Google itself recommends paying (FR-13.52).
   */
  async uploadFile(tokens, folderId, name, content, opts = {}) {
    const metadata: any = {
      name,
      parents: [folderId],
      // FR-13.59 — the remote copy describes itself: checksum, covered window, org, kind. An
      // operator can then tell what an artifact is from a listing, without downloading it.
      ...(opts.properties ? { appProperties: opts.properties } : {}),
    }

    const start = await driveFetch(tokens, `${DRIVE_UPLOAD}?uploadType=resumable&fields=id,name,size,mimeType,modifiedTime,appProperties`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': opts.mimeType || 'application/octet-stream',
        'X-Upload-Content-Length': String(content.length),
      },
      body: JSON.stringify(metadata),
    })
    if (!start.ok) {
      throw new Error(`google drive: could not open a resumable session for ${name}: ${start.status} ${(await start.text()).slice(0, 200)}`)
    }
    const session = start.headers.get('location')
    if (!session) throw new Error(`google drive: the resumable session for ${name} returned no upload URL`)

    let uploaded = 0
    let attempts = 0
    // The session URL already carries its own authorisation, so these PUTs go through plain
    // `fetch` — adding a Bearer header to a resumable session is what makes Google answer 401
    // on a perfectly good upload.
    while (uploaded < content.length) {
      if (attempts++ > 8) throw new Error(`google drive: gave up resuming ${name} after ${attempts} attempts at byte ${uploaded}`)

      const chunk = content.subarray(uploaded)
      const res = await fetch(session, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${uploaded}-${content.length - 1}/${content.length}`,
        },
        body: chunk,
      })

      if (res.status === 200 || res.status === 201) {
        const f = await res.json() as any
        return {
          id: f.id,
          name: f.name,
          mimeType: f.mimeType || opts.mimeType || 'application/octet-stream',
          size: Number(f.size) || content.length,
          path: f.name,
          modifiedAt: f.modifiedTime ? new Date(f.modifiedTime) : new Date(),
          properties: f.appProperties || undefined,
        }
      }

      // 308 = "keep going". The `Range` header says what Google actually holds, which may be
      // less than what we believe we sent.
      if (res.status === 308) {
        const range = res.headers.get('range')
        const end = range ? Number(range.split('-')[1]) : NaN
        const next = Number.isFinite(end) ? end + 1 : uploaded
        if (next <= uploaded) {
          throw new Error(`google drive: ${name} stopped making progress at byte ${uploaded}`)
        }
        uploaded = next
        continue
      }

      // ⚠ Anything else is a FAILURE, and it throws rather than returning what was written so
      // far. A partial upload must never be recorded as a destination reached (FR-13.52) —
      // "the bytes are half there" and "the bytes are there" have to be distinguishable, or
      // the restore is where you find out.
      throw new Error(`google drive: upload of ${name} failed at byte ${uploaded} with ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }

    throw new Error(`google drive: upload of ${name} ended without a completion response`)
  },

  async deleteFile(tokens, fileId) {
    const res = await driveFetch(tokens, `${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
    // 404 means it is already gone, which is the state the caller wanted.
    if (!res.ok && res.status !== 404) {
      throw new Error(`google drive: delete of ${fileId} failed with ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
  },

  async ensureFolder(tokens, path) {
    let parent = 'root'
    for (const segment of path) {
      const params = new URLSearchParams({
        q: `name = ${q(segment)} and mimeType = ${q(FOLDER_MIME)} and ${q(parent)} in parents and trashed = false`,
        fields: 'files(id)',
        pageSize: '1',
      })
      const found = await driveJson(tokens, `${DRIVE_API}/files?${params}`)
      if (found.files?.length) {
        parent = found.files[0].id
        continue
      }
      const created = await driveJson(tokens, `${DRIVE_API}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: segment, mimeType: FOLDER_MIME, parents: [parent] }),
      })
      parent = created.id
    }
    return parent
  },

  async getQuota(tokens) {
    const about = await driveJson(tokens, `${DRIVE_API}/about?fields=storageQuota`)
    const sq = about?.storageQuota || {}
    // ⚠ `limit` is ABSENT on an unlimited (Workspace) account — absent means unlimited, not
    // zero. Returning 0 there would make the pre-flight refuse every upload against a Drive
    // with room for all of them.
    const total = sq.limit !== undefined ? Number(sq.limit) : undefined
    const used = sq.usage !== undefined ? Number(sq.usage) : undefined
    return {
      total,
      used,
      free: total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined,
    }
  },
}

/**
 * The stubs.
 *
 * ⚠ They throw rather than returning `[]` / an empty Buffer / a fabricated id. The read
 * methods kept their original empty-value behaviour because callers already handle "this
 * import found nothing"; the WRITE methods must not, because a success-shaped return from a
 * provider that stored nothing is exactly what a backup destination must never produce.
 */
function notImplemented(provider: string, method: string): never {
  throw new Error(`${provider}.${method} is not implemented`)
}

export const dropboxAdapter: CloudStorageAdapter = {
  getAuthUrl(orgId: string) {
    const { appKey } = config.integrations.dropbox
    return `https://www.dropbox.com/oauth2/authorize?client_id=${appKey}&response_type=code`
  },
  async handleCallback(code: string) {
    logger.info('Dropbox OAuth callback received')
    return { accessToken: '', refreshToken: '', expiresAt: new Date(), email: '' }
  },
  async listFiles() { return [] },
  async downloadFile() { return Buffer.alloc(0) },
  async uploadFile() { return notImplemented('dropbox', 'uploadFile') },
  async deleteFile() { return notImplemented('dropbox', 'deleteFile') },
  async ensureFolder() { return notImplemented('dropbox', 'ensureFolder') },
  async getQuota() { return notImplemented('dropbox', 'getQuota') },
}

export const onedriveAdapter: CloudStorageAdapter = {
  getAuthUrl(orgId: string) {
    const { clientId } = config.integrations.onedrive
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&scope=Files.Read`
  },
  async handleCallback(code: string) {
    logger.info('OneDrive OAuth callback received')
    return { accessToken: '', refreshToken: '', expiresAt: new Date(), email: '' }
  },
  async listFiles() { return [] },
  async downloadFile() { return Buffer.alloc(0) },
  async uploadFile() { return notImplemented('onedrive', 'uploadFile') },
  async deleteFile() { return notImplemented('onedrive', 'deleteFile') },
  async ensureFolder() { return notImplemented('onedrive', 'ensureFolder') },
  async getQuota() { return notImplemented('onedrive', 'getQuota') },
}

export function getAdapter(provider: string): CloudStorageAdapter {
  switch (provider) {
    case 'google_drive': return googleDriveAdapter
    case 'onedrive': return onedriveAdapter
    case 'dropbox': return dropboxAdapter
    default: throw new Error(`Unknown provider: ${provider}`)
  }
}
