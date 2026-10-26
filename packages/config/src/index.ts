import { createHash } from 'node:crypto'

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    limits: {
      maxUsers: 3,
      maxRecordsPerModule: 100,
      modules: ['accounting', 'invoicing', 'warehouse', 'payroll', 'hr', 'crm', 'erp'],
      aiRecognition: false,
      cloudStorage: false,
      advancedExport: false,
      customRoles: false,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 12,
    limits: {
      maxUsers: -1,
      maxRecordsPerModule: -1,
      modules: ['accounting', 'invoicing', 'warehouse', 'payroll', 'hr', 'crm', 'erp'],
      aiRecognition: true,
      cloudStorage: true,
      advancedExport: true,
      customRoles: false,
    },
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: 29,
    limits: {
      maxUsers: -1,
      maxRecordsPerModule: -1,
      modules: ['accounting', 'invoicing', 'warehouse', 'payroll', 'hr', 'crm', 'erp'],
      aiRecognition: true,
      cloudStorage: true,
      advancedExport: true,
      customRoles: true,
    },
  },
} as const

export type PlanId = keyof typeof PLANS

export const COSTING_METHODS = ['wac', 'fifo', 'lifo', 'fefo', 'standard'] as const
export type CostingMethod = (typeof COSTING_METHODS)[number]

export const UOM_CATEGORIES = ['quantity', 'weight', 'volume', 'length', 'area', 'time'] as const
export type UomCategory = (typeof UOM_CATEGORIES)[number]

export const DEFAULT_UOMS: { code: string; name: string; category: UomCategory }[] = [
  { code: 'pcs', name: 'Pieces', category: 'quantity' },
  { code: 'pair', name: 'Pairs', category: 'quantity' },
  { code: 'set', name: 'Sets', category: 'quantity' },
  { code: 'box', name: 'Boxes', category: 'quantity' },
  { code: 'pack', name: 'Packs', category: 'quantity' },
  { code: 'dozen', name: 'Dozen', category: 'quantity' },
  { code: 'g', name: 'Grams', category: 'weight' },
  { code: 'kg', name: 'Kilograms', category: 'weight' },
  { code: 'ton', name: 'Metric Tons', category: 'weight' },
  { code: 'lb', name: 'Pounds', category: 'weight' },
  { code: 'oz', name: 'Ounces', category: 'weight' },
  { code: 'ml', name: 'Milliliters', category: 'volume' },
  { code: 'L', name: 'Liters', category: 'volume' },
  { code: 'm3', name: 'Cubic Meters', category: 'volume' },
  { code: 'gal', name: 'Gallons', category: 'volume' },
  { code: 'mm', name: 'Millimeters', category: 'length' },
  { code: 'cm', name: 'Centimeters', category: 'length' },
  { code: 'm', name: 'Meters', category: 'length' },
  { code: 'km', name: 'Kilometers', category: 'length' },
  { code: 'in', name: 'Inches', category: 'length' },
  { code: 'ft', name: 'Feet', category: 'length' },
  { code: 'm2', name: 'Square Meters', category: 'area' },
  { code: 'ha', name: 'Hectares', category: 'area' },
  { code: 'hr', name: 'Hours', category: 'time' },
  { code: 'day', name: 'Days', category: 'time' },
  { code: 'month', name: 'Months', category: 'time' },
]

/**
 * A numeric setting whose ZERO is a real value.
 *
 * ⚠ `Number(process.env.X) || fallback` cannot express one. `Number('0')` is `0`, which is
 * falsy, so the one value that turns a threshold off is the one value that silently becomes
 * the default — the setting looks applied, behaves as unset, and says nothing either way.
 * `ARCHIVE_HORIZON_YEARS=0` and `BACKUP_HOUR=0` (midnight) were both unreachable this way.
 *
 * ⚠ An empty string is treated as UNSET, not as zero. `Number('')` is `0`, and a bare
 * `SOME_SETTING=` line in a `.env` means "I have not filled this in" — reading it as zero
 * would turn a placeholder into a deliberate-looking instruction.
 *
 * ⚠ Only for settings where zero MEANS something. Most of the numbers below are intervals,
 * sizes and counts where zero is nonsense or actively harmful — `timeSyncIntervalMs: 0`
 * would spin a `setInterval` hot — and those keep `||`, where a stray `0` lands on a safe
 * default instead of a foot-gun.
 */
function numEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/**
 * #157, FR-20.17 — the SHA-256 of every secret value published in this repository's example and
 * compose files, with where it is published. Each is long enough to pass the length check, and
 * anyone can read it, so a deployment that copied a file unchanged would sign every session (and
 * every desktop token) with a public key. Production refuses them all, and names the file.
 *
 * ⚠ Kept in step by `unit/published-secrets.test.ts`, which reads those files and fails when a
 * value there is missing here — so a new example secret cannot slip past. Hashes, not the values:
 * this module must not become one more place the values are published.
 */
export const PUBLISHED_EXAMPLE_SECRETS: Readonly<Record<string, string>> = {
  e577b2e6a16174ca3a06717705bea918914ed1b576110f6d02ddd5d1c2d9d8ca: '.env.example and docker-compose.yml (JWT_SECRET)',
  aef3fe10e2ed3af8c4aa8b28e8c5a32f45c7f08adeae409929e49fb755fd0290: '.env.example (DESKTOP_TOKEN_SECRET)',
  eb277f44b5796b307029488f836857c5c42aaa8af6bf1f61adf7ccc4a0dcd30d: 'deploy/ocr/ocr-secret.example.yaml (CLAUDE_CODE_OAUTH_TOKEN)',
}

/** Where `value` is published as an example, or undefined. */
export function publishedExampleSource(value: string): string | undefined {
  return PUBLISHED_EXAMPLE_SECRETS[createHash('sha256').update(value.trim()).digest('hex')]
}

/**
 * A secret that MUST NOT fall back to a committed default in production.
 *
 * ⚠ `process.env.JWT_SECRET || 'lgr-dev-secret'` is not a default, it is a backdoor with a
 * convenient spelling. Every JWT in this system — org, role and the full permission list —
 * is signed with it, and the fallback value is published in this repository. A cluster that
 * booted with `JWT_SECRET` unset, misspelled, or resolved to an empty string from a sealed
 * secret would come up perfectly healthy, log nothing unusual, and accept an `admin` token
 * for any org that anyone who has read this file can mint. Nothing in the app surfaced the
 * difference, because there is no observable difference until it is being exploited.
 *
 * So: the dev fallback survives for `bun run dev` and the test suite, and in production a
 * missing or too-short value is a FATAL boot error. A pod that crash-loops is a page at
 * 03:00; a pod serving forgeable tokens is a breach nobody is looking for.
 *
 * ⚠ The length floor matters as much as the presence check. A short secret is brute-forceable
 * offline from a single captured token — the attacker needs no further access to the cluster
 * to do it. 32 chars is the floor for HS256.
 * Generate one with: `openssl rand -base64 48`
 */
function requiredSecret(name: string, raw: string | undefined, devFallback: string, minLength = 32): string {
  const value = (raw ?? '').trim()
  if (process.env.NODE_ENV === 'production') {
    if (!value) {
      throw new Error(
        `${name} is not set. Refusing to start in production with a default signing key — ` +
          `every JWT would be forgeable by anyone with the source. Generate one with \`openssl rand -base64 48\`.`,
      )
    }
    if (value === devFallback) {
      throw new Error(`${name} is set to the committed development default. Refusing to start in production.`)
    }
    // #157: the example values are long enough to pass the length check, and public.
    const published = publishedExampleSource(value)
    if (published) {
      throw new Error(
        `${name} is the example value published in ${published}. Refusing to start in production — ` +
          'anyone who has read the repository could sign tokens with it. Generate one with `openssl rand -base64 48`.',
      )
    }
    if (value.length < minLength) {
      throw new Error(
        `${name} is ${value.length} characters; ${minLength} is the minimum in production ` +
          `(a short key is brute-forceable offline from one captured token).`,
      )
    }
    return value
  }
  return value || devFallback
}

/**
 * FR-20.1 — which kind of server this is. `global` is today's cloud deployment, and the default;
 * `master` is an on-prem server that is the home of its orgs. A local (LGR Desktop on a master) is
 * not a server role. Read once, here: feature code asks `nodeRole()`, never a host name or another
 * environment variable.
 */
export type NodeRole = 'global' | 'master'

/**
 * FR-20.55 — global's licence signing key: base64 PKCS#8 DER of an Ed25519 key, sealed in
 * lgr-secret. Only global signs, so a master never has one.
 *
 * ⚠ Not fatal when missing, unlike the token secrets: nothing becomes forgeable without it, since a
 * master verifies with the keys built into its package (`licence-keys.json`). Global just issues no
 * licences, and says so (`licence-issue.service.ts`). Outside production the issuer uses a key made
 * per process instead.
 */
function readLicenceSigningKey(raw: string | undefined, role: NodeRole): string {
  // (Also global's identity key, FR-20.39: the same rule, a key only global signs with.)
  return role === 'global' ? (raw ?? '').trim() : ''
}

function readNodeRole(raw: string | undefined): NodeRole {
  const role = (raw ?? '').trim() || 'global'
  if (role === 'global' || role === 'master') return role
  // A typo must not quietly become `global`: on a master that would mean behaving as the cloud.
  throw new Error(`LGR_NODE_ROLE must be "global" or "master", got "${role}".`)
}

const JWT_DEV_FALLBACK = 'lgr-dev-secret'
/** ⚠ Distinct from the JWT fallback, so a dev environment cannot accidentally cross the two. */
const DESKTOP_TOKEN_DEV_FALLBACK = 'lgr-dev-desktop-token-secret'
/** ⚠ Distinct from both, for the same reason. */
const NODE_TOKEN_DEV_FALLBACK = 'lgr-dev-node-token-secret'

/**
 * FR-20.16 — the supervisor's per-boot front secret. Unset means no supervisor stands in front of
 * this API (global, a developer's machine, the tests), and the front checks are off.
 */
function readFrontSecret(raw: string | undefined): string | undefined {
  const secret = (raw ?? '').trim()
  if (!secret) return undefined
  // The supervisor makes 43 characters. Anything short was typed by a person, and is guessable.
  if (secret.length < 32) throw new Error('LGR_FRONT_SECRET must be at least 32 characters.')
  return secret
}

export const config = {
  node: {
    role: readNodeRole(process.env.LGR_NODE_ROLE),
    /** The node's identity once it is registered with global (P2). Unset on global itself. */
    id: (process.env.LGR_NODE_ID || '').trim() || undefined,
    /**
     * FR-20.2 (plan step P2-1) — signs the node ACCESS TOKENS that `/api/node/v1/*` accepts.
     *
     * ⚠ Its own secret, for the desktops' reason: a node token is never a user or a desktop token,
     * by construction. Only global issues them, so only global needs it: required in production on
     * global on the S-02 terms, and empty on a master, where every node route is 404 (the
     * supervisor makes a master's other keys and never needs this one).
     */
    tokenSecret: readNodeRole(process.env.LGR_NODE_ROLE) === 'global'
      ? requiredSecret('NODE_TOKEN_SECRET', process.env.NODE_TOKEN_SECRET, NODE_TOKEN_DEV_FALLBACK)
      : '',
    /** 15 minutes: short, because every node request re-reads the node's row. */
    tokenTtlSec: 15 * 60,
    /**
     * How often global reaps ephemeral nodes that stopped reporting. **0 disables it** (.env.test).
     */
    reaperIntervalMs: process.env.NODE_REAPER_INTERVAL_MS !== undefined
      ? Number(process.env.NODE_REAPER_INTERVAL_MS)
      : 15 * 60 * 1000,
    /**
     * ⚠ 24 h, not the desktops' 15 minutes: a field cell cuts a master's WAN on purpose, and a master
     * reaped in the middle of the cut fails the cell for the wrong reason (FR-20.113).
     */
    ephemeralSilenceMs: 24 * 60 * 60 * 1000,
    /**
     * FR-20.58: the oldest master build global talks to. Below it the uplink answers
     * `master_outdated`: replication and the tunnel stop, the interactive socket stays for updates.
     */
    minMasterVersion: (process.env.NODE_MIN_MASTER_VERSION || '').trim() || '0.1.0',
    /**
     * FR-20.40 (plan step P2-4c) — where a master's API puts the PUBLIC half of its seal key
     * (`state/seal-pub.json`, set by the supervisor), which the supervisor then signs into its token
     * assertions. Unset off a master.
     */
    sealPubFile: (process.env.LGR_NODE_SEAL_PUB_FILE || '').trim(),
  },
  /**
   * FR-20.59 (plan step P2-6) — what global relays for a master, and the caps that keep a stolen or
   * broken master from mailing the world through lgrai.app. Per server.
   */
  relay: {
    mailPerHour: Number(process.env.RELAY_MAIL_PER_HOUR) || 100,
    mailPerDay: Number(process.env.RELAY_MAIL_PER_DAY) || 500,
    /** Decoded attachment bytes per mail. A master's outbox carries them base64 in one document. */
    maxAttachmentBytes: 8 * 1024 * 1024,
    maxHtmlBytes: 1024 * 1024,
    /**
     * P2-6b — documents a master asks global to read, per server and day: each draft and match runs
     * a model on the subscription lgrai.app's own imports use, and its weekly limit is shared.
     */
    documentsPerDay: {
      extract: Number(process.env.RELAY_EXTRACT_PER_DAY) || 500,
      draft: Number(process.env.RELAY_DRAFT_PER_DAY) || 200,
      'match-lines': Number(process.env.RELAY_MATCH_PER_DAY) || 300,
    },
    /** A PDF to read (decoded), and the text of one document to draft. */
    maxDocumentBytes: 15 * 1024 * 1024,
    maxDocumentText: 200_000,
  },
  /** FR-20.43 (plan step P2-5) — how often a master pulls its people's changes. **0 disables it** (.env.test). */
  identityFeed: {
    intervalMs: process.env.IDENTITY_FEED_INTERVAL_MS !== undefined ? Number(process.env.IDENTITY_FEED_INTERVAL_MS) : 30_000,
  },
  /**
   * FR-20.79 (plan step P3-6a) — moving an org's home: global's tick (a frozen move's copy) and a
   * master's worker (its moves on global). 0 disables either.
   */
  move: {
    tickMs: process.env.MOVE_TICK_MS !== undefined ? Number(process.env.MOVE_TICK_MS) : 5_000,
    workerMs: process.env.MOVE_WORKER_MS !== undefined ? Number(process.env.MOVE_WORKER_MS) : 10_000,
  },
  /** FR-20.86 (plan step P2-6) — a master's outbox worker. */
  outbox: {
    /** How often it looks for due work. **0 disables it** (.env.test). */
    intervalMs: process.env.OUTBOX_INTERVAL_MS !== undefined ? Number(process.env.OUTBOX_INTERVAL_MS) : 10_000,
    /**
     * Where the supervisor keeps a fresh node access token (`state/node-token.json`), which the
     * worker presents to global's relay. Unset off a master.
     */
    tokenFile: (process.env.LGR_NODE_TOKEN_FILE || '').trim(),
  },
  /**
   * FR-20.39 (plan step P2-4) — "Sign in with LGR": global's identity key, base64 PKCS#8 DER of an
   * Ed25519 key, sealed in lgr-secret. Global signs the assertions a master redeems; a master verifies
   * them with the keys built into its package (`idp-keys.json`). Not fatal when missing, for the
   * licence key's reason: nothing becomes forgeable, global just signs nobody in to a master.
   */
  idp: {
    signingKey: readLicenceSigningKey(process.env.IDP_SIGNING_KEY, readNodeRole(process.env.LGR_NODE_ROLE)),
    /** The domain an org's own address sits under (`<slug>.lgrai.app`, D-13, plan step P3-4). */
    addressApex: (process.env.ORG_ADDRESS_APEX || '').trim().toLowerCase() || 'lgrai.app',
  },
  /**
   * FR-20.82 (plan step P3-6b) — global's re-point key, base64 PKCS#8 DER of an Ed25519 key, sealed
   * in lgr-secret. When an org moves to its master, global tells each of its desktops where the master
   * answers and which CA to pin, signed with it; a desktop verifies with the keys built into it
   * (`repoint-keys.json`). Not fatal when missing: a desktop is then told only that its org moved.
   */
  repoint: {
    signingKey: readLicenceSigningKey(process.env.REPOINT_SIGNING_KEY, readNodeRole(process.env.LGR_NODE_ROLE)),
  },
  /** FR-20.55 — the licence of an org whose home is a master (plan step P2-3b). */
  licence: {
    signingKey: readLicenceSigningKey(process.env.LICENCE_SIGNING_KEY, readNodeRole(process.env.LGR_NODE_ROLE)),
    /**
     * On a master: where the supervisor keeps its licences, one `<orgId>.jws` per org, as global
     * sent them or an operator imported them. Unset elsewhere.
     */
    dir: (process.env.LGR_LICENCE_DIR || '').trim(),
    /**
     * On a master: when it was made (seconds since the epoch, from `state/node.json`). An org with
     * no licence here is evaluated for 30 days from it.
     */
    nodeCreatedAt: Number(process.env.LGR_NODE_CREATED_AT) || undefined,
  },
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT) || 4001,
  /**
   * FR-20.16 (plan step P1-3) — on a master the supervisor owns every way in, and this API answers
   * it alone (`portal-api/src/front/`). It sets all three; none is set anywhere else.
   */
  front: {
    secret: readFrontSecret(process.env.LGR_FRONT_SECRET),
    /** The names a request may carry in `Host` (IP literals always may), against DNS rebinding. */
    hosts: (process.env.LGR_FRONT_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
    /** The control socket (AF_UNIX): status and stop, never a TCP port (FR-20.16). */
    controlSocket: (process.env.LGR_CONTROL_SOCKET || '').trim() || undefined,
    /**
     * FR-20.29 — the LAN ingress, when the supervisor has opened one: the address a pairing code
     * names (`https://192.168.1.10:4443`), and the fingerprint of the master's own CA
     * (`sha256:<base64url>`) that the desktop pins its first connection to.
     */
    lan: {
      url: (process.env.LGR_LAN_URL || '').trim().replace(/\/+$/, '') || undefined,
      caFingerprint: (process.env.LGR_LAN_CA_FINGERPRINT || '').trim() || undefined,
      /**
       * FR-20.30: the same two, as the supervisor keeps them current (`state/lan.json`). A CA
       * rotation or a DHCP move changes them while the API runs, and this file follows.
       */
      stateFile: (process.env.LGR_LAN_STATE_FILE || '').trim() || undefined,
    },
  },
  stop: {
    /**
     * FR-20.23 — how long a graceful stop waits for an in-flight fiscal operation and for the
     * requests already being served. Under Kubernetes' 30 s grace by default; the supervisor gives
     * its own grace on top of whatever this is.
     */
    waitMs: Number(process.env.LGR_STOP_WAIT_MS) || 25_000,
  },
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27018/lgr',
  },
  jwt: {
    secret: requiredSecret('JWT_SECRET', process.env.JWT_SECRET, JWT_DEV_FALLBACK),
    maxAge: 24 * 60 * 60, // 24 hours
  },
  /**
   * S-08 — the failed-sign-in throttle. It counts FAILURES only, and counts them in Mongo
   * (`login_throttles`) so the limit holds across pods. **`LOGIN_THROTTLE_ENABLED=false` turns it
   * off**, which is how tests keep it out of the way (.env.test): suites fail logins on purpose.
   */
  loginThrottle: {
    enabled: process.env.LOGIN_THROTTLE_ENABLED !== 'false',
    windowMs: Number(process.env.LOGIN_THROTTLE_WINDOW_MS) || 15 * 60 * 1000,
    lockMs: Number(process.env.LOGIN_THROTTLE_LOCK_MS) || 15 * 60 * 1000,
    /** Failures for one account from one address before that pair is locked out. */
    perAccountAndIp: Number(process.env.LOGIN_THROTTLE_PER_ACCOUNT_IP) || 5,
    /** Failures for one account from anywhere: a guess spread over many addresses. */
    perAccount: Number(process.env.LOGIN_THROTTLE_PER_ACCOUNT) || 30,
    /** Failures from one address across every account: a password spray. */
    perIp: Number(process.env.LOGIN_THROTTLE_PER_IP) || 100,
  },
  upload: {
    dir: process.env.UPLOAD_DIR || './uploads',
    maxFileSize: Number(process.env.MAX_FILE_SIZE) || 50_000_000,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },
  /**
   * FR-20.61 (plan steps P3-1b, P3-2b): a master's capture of its own writes, the change-stream
   * journal the mirror is sent from. It follows the link: on while the supervisor's registration says
   * Full, off otherwise, since a master linked at Control sends no business data anywhere (FR-20.54).
   * `LGR_REPLICATION=on|off` overrides that either way. Ignored off a master.
   */
  replication: {
    /** `true`/`false` when `LGR_REPLICATION` says so; unset, the registration's link level decides. */
    capture: ((v: string) => (v === 'on' ? true : v === 'off' ? false : undefined))((process.env.LGR_REPLICATION || '').trim().toLowerCase()) as boolean | undefined,
    /** The supervisor's `state/registration.json`, whose `linkLevel` says Full or Control. */
    registrationFile: (process.env.LGR_REGISTRATION_FILE || '').trim(),
  },
  ocr: {
    serverUrl: process.env.OCR_SERVER_URL || 'http://localhost:8100',
    /**
     * Whether a sidecar was configured. A master's package carries none, so with none set it reads
     * documents through lgrai.app (FR-20.59, P2-6b); an operator may still point it at their own.
     */
    configured: !!(process.env.OCR_SERVER_URL || '').trim(),
  },
  integrations: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
    },
    dropbox: {
      appKey: process.env.DROPBOX_APP_KEY || '',
      appSecret: process.env.DROPBOX_APP_SECRET || '',
    },
    onedrive: {
      clientId: process.env.ONEDRIVE_CLIENT_ID || '',
      clientSecret: process.env.ONEDRIVE_CLIENT_SECRET || '',
    },
  },
  companyLookup: {
    verifyVatToken: process.env.VERIFYVAT_TOKEN || '',
  },
  exchangeRate: {
    apiKey: process.env.EXCHANGE_RATE_API_KEY || '',
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    priceIds: {
      pro: process.env.STRIPE_PRO_PRICE || '',
      enterprise: process.env.STRIPE_ENTERPRISE_PRICE || '',
    },
  },
  email: {
    sendgridApiKey: process.env.SENDGRID_API_KEY || '',
    fromEmail: process.env.FROM_EMAIL || 'noreply@lgr.app',
    appUrl: process.env.APP_URL || 'http://localhost:4001',
    activationTokenTtlMinutes: Number(process.env.ACTIVATION_TOKEN_TTL_MINUTES) || 5,
  },
  oauth: {
    baseUrl: process.env.OAUTH_BASE_URL || 'http://localhost:4001',
    frontendUrl: process.env.OAUTH_FRONTEND_URL || 'http://localhost:4001',
    google: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    },
    facebook: {
      clientId: process.env.FACEBOOK_CLIENT_ID || '',
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET || '',
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    },
    linkedin: {
      clientId: process.env.LINKEDIN_CLIENT_ID || '',
      clientSecret: process.env.LINKEDIN_CLIENT_SECRET || '',
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID || '',
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
    },
  },
  supto: {
    mode: (process.env.SUPTO_MODE || 'development') as 'production' | 'development',
    timeSyncIntervalMs: Number(process.env.SUPTO_TIME_SYNC_INTERVAL_MS) || 6 * 60 * 60 * 1000, // 6 hours
  },
  migrations: {
    /**
     * FR-20.19 (P0b-7) — run pending versioned migrations (`packages/migrations`) before the
     * server listens. Off by default, which is the kill switch: `bun run migrate` runs them by
     * hand. Masters turn it on; global does after one release of the CLI in `deploy-prod.sh`.
     */
    auto: process.env.MIGRATIONS_AUTO === 'true',
  },
  pdf: {
    /**
     * FR-20.25 (P0a-2) — `chrome` renders in-process: the HTML goes to Chrome with `setContent`,
     * Chrome is driven over a pipe, and nothing listens on a socket. `md-to-pdf` is the previous
     * renderer, kept for ONE release as the kill switch should a document print differently.
     */
    renderer: (process.env.PDF_RENDERER === 'md-to-pdf' ? 'md-to-pdf' : 'chrome') as 'chrome' | 'md-to-pdf',
    /** The Chrome to drive. Unset → Puppeteer's own (its cache), as before. */
    chromePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    /**
     * How long one render attempt may take before it is abandoned and its Chrome killed.
     * `markdownToPdf` then retries with a fresh browser. A healthy render takes 2–4 s, and
     * `page.pdf` itself already gives up after 30 s.
     */
    renderTimeoutMs: Number(process.env.PDF_RENDER_TIMEOUT_MS) || 60_000,
  },
  digest: {
    /**
     * FR-11.5 (#21) — how often the scheduler asks "is it any org's digest hour yet?".
     * **0 disables the scheduler entirely**, which is how tests keep it inert (.env.test).
     * The check is cheap: one indexed query for enabled orgs.
     */
    checkIntervalMs: process.env.DIGEST_CHECK_INTERVAL_MS !== undefined
      ? Number(process.env.DIGEST_CHECK_INTERVAL_MS)
      : 10 * 60 * 1000, // 10 minutes
  },
  desktop: {
    /**
     * FR-14.20 (#57) — signs the desktop ACCESS TOKENS that `/api/desktop/v1/*` accepts.
     *
     * ⚠ A separate secret from `JWT_SECRET`, deliberately, and that separation is the security
     * property: a desktop token is then never valid as a user token, and a user token never as a
     * desktop token, **by construction** rather than by every route remembering to check an
     * audience claim. The audience claim is checked too — but if it were the only thing standing
     * between a bridge credential and a payroll endpoint, one forgotten check would be enough.
     *
     * Required in production on the same terms as `JWT_SECRET` (S-02): a default here would be a
     * published key that mints tokens for any desktop of any org.
     */
    tokenSecret: requiredSecret(
      'DESKTOP_TOKEN_SECRET',
      process.env.DESKTOP_TOKEN_SECRET,
      DESKTOP_TOKEN_DEV_FALLBACK,
    ),
    /** How long an access token is good for (FR-14.20). Short, because revocation re-reads the row. */
    tokenTtlSec: 15 * 60,
    /**
     * FR-14.19 — how often the reaper looks for ephemeral desktops that stopped reporting.
     * **0 disables it entirely**, which is how tests keep it inert (.env.test), matching `digest`.
     */
    reaperIntervalMs: process.env.DESKTOP_REAPER_INTERVAL_MS !== undefined
      ? Number(process.env.DESKTOP_REAPER_INTERVAL_MS)
      : 5 * 60 * 1000, // 5 minutes
    /**
     * FR-14.29 — the oldest desktop build the hub will mint a token for.
     *
     * ⚠ Below it, `POST /api/desktop/v1/token` answers **426 `desktop_outdated`**, so the native
     * fiscal bridge cannot connect until the machine updates — while **`lgr-web` keeps working**,
     * because that is just the cloud app in a window and nothing about it depends on the shell's
     * version.
     *
     * ⚠ Empty means NO minimum, and that is the default. A default of "the current release"
     * would brick every desktop in the fleet the moment someone tagged a new one; raising this
     * is a deliberate operator act, usually the same day a protocol change ships.
     *
     * ⚠ Enforcement reads the desktop's STORED `appVersion` (reported at enroll and by
     * `PUT /self`), and a desktop that has never reported one does NOT satisfy a configured
     * minimum — see `meetsMinimum`. That is the fail-closed direction, and it is recoverable:
     * the machine updates and re-enrolls.
     */
    minVersion: (process.env.DESKTOP_MIN_VERSION || '').trim(),
    /**
     * FR-14.28 — where the update manifest is fetched from, per channel.
     *
     * ⚠ The hub PROXIES it rather than letting each till reach the internet: a shop whose
     * firewall allows only the hub still updates, and an operator can refuse a version to the
     * fleet without unpublishing the release. Empty means no update source is configured, and
     * the endpoint then says so rather than inventing a manifest.
     */
    releaseFeedUrl: (process.env.DESKTOP_RELEASE_FEED_URL || '').trim(),

    /**
     * FR-14.28 / #93 — the release this hub offers, when no external feed is configured.
     *
     * ⚠ **This exists because the feed never did.** `releaseFeedUrl` was the only source, it has
     * never been set, and nothing publishes a `<channel>.json` anywhere — so
     * `/api/desktop/v1/latest-release` always answered `release: null` and every till was told it
     * was up to date, including one running a build seven months old. Quietly, in the direction
     * nobody notices.
     *
     * Hosting a feed needs somewhere to host it; these three variables need a configmap line,
     * which is how everything else in this deployment is already configured. `releaseFeedUrl`
     * still WINS when set, so an external feed remains the path for a fleet that outgrows this.
     *
     * ⚠ **Empty means "offer nothing", which is the safe default and today's behaviour.** Never
     * set a version that is not actually downloadable: a till told to update to a build it cannot
     * get is worse off than one told nothing.
     */
    releaseVersion: (process.env.DESKTOP_RELEASE_VERSION || '').trim(),
    /**
     * Where a human downloads that release. Shown to the operator; nothing fetches it.
     * Empty: this server's own download page (`/api/desktop/download/<version>`).
     */
    releaseUrl: (process.env.DESKTOP_RELEASE_URL || '').trim(),
    /**
     * The repository whose `desktop-v<version>` releases the download route serves. Public: the
     * route reads it anonymously. The installers are still streamed through this server
     * (`/api/desktop/download/*`), because corporate allow-lists trust this domain rather than
     * github.com, the way roomler serves its own.
     */
    releaseRepo: (process.env.DESKTOP_RELEASE_REPO || 'gjovanov/lgr').trim(),
    /**
     * A read-only token for `releaseRepo` (fine-grained: Contents read). A secret, and OPTIONAL: the
     * repository is public, so without it the route asks GitHub anonymously (60 API calls an hour
     * per address, which the ten-minute release cache keeps it far below). Set, it raises that limit,
     * and it is what a private repository would need.
     */
    releaseGithubToken: (process.env.DESKTOP_RELEASE_GITHUB_TOKEN || '').trim(),
    /**
     * FR-20.56 (plan step P2-7) — on a master, where the supervisor keeps the desktop release it
     * fetched from lgrai.app; the tills' updates and downloads are served from it. Set by the
     * supervisor. Empty on global.
     */
    releasesDir: (process.env.LGR_DESKTOP_RELEASES_DIR || '').trim(),
    /** One line of release notes, shown with the offer. */
    releaseNotes: (process.env.DESKTOP_RELEASE_NOTES || '').trim(),
  },
  /**
   * FR-20.20 (plan step P1-8) — the server release lgrai.app offers its masters, read from GitHub
   * the way the desktop's are (`github-release.ts`). The master verifies everything it downloads
   * against keys built into its own package; this only says which version to fetch.
   */
  serverRelease: {
    /** The version masters are offered (N.N.N). Empty: nothing is offered. A human promotes it. */
    version: (process.env.SERVER_RELEASE_VERSION || '').trim(),
    repo: (process.env.SERVER_RELEASE_REPO || process.env.DESKTOP_RELEASE_REPO || 'gjovanov/lgr').trim(),
    /** Optional and read-only, shared with the desktop's: GitHub's higher API limit. */
    githubToken: (process.env.DESKTOP_RELEASE_GITHUB_TOKEN || '').trim(),
  },
  backup: {
    /**
     * FR-13.6 (#24) — where the Layer-1 backup jobs publish their status.
     *
     * The jobs run on **mars**, outside the cluster; the app runs inside it. The hand-off is
     * a small JSON file that `verify-backups.sh` pushes onto the uploads PV, which both sides
     * can already reach. Nothing under `UPLOAD_DIR` is served statically — every path there
     * goes through an authenticated controller — so this does not expose backup state to the
     * web (FR-13.24).
     */
    statusDir: process.env.BACKUP_STATUS_DIR || '',
    /**
     * Older than this and the report is treated as a FAILURE, not as missing data. A backup
     * report that stopped arriving is exactly the roomler failure mode FR-13 exists to catch.
     */
    statusMaxAgeHours: Number(process.env.BACKUP_STATUS_MAX_AGE_HOURS) || 25,
    /**
     * FR-13.10 (#24) — how often the scheduler asks "is it any org's backup hour yet?".
     * **0 disables it entirely**, which is how tests stay inert (.env.test), so no test ever
     * writes a bundle or sends mail. Same contract as `digest.checkIntervalMs`.
     */
    checkIntervalMs: process.env.BACKUP_CHECK_INTERVAL_MS !== undefined
      ? Number(process.env.BACKUP_CHECK_INTERVAL_MS)
      : 10 * 60 * 1000,
    /**
     * Org-local hour the per-org bundle runs at. FR-13.7 puts it at 03:45, after the 02:30
     * full and the 03:15 uploads rotation, and away from the digest's own read.
     */
    // ⚠ `0` is MIDNIGHT — an ordinary hour to schedule a backup at, and the one hour `||`
    // could not express: it read as unset and quietly moved the run to 03:00. An operator
    // setting `BACKUP_HOUR=0` got a backup three hours later than they asked for, with
    // nothing to indicate the value had been discarded.
    hour: numEnv(process.env.BACKUP_HOUR, 3),
    /**
     * FR-13.8's rule applied to Layer 2: retention is **generations kept**, never an age.
     * Without this the per-org bundles grow without bound on the uploads PV — the one
     * resource §2.4 has under real pressure (5 Gi, crossed in year 7 before backups existed).
     * Counted per org and per kind, so a run of failed nights cannot age out the last good
     * bundle.
     */
    keepPerOrg: Number(process.env.BACKUP_KEEP_PER_ORG) || 14,
    /**
     * FR-20.21 (plan step P1-9) — a local copy of every night's bundle: a second disk, a USB drive
     * or a NAS path on the master's own network. Empty = no local copy. Its generations are pruned
     * to `localKeep` (default `keepPerOrg`).
     *
     * ⚠ A path that is not there (the USB drive unplugged, the NAS down) is a recorded `failed`
     * destination, never a failed run: the bundle is built, verified and kept on the master.
     */
    localPath: process.env.BACKUP_LOCAL_PATH || '',
    localKeep: Number(process.env.BACKUP_LOCAL_KEEP) || 0,
    /**
     * FR-13.23 (#24) — whether the daily mail may carry the BUNDLE ITSELF.
     *
     * ⚠ Default **false**, and that is a security decision, not a preference. A bundle
     * contains every tenant-scoped collection, which includes `User` documents — and
     * `user.model.ts` does not mark `password` as `select: false`, so the bcrypt hashes ride
     * along, as do every contact's tax ID and address. SendGrid is outside the cluster, so
     * attaching it plaintext is bytes leaving the cluster unencrypted, which FR-13.23
     * forbids. The MANIFEST is always sent regardless: a few KB of counts and checksums
     * proves what should exist without shipping any of it.
     *
     * Turn this on only for a deployment that accepts that trade-off explicitly. Once the
     * Phase-3 encryption wrapper lands (FR-13.56), the attachment goes out encrypted and this
     * flag stops being the only thing standing between a mailbox and a password table.
     */
    emailAttachBundle: process.env.BACKUP_EMAIL_ATTACH_BUNDLE === 'true',
    /**
     * How many times one org-day may be attempted before the scheduler stops retrying it.
     *
     * A failed run must NOT mark the day done — that turns one transient failure into a
     * silently skipped night (the roomler failure wearing a different hat). But an unbounded
     * retry on a deterministic failure would rebuild the same broken bundle every tick, so
     * the count is capped and the last failure stays on the row for the digest to report.
     */
    maxAttemptsPerDay: Number(process.env.BACKUP_MAX_ATTEMPTS_PER_DAY) || 3,
    /**
     * FR-13.26 (#24) — who may reach the §5.7 restore surface. **Empty by default.**
     *
     * ⚠ Unset means every §5.7 route answers 403 to EVERYONE, including an org `admin`. That
     * is the design, not a rough edge. `ROLES` (`config/constants.ts:1`) tops out at `admin`,
     * which is ORG-scoped: gating restore on it would hand the regal-pz shop owner a button
     * that deletes issued fiscal documents and rolls invoice numbering backwards into numbers
     * already in customers' hands. LGR has no platform operator identity, so this list
     * invents the smallest possible one.
     *
     * ⚠ Deliberately a config allow-list rather than a new permission. A permission would
     * need a model change, a `PermissionSet` backfill and a **re-login** before it took
     * effect, because a JWT carries the permission list it was issued with — the ordering
     * FR-06 P2 already paid for (`scripts/backfill-reports-permissions.ts` plus "tell people
     * to re-login", whose symptom when skipped was a silently missing tile). An allow-list is
     * correct from the first request after deploy, for callers who never signed out. FR-13.26
     * P2 (a real `platform.admin` permission) is explicitly out of scope.
     *
     * Entries are matched case-insensitively against BOTH the caller's user id and their
     * email, so an operator can be listed either way:
     *
     *     BACKUP_SYS_ADMINS=ops@example.com,68b1f0c4e8a1b2c3d4e5f601
     */
    sysAdmins: (process.env.BACKUP_SYS_ADMINS || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
    /**
     * FR-13.30 (#24) — the ceiling for an UPLOADED bundle, which is not `upload.maxFileSize`.
     *
     * ⚠ `config.upload.maxFileSize` is 50 MB, and a `full` bundle exceeds it TODAY (~80 MB of
     * `docs/` at current volumes) while a `data` bundle crosses it around year 8. Sharing the
     * documents cap would make the restore path fail on exactly the artifacts it exists to
     * restore. The browser round trip is also never mandatory: `restore/inspect` accepts a
     * `runId` or a server-side `path`, so the org's own most recent bundle is restored without
     * moving a byte through a browser.
     */
    restoreMaxUploadBytes: Number(process.env.BACKUP_RESTORE_MAX_UPLOAD_BYTES) || 1024 * 1024 * 1024,
    /**
     * FR-13.23/13.56 (#24) — the public half of the key that seals a bundle before it leaves
     * the cluster.
     *
     * ⚠ Asymmetric on purpose, and this is the requirement rather than a preference. A
     * symmetric key held in `lgr-secret` would mean anything that can read the secret can
     * also read every backup — and the bundle contains the `orgs` collection, which holds the
     * Drive credential that can DELETE the off-site copy. So the cluster gets a WRITE-ONLY
     * key: it can seal a bundle and cannot open one. The private half lives off-cluster, in
     * the password manager, exactly like Layer 1's `age` key.
     *
     * Generate the pair with `bun scripts/backup-crypto.ts keygen`. Empty disables sealing —
     * and disables the Drive upload with it, because an unencrypted bundle must not leave.
     */
    encryptionPublicKey: process.env.BACKUP_ENCRYPTION_PUBLIC_KEY || '',
    /**
     * FR-13.48–13.59 (#24) — Google Drive as the off-site destination for per-org bundles.
     *
     * ⚠ The refresh token lives HERE (i.e. in `lgr-secret`), not on the Org document, and
     * that is FR-13.56's whole point: `orgs` is inside every bundle, so a token stored there
     * would ship the credential that can delete the off-site copy inside the thing it
     * protects. Holding it in the secret breaks that circularity outright.
     *
     * ⚠ There is no API-key alternative. A Google API key authenticates anonymous access to
     * PUBLIC data and cannot write to a private Drive at all; a service account has no
     * storage quota and cannot own files, so writing to its own My Drive fails
     * `403 storageQuotaExceeded` even when that Drive is empty (FR-13.48). OAuth with a
     * long-lived refresh token is the only shape Google permits.
     */
    googleDrive: {
      /**
       * FR-20.97 — the operator attests that this Drive keeps its data in the EU (a Google Workspace
       * data region): a personal Drive's region cannot be chosen. A master sends nothing to a Drive
       * without it.
       */
      euAttested: process.env.BACKUP_GOOGLE_DRIVE_EU === 'true',
      refreshToken: process.env.BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN || '',
      /** Defaults to the existing Drive integration client — one OAuth app, not two. */
      clientId: process.env.BACKUP_GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.BACKUP_GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
      /**
       * The ONE root folder this application owns in the connected Drive. Everything it
       * writes lives under `LGR/<org slug>/<kind>/` and nothing is ever created beside it —
       * see `driveRootFolder()` in `backup-destinations.service.ts`, which refuses a value
       * that would resolve to My Drive root.
       *
       * One dedicated tree, never shared with anything else (FR-13.56): the credential that
       * writes here can also delete, so what it can reach has to be exactly what it owns.
       * `drive.file` already limits the token to files this app created; the single root
       * makes that boundary visible to the human looking at the Drive.
       */
      folderName: process.env.BACKUP_GOOGLE_DRIVE_FOLDER || 'LGR',
      /**
       * Generations kept ON DRIVE per org and per kind. Counted, never aged: a run of failed
       * nights must not be able to delete the last good copy (FR-13.8/13.59).
       */
      keep: Number(process.env.BACKUP_GOOGLE_DRIVE_KEEP) || 14,
      /**
       * Refuse to start an upload that cannot finish. A free Google account is 15 GB shared
       * across Drive, Gmail and Photos; the job reads `about.get?fields=storageQuota` and
       * declines up front rather than failing mid-transfer (FR-13.57).
       */
      // ⚠ `0` is meaningful: it disables the pre-flight for a destination whose quota this
      // process cannot read (a shared drive, a service account). Under `||` that read as
      // "unset" and silently reinstated the 512 MB demand, so the job kept refusing to start
      // on a destination with plenty of room and no way to say so.
      minFreeBytes: numEnv(process.env.BACKUP_GOOGLE_DRIVE_MIN_FREE_BYTES, 512 * 1024 * 1024),
    },
    /**
     * FR-13.58 (#24) — object storage as the tier-3 destination Drive cannot be.
     *
     * ⚠ This is not a second copy for its own sake. Drive has **no object-lock and no
     * write-once retention**: the same credential that writes can delete, so a leaked token
     * or a buggy rotation destroys the off-site copy — and the copy that must survive that is
     * the ten-year one (ЗСч чл. 12; payroll fifty), not last night's bundle. S3 with
     * versioning plus Object Lock cannot be deleted by the key that wrote it. That asymmetry
     * is the entire reason this block exists, and it is why `scope` defaults to `archive`.
     *
     * Any S3-compatible endpoint: Backblaze B2, Cloudflare R2, Hetzner, MinIO, AWS. Signed
     * with SigV4 over `fetch` (`backup/s3-client.ts`) — no SDK, no dependency.
     *
     * ⚠ Like Drive, it refuses to upload anything unsealed: `encryptionPublicKey` gates both.
     */
    s3: {
      /** `https://s3.eu-central-003.backblazeb2.com` — scheme and host, no bucket, no path. */
      endpoint: process.env.BACKUP_S3_ENDPOINT || '',
      /** Part of the SigV4 credential scope. B2/R2/MinIO accept `us-east-1` when unsure. */
      region: process.env.BACKUP_S3_REGION || 'us-east-1',
      /**
       * FR-20.97 — the operator attests the bucket is in Bulgaria or the EU, for an endpoint whose
       * name does not say so (a self-hosted MinIO in the shop's own country). Recognised EU
       * endpoints need no attestation (`s3InEu`).
       */
      euAttested: process.env.BACKUP_S3_EU === 'true',
      bucket: process.env.BACKUP_S3_BUCKET || '',
      accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY || '',
      /** Key prefix inside the bucket, so one bucket may hold more than LGR. */
      prefix: process.env.BACKUP_S3_PREFIX || 'lgr',
      /**
       * What goes here: `archive` (the yearly cold tier only — the default and FR-13.58's
       * recommendation), `all` (also every nightly bundle), or `off`.
       *
       * ⚠ Defaulting to `all` would put ~3.4 GB/year of rotating bundles into a bucket whose
       * objects are RETAINED and cannot be deleted until their lock expires. That is a bill
       * and a surprise, not a backup policy.
       */
      scope: (['off', 'archive', 'all'] as const).includes(process.env.BACKUP_S3_SCOPE as any)
        ? (process.env.BACKUP_S3_SCOPE as 'off' | 'archive' | 'all')
        : 'archive',
      /**
       * Generations kept per prefix. ⚠ `0` means **never delete anything**, and it is the
       * default: an object-locked bucket refuses the delete anyway, and for a ten-year legal
       * retention "keep everything" is the correct policy, not a missing one.
       */
      keep: numEnv(process.env.BACKUP_S3_KEEP, 0),
      /**
       * Path-style (`https://endpoint/bucket/key`) by default, because B2, R2 and MinIO all
       * accept it while virtual-host style needs per-bucket DNS. Set `false` for AWS proper.
       */
      forcePathStyle: process.env.BACKUP_S3_FORCE_PATH_STYLE !== 'false',
      /**
       * `COMPLIANCE` or `GOVERNANCE`, sent as `x-amz-object-lock-mode` on every PUT. Empty
       * uploads without a retention header, which is what a bucket with no Object Lock
       * configured requires — sending one there is a 400, not a no-op.
       *
       * ⚠ `COMPLIANCE` cannot be shortened or removed by ANYONE, including the account root,
       * until it expires. That is the property being bought; it is also irreversible, so the
       * years below are a decision, not a default to accept without reading.
       */
      objectLockMode: ['COMPLIANCE', 'GOVERNANCE'].includes(String(process.env.BACKUP_S3_OBJECT_LOCK_MODE || '').toUpperCase())
        ? String(process.env.BACKUP_S3_OBJECT_LOCK_MODE).toUpperCase()
        : '',
      /** Retention length for the lock above. Ten years is ЗСч чл. 12's floor for the ledger. */
      objectLockYears: numEnv(process.env.BACKUP_S3_OBJECT_LOCK_YEARS, 10),
    },
  },
  /**
   * FR-13.43–13.46 (#24) — the only data this product ever deletes on a schedule.
   *
   * ⚠ Two collections, named in `TOUCHABLE` in `retention.service.ts`, and nothing else will
   * ever be added here without the same scrutiny. `Invoice`, `StockMovement`, `POSTransaction`,
   * `JournalEntry`, `AuditLog`, `Sequence`, `PayrollRun` and `Payslip` MUST NOT be TTL'd or
   * pruned: ЗСч чл. 12 / ДОПК чл. 38 ал. 1 require 10 years, payroll 50. A retention job that
   * can reach a fiscal collection is a compliance breach waiting for an off-by-one.
   *
   * Why `EmailLog` at all: measured at ~52 KB/row and 28 MB/yr at two recipients with no TTL,
   * it is the largest non-fiscal consumer in the database — and the BODY is the whole of it.
   * The row minus its body still answers "was this document emailed, when, and did it work",
   * which is what the FR-10.6 double-click guard and the digest's failed-email section read.
   */
  retention: {
    /**
     * How often the sweep runs. `0` disables it entirely, and `.env.test` sets that so no test
     * can delete anything — the same switch `digest` and `backup` use, for the same reason.
     */
    checkIntervalMs: Number(process.env.RETENTION_CHECK_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    /**
     * Strip `EmailLog.body` after this many days. The row survives; only the rendered HTML
     * goes. 90 days is past any plausible "what exactly did we send them?" dispute window.
     */
    emailBodyDays: Number(process.env.RETENTION_EMAIL_BODY_DAYS) || 90,
    /**
     * Delete the `EmailLog` row itself after this many days.
     *
     * ⚠ Longer than the body window on purpose, and the two are checked in that order: a row
     * old enough to delete is never worth stripping first.
     */
    emailLogDays: Number(process.env.RETENTION_EMAIL_LOG_DAYS) || 365,
    /**
     * Hard ceiling on documents touched per collection per pass, so a first run against years
     * of accumulated rows cannot hold the event loop or the oplog. What it does not finish it
     * finishes next tick — the work is idempotent and the sweep is not racing anything.
     */
    batchSize: Number(process.env.RETENTION_BATCH_SIZE) || 5000,
  },
  /**
   * FR-13.38–13.42 (#24) — cold storage for document BYTES, never for rows.
   *
   * ⚠ The measurement that decided the whole shape: the database is not what grows. regal-pz
   * accumulates 169 MB/yr of BSON — ten years is 1.76 GB, 68 MB compressed. `docs/` grows
   * 0.68 GB/yr against a declared 5 Gi PV and crosses it in YEAR 7, and barely compresses
   * (1.18× gzip, 1.46× zstd-19; PDFs are already deflate containers). So archiving moves
   * files and Mongo rows are deliberately never moved out (FR-13.40).
   *
   * ⚠ Приложение 29 т. 16 requires archived data to stay reachable „през потребителски
   * интерфейс", and т. 19 requires the `nra_auditor` profile to reach it. A tarball in a
   * bucket does not satisfy that. Hence: pack the bytes, keep the `DocFile` row live and
   * listed, and rehydrate on demand (FR-13.41/13.42).
   */
  archive: {
    /**
     * A `locked` fiscal year becomes archivable once it ended this many years ago.
     *
     * ⚠ The unit is a LOCKED FISCAL YEAR, never age alone. Age would archive the documents of
     * a year still being corrected; `locked` is the org saying it is finished with it. The
     * horizon is the additional grace on top of that, so a year locked early is not packed
     * away while an auditor is still likely to open it weekly.
     */
    // ⚠ `0` is meaningful: "any locked year that has ended". See `numEnv` — under `||` this
    // was the one setting that could not be turned off.
    horizonYears: numEnv(process.env.ARCHIVE_HORIZON_YEARS, 2),
    /**
     * How often the archive sweep runs. `0` disables it — `.env.test` sets that, as it does
     * for every other scheduled job.
     */
    checkIntervalMs: Number(process.env.ARCHIVE_CHECK_INTERVAL_MS ?? 24 * 60 * 60 * 1000),
    /**
     * zstd level for an archive unit.
     *
     * ⚠ 19 like the backup bundle, and it buys much less here (1.46× measured on PDFs, which
     * are already deflate containers). It is kept anyway because an archive is written once
     * and read almost never: the cost is a one-off minute, and the saving is permanent.
     */
    compressionLevel: Number(process.env.ARCHIVE_COMPRESSION_LEVEL) || 19,
  },
  externalIntegrations: {
    roomler: {
      url: process.env.ROOMLER_URL || 'http://localhost:3000',
      enabled: process.env.ROOMLER_ENABLED === 'true',
    },
    tickytack: {
      url: process.env.TICKYTACK_URL || 'http://localhost:3100',
      enabled: process.env.TICKYTACK_ENABLED === 'true',
    },
    purestat: {
      url: process.env.PURESTAT_URL || 'http://localhost:3200',
      trackerUrl: process.env.PURESTAT_TRACKER_URL || 'http://localhost:8001',
      siteId: process.env.PURESTAT_SITE_ID || '',
      apiKey: process.env.PURESTAT_API_KEY || '',
      enabled: process.env.PURESTAT_ENABLED === 'true',
    },
  },
}

/** FR-20.1 — the one place role-dependent behaviour is decided from. */
export function nodeRole(): NodeRole {
  return config.node.role
}
