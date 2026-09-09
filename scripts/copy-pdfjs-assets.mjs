/**
 * pdf.js loads character maps, standard fonts, colour profiles, and its image
 * decoder wasm at runtime. Copy them where Vite will serve and ship them, so a
 * scanned or CJK PDF renders with no network access.
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', 'pdfjs-dist')
const to = join(root, 'renderer', 'public', 'pdfjs')

const DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs']

await rm(to, { recursive: true, force: true })
await mkdir(to, { recursive: true })
for (const dir of DIRS) {
  await cp(join(from, dir), join(to, dir), { recursive: true })
}
console.log(`pdf.js assets copied to renderer/public/pdfjs (${DIRS.join(', ')})`)
