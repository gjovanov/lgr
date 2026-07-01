import mongoose from 'mongoose'
import { config } from 'config'

let isConnected = false
let warmupHooked = false

/**
 * Comprehensive schema warmup: touch EVERY registered model once so Mongoose compiles its
 * schema + first query plan up front, instead of paying that cost on the first real request
 * for each module. Cheap (one indexed findOne per model, run in parallel) and best-effort.
 *
 * Wired to both the `connected` and `reconnected` events below, so it runs on the initial
 * connect AND again after any mongo rolling-restart / network blip — otherwise the first
 * post-reconnect request to a given module pays the cold-start tax again.
 */
export async function warmupSchemas(): Promise<void> {
  try {
    // Ensure all models are registered (importing the barrel registers them as a side effect),
    // regardless of import ordering at the call site.
    await import('./models/index.js')
    const models = Object.values(mongoose.models)
    const start = Date.now()
    await Promise.all(
      models.map((m) => m.findOne().lean().exec().catch(() => null)),
    )
    console.log(`[db] schema warmup: ${models.length} models in ${Date.now() - start}ms`)
  } catch (e) {
    console.warn('[db] schema warmup failed:', (e as any)?.message)
  }
}

function hookWarmup(): void {
  if (warmupHooked) return
  warmupHooked = true
  // Register BEFORE mongoose.connect so the initial `connected` event also triggers warmup.
  mongoose.connection.on('connected', () => { void warmupSchemas() })
  mongoose.connection.on('reconnected', () => { void warmupSchemas() })
}

export async function connectDB(): Promise<typeof mongoose> {
  if (isConnected) return mongoose
  hookWarmup()
  const conn = await mongoose.connect(config.mongodb.uri)
  isConnected = true
  return conn
}

export async function disconnectDB(): Promise<void> {
  if (!isConnected) return
  await mongoose.disconnect()
  isConnected = false
}

export { mongoose }
