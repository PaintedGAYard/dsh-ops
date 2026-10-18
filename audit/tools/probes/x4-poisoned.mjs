// X4 negative control: what the trace looks like when the preparation spawn
// silently regresses to inheriting the host environment (the v0.3.0 shape).
//
// The regression is applied to the module itself, temporarily, by the caller —
// this script only drives it and reads the records back, so the signature it
// prints is the one the product would actually emit, not a hand-written one.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const AUDIT = 'E:\\Users\\David\\Source\\Playgrounds\\etc\\dsh-ops-audit'
const LOG = path.join(here, 'x4-records.jsonl')

fs.rmSync(LOG, { force: true })
process.env.DSH_OPS_TRACE = '1'
process.env.DSH_OPS_TRACE_FILE = LOG

const prep = await import(pathToFileURL(path.join(AUDIT, 'lib', 'workspace-preparation.js')).href)

const workspaceRoot = 'E:\\Users\\David\\Source\\Playgrounds\\etc'
let settled
const started = Date.now()
try {
  await prep.runPreparation(workspaceRoot)
  settled = { settled: 'resolved', durationMs: Date.now() - started }
} catch (error) {
  settled = { settled: 'rejected', durationMs: Date.now() - started, message: String(error?.message ?? error).slice(0, 900) }
}

const records = fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []
const record = records.find(r => r.kind === 'preparation')
const shape = record?.env?.psModulePath

const classification = (() => {
  const failure = record?.failure ?? ''
  if (/CouldNotAutoloadMatchingModule|is not recognized as the name of a cmdlet|type data file/i.test(failure)) return 'module-autoload'
  if (/UnauthorizedAccess|PSSecurityException|about_Execution_Policies/i.test(failure)) return 'execution-policy'
  if (/not owned by the current user|Explicit effective denial/i.test(failure)) return 'prerequisite'
  if (/timed out after/i.test(failure)) return 'timeout'
  return record === undefined ? 'no-record' : 'unclassified'
})()

const report = {
  generatedAt: new Date().toISOString(),
  settled,
  outcome: record?.outcome ?? null,
  classification,
  shape: shape === undefined ? null : {
    present: shape.present,
    coreRootIndex: shape.coreRootIndex,
    inboxRootIndex: shape.inboxRootIndex,
    roots: shape.roots,
    poisonAheadOfInbox: shape.present && shape.coreRootIndex >= 0
      && (shape.inboxRootIndex < 0 || shape.coreRootIndex < shape.inboxRootIndex),
  },
  failureHead: (record?.failure ?? '').split('\n').slice(0, 4).join(' | ').slice(0, 700),
}
fs.writeFileSync(path.join(here, 'x4-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
