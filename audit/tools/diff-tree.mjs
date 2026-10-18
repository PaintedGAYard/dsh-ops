// Compare a tag archive's file list with what actually landed in a staging tree.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const [archive, tree] = process.argv.slice(2)
const tar = zlib.gunzipSync(fs.readFileSync(archive))
const octal = (buffer, offset, length) => {
  const text = buffer.toString('latin1', offset, offset + length).replace(/\0.*$/, '').trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

const expected = new Set()
let offset = 0
while (offset + 512 <= tar.length) {
  const header = tar.subarray(offset, offset + 512)
  if (header.every(byte => byte === 0)) { offset += 512; continue }
  const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '')
  const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '')
  const size = octal(header, 124, 12)
  const type = String.fromCharCode(header[156] || 0x30)
  const full = prefix === '' ? name : `${prefix}/${name}`
  if (type === '0') expected.add(full.replace(/^[^/]+\//, ''))
  offset += 512 + Math.ceil(size / 512) * 512
}

const actual = new Set()
const walk = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(full)
    else actual.add(path.relative(tree, full).replaceAll('\\', '/'))
  }
}
walk(tree)

const missing = [...expected].filter(item => !actual.has(item))
const extra = [...actual].filter(item => !expected.has(item) && !item.startsWith('runtime/') && item !== '.source.json')

console.log(`archive files : ${expected.size}`)
console.log(`staged files  : ${actual.size} (incl. runtime/)`)
console.log(`missing       : ${missing.length}`)
for (const item of missing.slice(0, 15)) console.log(`  - ${item}`)
console.log(`unexpected    : ${extra.length}`)
for (const item of extra.slice(0, 15)) console.log(`  + ${item}`)
if (missing.length > 0) {
  const lengths = missing.map(item => path.resolve(tree, item).length)
  console.log(`longest missing path length: ${Math.max(...lengths)} (MAX_PATH risk above 260)`)
}
