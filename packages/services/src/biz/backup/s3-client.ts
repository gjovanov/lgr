/**
 * FR-13.58 (#24) — a minimal S3 client: SigV4 over `fetch`, four operations, no dependency.
 *
 * **Why hand-rolled.** `@aws-sdk/client-s3` is ~20 MB of transitive dependencies, a new supply
 * chain in the image that builds every backup, for four requests whose signing algorithm is a
 * page of HMACs. The same argument the Drive adapter already made (`cloud-storage.service.ts`
 * is raw `fetch`, not `googleapis`), for the same reason: the code that has to still work in
 * ten years should depend on as little as possible that might not.
 *
 * **What it is for.** Google Drive has no object-lock — the credential that writes can delete
 * (FR-13.58) — and the artifact that must outlive a leaked token is the ten-year archive, not
 * last night's bundle. This is the destination that can say "retain until 2036 and no key,
 * including mine, may shorten that".
 *
 * ⚠ Path-style addressing by default (`https://<endpoint>/<bucket>/<key>`). B2, R2 and MinIO
 * all serve it; virtual-host style needs per-bucket DNS and is opt-in.
 *
 * ⚠ Errors never carry the request body or the Authorization header. An S3 error document is
 * safe to quote and is the only thing an operator can act on; the signature is not.
 */

import { createHash, createHmac } from 'node:crypto'
import { fetchWithTimeout } from '../outbound-fetch.js'

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
}

export interface S3ObjectLock {
  /** `COMPLIANCE` | `GOVERNANCE`. Empty/absent uploads with no retention header at all. */
  mode?: string
  years?: number
}

export interface S3ListedObject {
  key: string
  size: number
  lastModified?: string
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest()

/**
 * RFC 3986, which is NOT what `encodeURIComponent` produces.
 *
 * ⚠ `!`, `'`, `(`, `)` and `*` are left alone by `encodeURIComponent` and must be escaped, or
 * the canonical request disagrees with what the server reconstructs and every signature over a
 * key containing one of them fails with an opaque `SignatureDoesNotMatch`. Bundle names are
 * generated from an org slug, so this is reachable in practice.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** Each segment encoded, the separators kept — S3 does not double-encode the path. */
function canonicalPath(path: string): string {
  return path.split('/').map(uriEncode).join('/')
}

/** `20260915T101112Z` and `20260915`, the only two date shapes SigV4 uses. */
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac('AWS4' + secret, dateStamp), region), service), 'aws4_request')
}

interface SignedRequest {
  url: string
  headers: Record<string, string>
}

/**
 * Sign one request. Returns the URL and the complete header set to send.
 *
 * Only `host`, `x-amz-date`, `x-amz-content-sha256` and any other `x-amz-*` header are signed.
 * That is deliberately the minimum: every signed header is one more thing a proxy can rewrite
 * on the way out and turn into `SignatureDoesNotMatch`, and none of the unsigned ones
 * (`content-type`, `content-length`) can change what the request DOES.
 */
export function signS3Request(
  cfg: S3Config,
  method: string,
  key: string,
  query: Record<string, string>,
  payload: Buffer | undefined,
  extraHeaders: Record<string, string> = {},
  now = new Date(),
): SignedRequest {
  const endpoint = cfg.endpoint.replace(/\/+$/, '')
  const base = new URL(endpoint)
  const pathStyle = cfg.forcePathStyle !== false

  const host = pathStyle ? base.host : `${cfg.bucket}.${base.host}`
  const objectPath = key ? `/${key.replace(/^\/+/, '')}` : '/'
  const path = pathStyle ? `/${cfg.bucket}${objectPath}` : objectPath

  const { amzDate, dateStamp } = amzDates(now)
  const payloadHash = payload ? sha256hex(payload) : EMPTY_SHA256

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v !== undefined && v !== '') headers[k.toLowerCase()] = String(v)
  }

  // Only the headers above participate; `content-type` is sent but not signed (see the note
  // on `signS3Request`).
  const signed = Object.keys(headers)
    .filter(h => h === 'host' || h.startsWith('x-amz-'))
    .sort()
  const canonicalHeaders = signed.map(h => `${h}:${headers[h].trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = signed.join(';')

  const canonicalQuery = Object.keys(query).sort()
    .map(k => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&')

  const canonicalRequest = [
    method,
    canonicalPath(path),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n')

  const signature = createHmac('sha256', signingKey(cfg.secretAccessKey, dateStamp, cfg.region, 's3'))
    .update(stringToSign).digest('hex')

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const url = `${base.protocol}//${host}${canonicalPath(path)}${canonicalQuery ? `?${canonicalQuery}` : ''}`
  return { url, headers }
}

/** An S3 error, with the service's own explanation and never the request that produced it. */
export class S3Error extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'S3Error'
  }
}

async function s3Fetch(
  cfg: S3Config,
  method: string,
  key: string,
  query: Record<string, string>,
  payload?: Buffer,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const { url, headers } = signS3Request(cfg, method, key, query, payload, extraHeaders)
  // ⚠ `host` is SIGNED but must not be SENT: it is a forbidden header for `fetch`, which either
  // drops it or rejects the request depending on the runtime. The URL is built from the same
  // host the signature covers, so the server reconstructs an identical canonical request.
  const { host: _host, ...wire } = headers
  let res: Response
  try {
    // FR-20.53: 10 minutes covers a large archive PUT; a host that never answers still fails.
    res = await fetchWithTimeout(url, { method, headers: wire, body: payload as any }, { timeoutMs: 600_000 })
  } catch (e: any) {
    throw new S3Error(0, 'network', `s3: could not reach ${new URL(url).host}: ${e?.message}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // S3 error documents are `<Error><Code>…</Code><Message>…</Message></Error>` and are the
    // only actionable part of a failure. Truncated, because a proxy can answer with an HTML
    // page instead and a log line is not a place for one.
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] || String(res.status)
    const msg = /<Message>([^<]+)<\/Message>/.exec(body)?.[1] || body.slice(0, 200)
    throw new S3Error(res.status, code, `s3: ${method} → ${res.status} ${code}: ${msg}`)
  }
  return res
}

/**
 * Upload one object, optionally under an Object Lock retention.
 *
 * ⚠ The lock headers are sent only when a mode is configured. A bucket without Object Lock
 * enabled answers `400 InvalidRequest` to them, so "send them always and let the bucket
 * decide" would break every deployment that has not turned the feature on.
 */
export async function putObject(
  cfg: S3Config,
  key: string,
  body: Buffer,
  opts: { contentType?: string; lock?: S3ObjectLock; metadata?: Record<string, string> } = {},
): Promise<{ key: string; etag?: string; retainUntil?: string }> {
  const headers: Record<string, string> = {
    'content-type': opts.contentType || 'application/octet-stream',
  }

  let retainUntil: string | undefined
  if (opts.lock?.mode) {
    const until = new Date()
    until.setFullYear(until.getFullYear() + Math.max(1, Math.floor(opts.lock.years || 10)))
    retainUntil = until.toISOString().replace(/\.\d{3}Z$/, 'Z')
    headers['x-amz-object-lock-mode'] = opts.lock.mode
    headers['x-amz-object-lock-retain-until-date'] = retainUntil
  }

  // ⚠ Metadata keys are sanitised rather than trusted: they become HTTP header names, they are
  // SIGNED, and a stray newline in one would let a value rewrite the canonical request.
  for (const [k, v] of Object.entries(opts.metadata || {})) {
    const name = `x-amz-meta-${k.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
    headers[name] = String(v).replace(/[\r\n]+/g, ' ').slice(0, 512)
  }

  const res = await s3Fetch(cfg, 'PUT', key, {}, body, headers)
  return { key, etag: res.headers.get('etag') || undefined, retainUntil }
}

export async function getObject(cfg: S3Config, key: string): Promise<Buffer> {
  const res = await s3Fetch(cfg, 'GET', key, {})
  return Buffer.from(await res.arrayBuffer())
}

export async function deleteObject(cfg: S3Config, key: string): Promise<void> {
  await s3Fetch(cfg, 'DELETE', key, {})
}

/**
 * List one prefix, following continuation tokens.
 *
 * Parsed with regexes rather than an XML library, for the same reason the client is hand-rolled:
 * the response shape is four fields and adding a parser dependency to read them is a worse
 * trade. ⚠ Keys are XML-unescaped — a `&amp;` left in place would produce a delete request for
 * an object that does not exist, and a retention pass that silently keeps everything.
 */
export async function listObjects(cfg: S3Config, prefix: string, limit = 1000): Promise<S3ListedObject[]> {
  const out: S3ListedObject[] = []
  let token: string | undefined

  do {
    const query: Record<string, string> = {
      'list-type': '2',
      prefix,
      'max-keys': String(Math.min(limit, 1000)),
    }
    if (token) query['continuation-token'] = token

    const res = await s3Fetch(cfg, 'GET', '', query)
    const xml = await res.text()

    for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1]
      if (!key) continue
      out.push({
        key: unescapeXml(key),
        size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] || 0),
        lastModified: /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1],
      })
    }

    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]
      : undefined
    if (token) token = unescapeXml(token)
  } while (token && out.length < limit)

  return out
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
