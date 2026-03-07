import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

export interface DesktopSettings {
  general: {
    deviceName: string
    dataDirectory: string
    language: string
  }
  sync: {
    enabled: boolean
    mode: 'lan' | 'wan' | 'both'
    autoSync: boolean
    syncIntervalMinutes: number
    manualPeers: { name: string; address: string; port: number }[]
    conflictResolution: 'auto' | 'manual'
  }
  archive: {
    autoEnabled: boolean
    scheduleTime: string
    retentionDays: number
    directory: string
    includeAttachments: boolean
  }
  updates: {
    autoCheck: boolean
    autoInstall: boolean
    checkInterval: 'on_start' | 'daily' | 'weekly'
    channel: 'stable' | 'beta'
  }
}

const DEFAULT_DATA_DIR = join(homedir(), 'LGR', 'data')
const DEFAULT_ARCHIVE_DIR = join(homedir(), 'LGR', 'archives')

export function getDefaultSettings(): DesktopSettings {
  const hostname = require('os').hostname?.() || 'desktop'
  return {
    general: {
      deviceName: hostname,
      dataDirectory: DEFAULT_DATA_DIR,
      language: 'en',
    },
    sync: {
      enabled: true,
      mode: 'lan',
      autoSync: true,
      syncIntervalMinutes: 5,
      manualPeers: [],
      conflictResolution: 'auto',
    },
    archive: {
      autoEnabled: true,
      scheduleTime: '02:00',
      retentionDays: 30,
      directory: DEFAULT_ARCHIVE_DIR,
      includeAttachments: true,
    },
    updates: {
      autoCheck: true,
      autoInstall: false,
      checkInterval: 'on_start',
      channel: 'stable',
    },
  }
}

let settingsPath: string | null = null

export function initSettingsPath(dbPath: string): void {
  settingsPath = join(dirname(dbPath), 'settings.json')
}

function getSettingsPath(): string {
  if (!settingsPath) {
    settingsPath = join(DEFAULT_DATA_DIR, 'settings.json')
  }
  return settingsPath
}

export function loadSettings(): DesktopSettings {
  const path = getSettingsPath()
  if (!existsSync(path)) {
    return getDefaultSettings()
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    const saved = JSON.parse(raw)
    // Merge with defaults to fill any missing keys from upgrades
    return deepMerge(getDefaultSettings(), saved) as DesktopSettings
  } catch {
    return getDefaultSettings()
  }
}

export function saveSettings(settings: DesktopSettings): void {
  const path = getSettingsPath()
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8')
}

function deepMerge(target: any, source: any): any {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null
    ) {
      result[key] = deepMerge(target[key], source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}
