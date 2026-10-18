// One-off: put the audit diary's level-2 sections into canonical order.
// Phase sections sort numerically; everything else keeps a fixed slot. Verifies
// that the result is a permutation of the input before writing.
import fs from 'node:fs'

const file = 'E:\\Users\\David\\Source\\Playgrounds\\etc\\dev-diary\\2026-10-18-execution-handoff-audit.md'
const lines = fs.readFileSync(file, 'utf8').split('\n')

const heads = []
lines.forEach((line, index) => {
  if (/^## /.test(line)) heads.push({ title: line, start: index })
})
if (heads.length === 0) throw new Error('no level-2 headings')

const blockStart = heads.map(head => (lines[head.start - 2] === '---' && lines[head.start - 1] === '') ? head.start - 2 : head.start)
const preamble = lines.slice(0, blockStart[0])
const blocks = heads.map((head, index) => ({
  title: head.title,
  lines: lines.slice(blockStart[index], index + 1 < heads.length ? blockStart[index + 1] : lines.length),
}))

const fixed = [
  '## 目标（冻结，不再改）', '## 范围', '## 决定日志', '## 认知修订日志', '## 本轮新增的关键观测',
  '## 开放问题', '## 现行状态（干净基线）',
]
const phase = title => {
  const match = /^## Phase (\d+)/.exec(title)
  return match === null ? undefined : Number(match[1])
}

const ordered = [
  ...fixed.map(title => blocks.find(block => block.title === title)).filter(Boolean),
  ...blocks.filter(block => phase(block.title) !== undefined).sort((a, b) => phase(a.title) - phase(b.title)),
  ...blocks.find(block => block.title === '## 下一步') ? [blocks.find(block => block.title === '## 下一步')] : [],
  ...blocks.filter(block => !fixed.includes(block.title) && phase(block.title) === undefined && block.title !== '## 下一步'),
]

const result = [...preamble, ...ordered.flatMap(block => block.lines)]
const sameLines = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
if (!sameLines(lines, result)) {
  console.error('ABORT — line content changed, refusing to write')
  process.exit(1)
}

fs.writeFileSync(file, result.join('\n'))
const printed = result.filter(line => /^## /.test(line))
console.log(printed.join('\n'))
