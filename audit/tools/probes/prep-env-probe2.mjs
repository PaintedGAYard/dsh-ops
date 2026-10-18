// Second axis of the same handoff: with PSModulePath present at all, does the
// inbox Security module load when its own root comes FIRST? The v0.3.1 fix
// removes the variable; this asks whether "contamination anywhere" or
// "contamination ahead of the inbox root" is the trigger.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, 'prep-env-probe2.json')
const ps51 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const probe = path.join(here, 'sec-module-probe.ps1')

const INBOX = 'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules'
const PF51 = 'C:\\Program Files\\WindowsPowerShell\\Modules'
const PS7 = 'c:\\program files\\powershell\\7\\Modules'
const PS7USER = 'E:\\Users\\David\\Documents\\PowerShell\\Modules'
const USER51 = 'E:\\Users\\David\\Documents\\WindowsPowerShell\\Modules'

const variants = [
  ['absent', undefined],
  ['inbox-only-pshome', INBOX],
  ['inbox-first-then-ps7', `${INBOX};${PF51};${PS7}`],
  ['ps7-first-then-inbox', `${PS7};${INBOX}`],
  ['ps7-user-only-ahead', `${PS7USER};${USER51};${PF51};${INBOX}`],
  ['empty-string', ''],
  ['trailing-semicolon-ps7', `${PF51};${INBOX};${PS7};`],
]

function runOne(tag, value) {
  return new Promise(resolve => {
    const out = path.join(here, `r2-${tag}.json`)
    fs.rmSync(out, { force: true })
    const env = { ...process.env }
    if (value === undefined) delete env.PSModulePath
    else env.PSModulePath = value
    const child = spawn(ps51, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe,
      '-Out', out, '-Tag', tag], { windowsHide: true, stdio: 'ignore', env })
    const timer = setTimeout(() => child.kill(), 90_000)
    child.once('error', error => { clearTimeout(timer); resolve({ tag, spawnError: error.message }) })
    child.once('close', code => {
      clearTimeout(timer)
      let result
      try { result = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '')) } catch { result = undefined }
      resolve({
        tag,
        passedIn: value ?? '(deleted)',
        exitCode: code,
        reported: result?.psModulePath,
        candidates: result?.candidateBases,
        importFailed: result ? result.importError !== null : 'no result file',
        importErrorHead: result?.importError ? result.importError.split('\n')[0].slice(0, 160) : null,
        getAclResolved: result?.getAclResolved,
        getAclError: result?.getAclError,
      })
    })
  })
}

const rows = []
for (const [tag, value] of variants) rows.push(await runOne(tag, value))
const report = { generatedAt: new Date().toISOString(), hostPsModulePath: process.env.PSModulePath, rows }
fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
