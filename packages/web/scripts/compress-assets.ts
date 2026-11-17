/**
 * FR-30.26: write a Brotli (`.br`) and a gzip (`.gz`) copy beside each built text asset of the web app, for a server
 * with no compressing ingress in front of it (an on-prem master). `portal-api/src/spa-fallback.ts#uiStaticPlugin`
 * serves the copy the browser accepts, for a file whose name carries its content hash.
 *
 * Fonts and images are compressed already and get no copy. Run by `packages/web`'s build after Vite.
 *
 * Usage: bun scripts/compress-assets.ts [dir]   (from packages/web; default: dist/ui)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const TEXT = /\.(js|mjs|css|svg|json|html|txt|map)$/

export function compressDir(dir: string): { files: number; bytes: number; br: number } {
  let files = 0
  let bytes = 0
  let br = 0
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      const sub = compressDir(path)
      files += sub.files
      bytes += sub.bytes
      br += sub.br
      continue
    }
    if (!TEXT.test(name)) continue
    const raw = readFileSync(path)
    const packed = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
    writeFileSync(`${path}.br`, packed)
    writeFileSync(`${path}.gz`, gzipSync(raw, { level: 9 }))
    files++
    bytes += raw.length
    br += packed.length
  }
  return { files, bytes, br }
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, '..', 'dist', 'ui')
  const r = compressDir(dir)
  console.log(`compress-web-assets: ${r.files} files, ${(r.bytes / 1024).toFixed(0)} KB -> ${(r.br / 1024).toFixed(0)} KB brotli`)
}
