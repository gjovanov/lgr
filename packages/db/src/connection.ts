import mongoose from 'mongoose'
import { config } from 'config'

let isConnected = false

export async function connectDB(): Promise<typeof mongoose> {
  if (isConnected) return mongoose
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
