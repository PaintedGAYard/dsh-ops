// Pre-restart smoke test: the deployed package must at least *load*.
//
// A hash-matched copy that throws on import would take the whole plugin down at
// the next start, and that failure would look like a regression to whoever
// restarts. Everything here imports the deployed tree itself, not the worktree.
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEPLOYED = 'C:\\Users\\david\\.dsh\\profiles\\web\\node_modules\\dsh-ops'
const entries = [
  'lib/trace.js',
  'lib/workspace-preparation.js',
  'lib/binary.js',
  'lib/handshake.js',
  'lib/shells.js',
  'lib/tools.js',
  'lib/profile-install.js',
  'lib/ptc/worker.js',
  'lib/file/worker.js',
  'lib/ptc/index.js',
  'lib/components/ptc/index.js',
  'lib/components/file/index.js',
]

const results = []
for (const entry of entries) {
  const file = path.join(DEPLOYED, entry)
  const started = Date.now()
  try {
    const mod = await import(pathToFileURL(file).href)
    results.push({ entry, ok: true, exports: Object.keys(mod).length, ms: Date.now() - started })
  } catch (error) {
    results.push({ entry, ok: false, error: `${error?.name}: ${error?.message}`.slice(0, 400) })
  }
}

// The deployed trace module must be the instrumented one, and must write where
// the marker file is looked for.
const trace = await import(pathToFileURL(path.join(DEPLOYED, 'lib', 'trace.js')).href)
const previous = process.env.DSH_HOME
process.env.DSH_HOME = 'C:\\Users\\david\\.dsh'
const sink = trace.traceFile()
const markerEnabled = trace.traceEnabled()
if (previous === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previous

const report = {
  deployed: DEPLOYED,
  allLoaded: results.every(r => r.ok),
  results,
  sink,
  markerEnabledWithoutMarker: markerEnabled,
}
console.log(JSON.stringify(report, null, 2))
