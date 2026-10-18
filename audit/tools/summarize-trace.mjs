#!/usr/bin/env node
/**
 * Read-only summary of the dsh-ops handoff trace, plus the invariant checks that
 * `dev-diary/handoff-failure-modes.md` §3 defines.
 *
 * This exists because the evidence has to survive a context switch: the session
 * that produces a record is not always the session that reads it, and a raw JSONL
 * file is not a report. One command, one page, no writes.
 *
 * Usage:
 *   node summarize-trace.mjs                 # the default sink
 *   node summarize-trace.mjs --since 26376   # only one host process
 *   node summarize-trace.mjs --last 20       # tail
 *   node summarize-trace.mjs --file <path>   # another sink
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const option = (name, fallback = undefined) => {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const file = option('--file', path.join(home, 'dsh-ops', 'trace', 'handoff.jsonl'))
const since = option('--since')
const last = Number(option('--last', '0'))

if (!fs.existsSync(file)) {
  console.log(`trace: ${file}`)
  console.log('NO TRACE FILE — tracing is off (no marker, no DSH_OPS_TRACE) or nothing ran yet')
  process.exit(0)
}

const parse = line => {
  try { return JSON.parse(line) } catch { return undefined }
}
const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(parse).filter(Boolean)
const records = all.filter(record => since === undefined || String(record.pid) === String(since))
const marker = fs.existsSync(path.join(home, 'dsh-ops', 'trace.on'))

const line = text => console.log(text)
const pad = (value, width) => String(value ?? '-').padEnd(width).slice(0, width)

line(`trace      : ${file}`)
line(`marker     : ${marker ? 'on (trace.on present)' : 'off (no trace.on)'}`)
line(`records    : ${records.length} shown / ${all.length} total${since === undefined ? '' : ` (pid ${since})`}`)
if (records.length === 0) {
  line('nothing to summarise')
  process.exit(0)
}
const first = records[0]
const lastRecord = records[records.length - 1]
line(`window     : ${first.at} .. ${lastRecord.at}`)
line(`pids       : ${[...new Set(records.map(record => record.pid))].join(', ')}`)

line('')
line('--- by kind / outcome ---------------------------------------')
const groups = new Map()
for (const record of records) {
  const key = `${record.kind}/${record.outcome ?? '-'}`
  groups.set(key, (groups.get(key) ?? 0) + 1)
}
for (const [key, count] of [...groups].sort()) line(`  ${pad(key, 34)} ${count}`)

line('')
line('--- preparation ---------------------------------------------')
const preparations = records.filter(record => record.kind === 'preparation')
if (preparations.length === 0) line('  (none)')
for (const record of preparations) {
  line(`  ${record.at} pid=${record.pid} ${record.outcome} ${record.durationMs}ms`)
  line(`    root=${record.root}`)
  line(`    executable=${record.executable}`)
  line(`    spawn=${JSON.stringify(record.spawn)}`)
  line(`    psModulePath.present=${record.env?.psModulePath?.present} env.count=${record.env?.count} withheld=[${(record.env?.withheld ?? []).join(',')}]`)
  if (record.failure) line(`    failure=${String(record.failure).slice(0, 300)}`)
}

line('')
line('--- workers -------------------------------------------------')
const workers = records.filter(record => record.kind === 'worker')
if (workers.length === 0) line('  (none)')
for (const record of workers) {
  line(`  ${record.at} ${pad(record.component, 5)} ${pad(record.tool, 8)} exit=${pad(record.exitCode, 4)} ` +
    `dur=${pad(record.durationMs, 5)} wrap=${record.runnerWrapped} enf=${pad(record.enforcement, 8)} ` +
    `outcome=${record.outcome ?? 'settled'}`)
  if (record.failure) line(`    failure=${String(record.failure).slice(0, 220)}`)
  if (record.stderrHead) line(`    stderr=${String(record.stderrHead).slice(0, 220)}`)
}

line('')
line('--- mcp -----------------------------------------------------')
const mcp = records.filter(record => record.kind === 'mcp')
if (mcp.length === 0) line('  (none — this composition does not use FastCtx)')
for (const record of mcp) {
  line(`  ${record.at} outcome=${pad(record.outcome, 16)} pid=${record.pid} childPid=${record.childPid ?? '-'} ` +
    `tools=${record.toolCount ?? '-'} ${record.durationMs ?? '-'}ms`)
  if (record.failure) line(`    failure=${String(record.failure).slice(0, 220)}`)
}

if (last > 0) {
  line('')
  line(`--- last ${last} records (raw) -------------------------------`)
  for (const record of records.slice(-last)) line(`  ${JSON.stringify(record).slice(0, 400)}`)
}

line('')
line('--- invariants ----------------------------------------------')
const verdicts = []
const check = (id, name, ok, detail) => verdicts.push({ id, name, ok, detail })

const probes = records.filter(record => record.kind === 'probe')
check('I1', 'probe hands over no credential-shaped value',
  probes.length === 0 ? undefined : probes.every(record => (record.env?.withheld ?? []).length === 0),
  probes.length === 0 ? 'no probe records' : `${probes.length} probe record(s)`)

check('I2', 'preparation spawn is never console-attached and never inherits PSModulePath',
  preparations.length === 0 ? undefined : preparations.every(record =>
    record.spawn?.inheritsConsole === false && record.env?.psModulePath?.present === false),
  preparations.length === 0 ? 'no preparation records' : `${preparations.length} preparation record(s)`)

// The trace records env names, not values (by design), so I3 can only assert the
// name reached the child — which is exactly what the forced override is about.
const spawns = mcp.filter(record => 'childPid' in record)
check('I3', 'every MCP spawn carries the forced FASTCTX_NO_PARENT_WATCH name',
  spawns.length === 0 ? undefined : spawns.every(record => (record.env?.names ?? []).includes('FASTCTX_NO_PARENT_WATCH')),
  spawns.length === 0 ? 'no mcp spawn records' : `${spawns.length} mcp spawn record(s)`)

// A confined PTC worker must arrive wrapped by the host ACL runner; the trusted
// file executor has no confinement hop, so it must NOT be wrapped.
const confinedWorkers = workers.filter(record => record.component === 'ptc' && record.mode !== 'danger-full-access')
const fileWorkers = workers.filter(record => record.component === 'file')
check('I4', 'confined PTC workers are runner-wrapped, file workers are not',
  confinedWorkers.length === 0 && fileWorkers.length === 0 ? undefined
    : confinedWorkers.every(record => record.runnerWrapped === true) && fileWorkers.every(record => record.runnerWrapped === false),
  `${confinedWorkers.length} confined ptc / ${fileWorkers.length} file worker record(s)`)

const pids = [...new Set(records.map(record => record.pid))]
// Advisory unless the window was narrowed: across restarts a growing pid set is
// expected, and only a `--since` window makes "more than one pid" meaningful.
check('I5', 'one host process in the window (advisory unless --since)',
  since === undefined ? undefined : pids.length === 1, `${pids.length} pid(s): ${pids.join(', ')}`)

for (const verdict of verdicts) {
  const label = verdict.ok === undefined ? 'SKIP ' : verdict.ok ? 'ok   ' : 'FAIL '
  line(`  ${label} ${verdict.id}  ${verdict.name}`)
  line(`        ${verdict.detail}`)
}
const failed = verdicts.filter(verdict => verdict.ok === false)
line('')
line(failed.length === 0 ? 'no invariant violations' : `${failed.length} invariant violation(s)`)
