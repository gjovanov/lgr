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
}
