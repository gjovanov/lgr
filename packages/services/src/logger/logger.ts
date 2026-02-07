import pino from 'pino'

function createLogger() {
  try {
    if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
      return pino({
        level: process.env.LOG_LEVEL || 'info',
        transport: { target: 'pino-pretty', options: { colorize: true } },
      })
    }
  } catch {}
  return pino({ level: process.env.LOG_LEVEL || 'info' })
}

export const logger = createLogger()
