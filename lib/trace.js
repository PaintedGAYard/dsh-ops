/**
 * Opt-in record of what each execution handoff actually carried.
 *
 * Every failure this plugin has had on a Windows host lived at a handoff, not
 * inside a command: the DSH host hands a script to Windows PowerShell 5.1, the
 * plugin hands an argv to the host's subprocess service, that service hands the
 * argv to an ACL-restricted child, bash hands its work to forked children, and
 * FastCtx hands a call to a Rust worker. Each of those transfers re-decides an
 * environment, a console shape and an argv, and a failure at one of them is
 * invisible from the outside: the tool reports "access denied" or "command not
 * found" with no trace of which hop dropped what.
 *
 * This module writes one JSON object per line describing each hop as it happens,
 * so a failure can be attributed to a hop instead of argued about.
 *
 * **Off unless asked for, and never on the critical path.** Enablement is an
 * environment variable (`DSH_OPS_TRACE`) or a marker file inside the DSH home,
 * both read per event; with neither present every call here returns before
 * touching the filesystem. Nothing in this module ever throws: a trace that
 * cannot be written must not fail the command it was observing.
 *
 * @module dsh-ops/trace
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The format version of one line. Bumped when a field's meaning changes. */
export const TRACE_VERSION = 1

/** The environment variable that turns tracing on, whatever its file state. */
export const TRACE_ENV = 'DSH_OPS_TRACE'

/** The marker file that turns tracing on without changing the host's environment. */
export const TRACE_MARKER = 'trace.on'

/**
 * One line never grows the log past this size. The log answers "what did the
 * last failure do", so the newest records are the ones worth keeping: at the
 * cap the file is rotated once (to `handoff.1.jsonl`) and started again.
 */
export const TRACE_MAX_BYTES = 4 * 1024 * 1024

/**
 * Names whose value is never written. Matched against the upper-cased name, so
 * a child's environment can be recorded as "this name was there" without the
 * trace becoming a credential store of its own.
 */
const REDACTED_NAME = /KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|AUTH/i

/**
 * The DSH home, resolved the same way the rest of the plugin resolves it.
 * @returns {string} the home directory.
 */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/**
 * Where the log lives.
 * @returns {string} absolute path of the JSONL file.
 */
export function traceFile() {
  return path.join(dshHome(), 'dsh-ops', 'trace', 'handoff.jsonl')
}

/**
 * Whether the caller asked for a trace.
 *
 * The environment wins over the marker because it is the one an operator can
 * set for a single command; the marker is for "trace the next restart" without
 * editing anything a shell would have to be restarted to see.
 * @returns {boolean} true when tracing is on.
 */
export function traceEnabled() {
  const flag = process.env[TRACE_ENV]
  if (flag !== undefined) {
    const value = flag.trim().toLowerCase()
    if (value === '' || value === '0' || value === 'false' || value === 'off' || value === 'no') return false
    return true
  }
  try {
    return fs.existsSync(path.join(dshHome(), 'dsh-ops', TRACE_MARKER))
  } catch {
    return false
  }
}

/**
 * The two facts about a `PSModulePath` that decide whether Windows PowerShell
 * 5.1 can autoload its own Security module.
 *
 * Recorded as an index rather than a boolean because order is what decides:
 * a Core root ahead of the inbox root makes `Get-Acl` unresolvable, while the
 * same root after it is harmless. The raw value is kept as well — it is a list
 * of directories, not a secret, and a trace that forces the reader to guess
 * which root the host injected would be useless for exactly the case it exists
 * for.
 * @param {string|undefined} value - the value the child inherited.
 * @returns {object} the shape, with `-1` for "not present in this position".
 */
export function psModulePathShape(value) {
  if (value === undefined) return { present: false, roots: [], coreRootIndex: -1, inboxRootIndex: -1, raw: null }
  const entries = value.split(path.delimiter)
  const roots = entries.map(entry => entry.trim()).filter(entry => entry !== '')
  const find = pattern => roots.findIndex(root => pattern.test(root))
  return {
    present: true,
    roots,
    // The pwsh 7+ module root publishes a `Microsoft.PowerShell.Security` that
    // 5.1 cannot import: its extended type data collides with the assembly 5.1
    // has already loaded, and the autoload of `Get-Acl` then finds nothing.
    coreRootIndex: find(/[\\/]PowerShell[\\/]\d+(?:\.\d+)*[\\/]Modules[\\/]?$/i),
    // The inbox root 5.1 must resolve the module from.
    inboxRootIndex: find(/[\\/]WindowsPowerShell[\\/]v1\.0[\\/]Modules[\\/]?$/i),
    raw: value,
  }
}

/**
 * A child's environment as the trace records it: every name, none of the
 * credential-shaped values, and the two path values an audit needs.
 *
 * Names are included on purpose. "Which variables did this child actually
 * inherit" is the question a handoff trace exists to answer, and a count cannot
 * answer it.
 * @param {NodeJS.ProcessEnv} [env] - the environment block handed to the spawn.
 * @returns {object} the recordable summary.
 */
export function envSummary(env = process.env) {
  const names = Object.keys(env).sort()
  return {
    count: names.length,
    names,
    withheld: names.filter(name => REDACTED_NAME.test(name)),
    psModulePath: psModulePathShape(env.PSModulePath),
    fastctxBash: env.FASTCTX_BASH ?? null,
  }
}

/**
 * The console shape a spawn was given, as the parent specified it.
 *
 * A child cannot ask Windows whether it inherited a console, and the answer
 * decides whether Windows PowerShell 5.1 rewrites an inherited `PSModulePath`
 * or keeps it. Recording what the parent asked for is the only half available
 * at the parent, and it is the half that identifies the handoff.
 * @param {object} [options] - the spawn options handed to `child_process`.
 * @returns {object} the recordable summary.
 */
export function spawnShape(options = {}) {
  const stdio = options.stdio
  const kinds = typeof stdio === 'string'
    ? [stdio, stdio, stdio]
    : Array.isArray(stdio)
      ? stdio.map(entry => (typeof entry === 'string' ? entry : entry?.constructor?.name ?? 'handle'))
      : ['default']
  return {
    windowsHide: options.windowsHide === true,
    detached: options.detached === true,
    // Any entry that is not 'inherit' means the child holds no console handle
    // of the parent's, which is the shape that keeps an inherited module path.
    stdio: kinds,
    inheritsConsole: kinds.every(kind => kind === 'inherit'),
  }
}

/**
 * Keep one file under {@link TRACE_MAX_BYTES} by rotating it once.
 * @param {string} file - the log path.
 * @returns {void} never throws.
 */
function rotateIfNeeded(file) {
  try {
    const { size } = fs.statSync(file)
    if (size < TRACE_MAX_BYTES) return
    fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'))
  } catch {
    // No file yet, no permission, or a rename that lost a race: none of these
    // may interrupt the command being traced.
  }
}

/**
 * Append one record.
 *
 * `kind` names the hop (`preparation`, `bash`, `fastctx`, `worker`); the fields
 * are whatever that hop knows. A record is written with `O_APPEND`, so a second
 * process appending at the same moment interleaves whole lines rather than
 * corrupting them, and a write failure is swallowed.
 * @param {string} kind - the hop this record describes.
 * @param {object} [fields] - the hop's own facts.
 * @param {object} [options] - test seams: `file` to redirect the sink.
 * @returns {void} never throws.
 */
export function traceEvent(kind, fields = {}, options = {}) {
  try {
    if (!options.force && !traceEnabled()) return
    const file = options.file ?? traceFile()
    const record = {
      v: TRACE_VERSION,
      at: new Date().toISOString(),
      pid: process.pid,
      kind,
      ...fields,
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    rotateIfNeeded(file)
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // A trace is evidence, never a precondition.
  }
}

/**
 * Run `body` and record how it ended.
 *
 * Every handoff has the same two halves — what was handed over, and what came
 * back — so the timing, the outcome and the failure are recorded in one place
 * instead of at each site. `body`'s own exception is re-thrown unchanged; the
 * trace never alters a result.
 * @param {string} kind - the hop this record describes.
 * @param {object} fields - what the sender is handing over.
 * @param {() => Promise<any>} body - the handoff.
 * @param {object} [options] - test seams, passed through to {@link traceEvent}.
 * @returns {Promise<any>} whatever `body` returned.
 */
export async function traceHandoff(kind, fields, body, options = {}) {
  const started = Date.now()
  try {
    const value = await body()
    traceEvent(kind, { ...fields, outcome: 'resolved', durationMs: Date.now() - started }, options)
    return value
  } catch (error) {
    traceEvent(kind, {
      ...fields,
      outcome: 'rejected',
      durationMs: Date.now() - started,
      failure: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`.slice(0, 1200),
    }, options)
    throw error
  }
}
