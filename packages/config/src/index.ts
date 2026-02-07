export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT) || 4001,
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/lgr',
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
  exchangeRate: {
    apiKey: process.env.EXCHANGE_RATE_API_KEY || '',
  },
}
