// X1 baseline, host-free half: drive the exact functions the plugin calls, with
// tracing on, against the real Windows PowerShell 5.1 and the real deployed
// worker binary.
//
// Why this can run outside a DSH host at all: `runPreparation` and `probeBinary`
// are the handoffs themselves, not wrappers around them. What cannot be
// reproduced here is the host's *scheduling* of them (the tools/execute hook) —
// that still needs the restart.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const AUDIT = 'E:\\Users\\David\\Source\\Playgrounds\\etc\\dsh-ops-audit'
const DEPLOYED = 'C:\\Users\\david\\.dsh\\profiles\\web\\node_modules\\dsh-ops'
const LOG = path.join(here, 'x1-records.jsonl')

fs.rmSync(LOG, { force: true })
process.env.DSH_OPS_TRACE = '1'
process.env.DSH_OPS_TRACE_FILE = LOG

const trace = await import(pathToFileURL(path.join(AUDIT, 'lib', 'trace.js')).href)
const prep = await import(pathToFileURL(path.join(AUDIT, 'lib', 'workspace-preparation.js')).href)
const binary = await import(pathToFileURL(path.join(AUDIT, 'lib', 'binary.js')).href)

const workspaceRoot = 'E:\\Users\\David\\Source\\Playgrounds\\etc'
const results = {}

// B1: the real root the host would prepare on its first shell call.
const before = Date.now()
try {
  await prep.runPreparation(workspaceRoot)
  results.preparation = { settled: 'resolved', durationMs: Date.now() - before }
} catch (error) {
  results.preparation = { settled: 'rejected', message: String(error?.message ?? error).slice(0, 800) }
}

// B0: the probe against the worker the profile actually ships.
const worker = path.join(DEPLOYED, 'runtime', 'win32-x64', 'dsh-ops-worker.exe')
results.workerExists = fs.existsSync(worker)
results.probe = fs.existsSync(worker) ? binary.probeBinary(worker) : { skipped: 'no worker' }

const records = fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []

function invariant(name, ok, detail) {
  return { name, ok, detail }
}

const prepRecord = records.find(r => r.kind === 'preparation')
const probeRecord = records.find(r => r.kind === 'probe')

const checks = [
  invariant('I2a preparation records the spawn shape',
    prepRecord?.spawn !== undefined && prepRecord?.spawn?.inheritsConsole === false,
    prepRecord?.spawn),
  invariant('I2b the interpreter gets no inherited PSModulePath',
    prepRecord?.env?.psModulePath?.present === false,
    prepRecord?.env?.psModulePath?.present),
  invariant('I1 the probe hands over no credential-shaped value',
    probeRecord !== undefined && Array.isArray(probeRecord.env.withheld) && probeRecord.env.withheld.length === 0,
    probeRecord?.env?.withheld),
  invariant('records carry the writing process pid and a version',
    records.every(r => r.v === 1 && typeof r.pid === 'number' && typeof r.at === 'string'),
    records.map(r => `${r.kind}@${r.pid}`)),
]

const report = {
  generatedAt: new Date().toISOString(),
  host: { node: process.version, psModulePathInThisProcess: process.env.PSModulePath ?? null },
  results,
  recordKinds: records.map(r => r.kind),
  checks,
}
fs.writeFileSync(path.join(here, 'x1-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
