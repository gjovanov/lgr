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

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT) || 4001,
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27018/lgr',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'lgr-dev-secret',
    maxAge: 24 * 60 * 60, // 24 hours
  },
  upload: {
    dir: process.env.UPLOAD_DIR || './uploads',
    maxFileSize: Number(process.env.MAX_FILE_SIZE) || 50_000_000,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },
  ocr: {
    serverUrl: process.env.OCR_SERVER_URL || 'http://localhost:8100',
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
    hour: Number(process.env.BACKUP_HOUR) || 3,
    /**
     * FR-13.8's rule applied to Layer 2: retention is **generations kept**, never an age.
     * Without this the per-org bundles grow without bound on the uploads PV — the one
     * resource §2.4 has under real pressure (5 Gi, crossed in year 7 before backups existed).
     * Counted per org and per kind, so a run of failed nights cannot age out the last good
     * bundle.
     */
    keepPerOrg: Number(process.env.BACKUP_KEEP_PER_ORG) || 14,
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
      minFreeBytes: Number(process.env.BACKUP_GOOGLE_DRIVE_MIN_FREE_BYTES) || 512 * 1024 * 1024,
    },
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
