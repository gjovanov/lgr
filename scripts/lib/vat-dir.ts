/**
 * Filed VAT months on disk, as the accountant's install leaves them (FR-25 §1.5):
 * `<dir>/<yyyymm>/<eik>/{DEKLAR,PRODAGBI,POKUPKI,VIES}.txt`. Shared by `compare-vat-files.ts` and
 * `import-vat-files.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { VatFile } from '../../packages/services/src/biz/vat-files/month.js'

export interface VatDirMonth {
  /** The month's folder, `yyyymm`. */
  period: string
  /** The folder under it: an EIK, so it is never printed. */
  company: string
  files: VatFile[]
}

const FILES = /^(DEKLAR|PRODAGBI|POKUPKI|VIES)\.TXT$/i

const subfolders = (dir: string) => readdirSync(dir).filter(name => statSync(join(dir, name)).isDirectory()).sort()

/** Every month under `dir`, oldest first. A month with two companies comes twice: `--org` tells them apart. */
export function readVatDir(dir: string): VatDirMonth[] {
  const months: VatDirMonth[] = []
  for (const period of subfolders(dir).filter(name => /^\d{6}$/.test(name))) {
    for (const company of subfolders(join(dir, period))) {
      const folder = join(dir, period, company)
      const files = readdirSync(folder)
        .filter(name => FILES.test(name))
        .map(name => ({ name, bytes: new Uint8Array(readFileSync(join(folder, name))) }))
      if (files.length) months.push({ period, company, files })
    }
  }
  return months
}
