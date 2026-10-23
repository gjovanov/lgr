import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from 'config'

/**
 * Where the app keeps an org's file: under `config.upload.dir/<orgId>/` (FR-20.24). Returns the
 * absolute path: the form rows held before the writers stored relative paths, which every reader
 * still takes. A fixture file anywhere else (the OS temp directory) is one no real row could point
 * at, and `resolveStored` refuses it.
 */
export function uploadPath(orgId: unknown, name: string): string {
  const dir = join(config.upload.dir, String(orgId), 'docs', 'test')
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

/** Point uploads at a throwaway directory for a suite. Returns the function that undoes it. */
export function useTempUploadDir(): () => void {
  const was = config.upload.dir
  const dir = mkdtempSync(join(tmpdir(), 'lgr-uploads-'))
  config.upload.dir = dir
  return () => {
    config.upload.dir = was
    rmSync(dir, { recursive: true, force: true })
  }
}
