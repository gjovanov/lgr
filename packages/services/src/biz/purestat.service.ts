import { config } from 'config'
import { logger } from '../logger/logger.js'

export async function trackEvent(name: string, props?: Record<string, any>): Promise<void> {
  if (!config.externalIntegrations?.purestat?.enabled) return
  const url = `${config.externalIntegrations.purestat.trackerUrl}/api/event`
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        url: `https://lgrai.app/api/${name}`,
        domain: 'lgrai.app',
        props,
      }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // Non-critical, don't log noise
  }
}
