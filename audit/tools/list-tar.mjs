// Read a .tar.gz header-by-header without trusting bsdtar, to answer one
// question: is the archive damaged, or is the reader refusing a header shape?
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const raw = fs.readFileSync(file)
const tar = zlib.gunzipSync(raw)

const octal = (buffer, offset, length) => {
  const text = buffer.toString('latin1', offset, offset + length).replace(/\0.*$/, '').trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

let offset = 0
let count = 0
const odd = []
const kinds = new Map()
const first = []
while (offset + 512 <= tar.length) {
  const header = tar.subarray(offset, offset + 512)
  if (header.every(byte => byte === 0)) {
    count += 1
    odd.push({ at: offset, why: 'all-zero block (end marker or padding)' })
    offset += 512
    continue
  }
  const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '')
  const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '')
  const size = octal(header, 124, 12)
  const type = String.fromCharCode(header[156] || 0x30)
  const full = prefix === '' ? name : `${prefix}/${name}`
  kinds.set(type, (kinds.get(type) ?? 0) + 1)
  if (first.length < 3) first.push({ type, size, name: full })
  if (name.trim() === '') odd.push({ at: offset, why: `empty name, type=${type}, size=${size}` })
  count += 1
  offset += 512 + Math.ceil(size / 512) * 512
}

console.log(`file        : ${file}`)
console.log(`gzip        : ${raw.length} B -> ${tar.length} B of tar`)
console.log(`entries     : ${count}`)
console.log(`typeflags   : ${[...kinds].map(([type, n]) => `${JSON.stringify(type)}x${n}`).join(' ')}`)
console.log('first entries:')
for (const entry of first) console.log(`  type=${entry.type} size=${entry.size} ${entry.name}`)
console.log(`odd headers : ${odd.length}`)
for (const item of odd.slice(0, 8)) console.log(`  @${item.at}: ${item.why}`)
