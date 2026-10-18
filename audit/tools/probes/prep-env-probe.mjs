// Reproduces the plugin's preparation handoff (dsh host node -> Windows
// PowerShell 5.1) with the v0.3.0 and v0.3.1 environment rules side by side, so
// the only variable is what the interpreter inherits.
//
// No product code is edited: the real module's own spawn spec and env helper are
// imported and used as-is where possible.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = 'E:\\Users\\David\\Source\\Playgrounds\\etc\\dsh-ops-base'
const OUT = path.join(here, 'prep-env-probe.json')

const prep = await import(pathToFileURL(path.join(BASE, 'lib', 'workspace-preparation.js')).href)
const ps51 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const probe = path.join(here, 'sec-module-probe.ps1')

const env = {
  inherited: process.env,
  scrubbed: prep.preparationEnvironment(),
  // The v0.3.1 scrub, but with the machine/user module roots deliberately put
  // back: proves whether "absent" or "clean" is the load that fixes it.
  scrubbedPlusRegistry: { ...prep.preparationEnvironment(), PSModulePath: 'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules' },
}

function runOne(tag, { envBlock, hide = true, stdio = 'ignore' }) {
  return new Promise(resolve => {
    const out = path.join(here, `result-${tag}.json`)
    fs.rmSync(out, { force: true })
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe,
      '-Out', out, '-Tag', tag]
    // `stdio: 'ignore'` rather than pipes: this sandbox cannot open the named
    // pipes Node uses for `'pipe'`, and NUL handles are the same class as pipes
    // for the one question asked here (neither is the parent's console).
    const child = spawn(ps51, args, { windowsHide: hide, stdio, env: envBlock })
    let spawnError
    const timer = setTimeout(() => child.kill(), 90_000)
    child.once('error', error => { spawnError = error.message })
    child.once('close', code => {
      clearTimeout(timer)
      let result
      let rawText
      try {
        rawText = fs.readFileSync(out, 'utf8')
        result = JSON.parse(rawText.replace(/^\uFEFF/, ''))
      } catch (error) { rawText = `unreadable: ${error?.code ?? error}` }
      resolve({ tag, hide, stdio, spawnError, exitCode: code, outFileRaw: rawText.slice(0, 600), result })
    })
  })
}

const cases = [
  ['A-030-inherited-hide', { envBlock: env.inherited }],
  ['B-031-scrubbed-hide', { envBlock: env.scrubbed }],
  ['C-031-scrubbed+registry-hide', { envBlock: env.scrubbedPlusRegistry }],
  ['E-030-inherited-visible', { envBlock: env.inherited, hide: false }],
]

const rows = []
for (const [tag, opts] of cases) rows.push(await runOne(tag, opts))

// Faithfulness check: the module's own runPreparation, i.e. exactly what the
// plugin executes on a workspace-write session. The scratch root is ours, so the
// sandbox's own token is the only thing that can refuse the DACL write.
const scratch = path.join(here, 'scratch-ws')
fs.mkdirSync(scratch, { recursive: true })
let realCall
try {
  await prep.runPreparation(scratch)
  realCall = { tag: 'D-real-runPreparation', settled: 'resolved' }
} catch (error) {
  realCall = { tag: 'D-real-runPreparation', settled: 'rejected', message: String(error?.message ?? error).slice(0, 1200) }
}

const report = {
  generatedAt: new Date().toISOString(),
  host: {
    node: process.version,
    platform: process.platform,
    powershell51: ps51,
    hostPsModulePath: process.env.PSModulePath,
  },
  matrix: rows,
  realRunPreparation: realCall,
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
