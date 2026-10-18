// Why does a live `dsh-ops-ptc` row produce no preparation hook?
// `apply()` mounts the hook before it does anything else, so either `apply`
// threw earlier or the row never ran it. Drive the deployed module with a stub
// context and watch which `inject` calls happen.
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEPLOYED = 'C:\\Users\\david\\.dsh\\profiles\\web\\node_modules\\dsh-ops'
const mod = await import(pathToFileURL(path.join(DEPLOYED, 'lib', 'ptc', 'index.js')).href)

const events = []
const stub = {
  inject(services, cb) {
    events.push({ kind: 'inject', services, calledBack: false })
    // Do not run the callback: this is the mount decision, not the body.
  },
  get(key) { events.push({ kind: 'get', key }); return undefined },
  on(name) { events.push({ kind: 'on', name }) },
  effect() { events.push({ kind: 'effect' }) },
  plugin() { events.push({ kind: 'plugin' }) },
  logger: { warn: message => events.push({ kind: 'warn', message }), info: () => {} },
}

const report = { steps: [] }
const configs = [{ required: false }, {}]
for (const config of configs) {
  let resolved
  try {
    resolved = mod.resolvePtcConfig(config)
    report.steps.push({ config, resolvePtcConfig: 'ok', resolved })
  } catch (error) {
    report.steps.push({ config, resolvePtcConfig: `THREW: ${error?.message}` })
    continue
  }
  events.length = 0
  let outcome
  try {
    mod.apply(stub, config)
    outcome = 'returned'
  } catch (error) {
    outcome = `THREW: ${error?.message}`
  }
  report.steps[report.steps.length - 1].apply = outcome
  report.steps[report.steps.length - 1].events = [...events]
}

report.name = mod.name
console.log(JSON.stringify(report, null, 2))
