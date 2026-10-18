#!/usr/bin/env node
/**
 * The handoff trace: off by default, complete enough to attribute a failure,
 * and never on the critical path.
 *
 * The suite is deliberately about the *record*, not about the commands it
 * describes: a trace that cannot be trusted to be inert is worse than no trace,
 * so every check here is either "this answer is right" or "this call cannot
 * break the caller".
 *
 * @module dsh-ops/test/trace
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  TRACE_ENV, TRACE_FILE_ENV, TRACE_MAX_BYTES, TRACE_VERSION,
  describeArgv, envSummary, psModulePathShape, spawnShape, traceEnabled, traceEvent, traceFile, traceHandoff,
} from '../lib/trace.js'
import { probeBinary } from '../lib/binary.js'
import { runPreparation, watchGate } from '../lib/workspace-preparation.js'
import { TEST_HOME, assert, scenarioDir, test, report } from './lib/harness.mjs'

const previousFlag = process.env[TRACE_ENV]

/** Run `body` with one trace flag value, restoring the caller's afterwards. */
async function withFlag(value, body) {
  if (value === undefined) delete process.env[TRACE_ENV]
  else process.env[TRACE_ENV] = value
  try { return await body() } finally {
    if (previousFlag === undefined) delete process.env[TRACE_ENV]
    else process.env[TRACE_ENV] = previousFlag
  }
}

/** Read a JSONL log as records. @returns {object[]} the parsed lines. */
function records(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line))
}

await test('a trace is off unless the operator asks for one', async () => {
  await withFlag(undefined, async () => {
    // The marker is what a restart reads; the environment is what a single
    // command reads. With neither, the answer has to be "no".
    fs.rmSync(path.join(TEST_HOME, 'dsh-ops', 'trace.on'), { force: true })
    assert.equal(traceEnabled(), false)
    assert.equal(traceFile(), path.join(TEST_HOME, 'dsh-ops', 'trace', 'handoff.jsonl'))
  })
})

await test('the environment turns it on, and off again, per value', async () => {
  for (const on of ['1', 'true', 'ON', 'yes', 'anything']) {
    await withFlag(on, () => assert.equal(traceEnabled(), true, `${on} must enable`))
  }
  for (const off of ['', '0', 'false', 'OFF', 'no']) {
    await withFlag(off, () => assert.equal(traceEnabled(), false, `${off} must not enable`))
  }
})

await test('the marker file enables it, and the environment still wins', async () => {
  await withFlag(undefined, async () => {
    const marker = path.join(TEST_HOME, 'dsh-ops', 'trace.on')
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, '')
    assert.equal(traceEnabled(), true)
    process.env[TRACE_ENV] = '0'
    assert.equal(traceEnabled(), false, 'an explicit off must beat the marker')
    fs.rmSync(marker, { force: true })
    delete process.env[TRACE_ENV]
  })
})

await test('a module path is recorded by position, because order is what decides', async () => {
  const absent = psModulePathShape(undefined)
  assert.equal(absent.present, false)
  assert.deepEqual(absent.roots, [])
  assert.equal(absent.coreRootIndex, -1)
  assert.equal(absent.inboxRootIndex, -1)

  const core = 'C:\\Program Files\\PowerShell\\7\\Modules'
  const inbox = 'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules'
  const poisoned = psModulePathShape([core, inbox].join(path.delimiter))
  assert.equal(poisoned.present, true)
  assert.equal(poisoned.coreRootIndex, 0)
  assert.equal(poisoned.inboxRootIndex, 1)

  const harmless = psModulePathShape([inbox, core].join(path.delimiter))
  assert.equal(harmless.coreRootIndex, 1)
  assert.equal(harmless.inboxRootIndex, 0)

  // Empty segments are what a trailing separator produces; they name nothing.
  const trailing = psModulePathShape(`${inbox}${path.delimiter}${path.delimiter}`)
  assert.deepEqual(trailing.roots, [inbox])
})

await test('an environment is recorded by name, and credential-shaped values never are', async () => {
  const summary = envSummary({
    PATH: 'C:\\Windows',
    PSModulePath: 'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules',
    FASTCTX_BASH: 'C:\\bash.exe',
    GH_TOKEN: 'do-not-record',
    DEEPSEEK_API_KEY: 'do-not-record',
    SSH_AUTH_SOCK: '\\\\.\\pipe\\x',
  })
  assert.deepEqual(summary.names, ['DEEPSEEK_API_KEY', 'FASTCTX_BASH', 'GH_TOKEN', 'PATH', 'PSModulePath', 'SSH_AUTH_SOCK'])
  // `SSH_AUTH_SOCK` is withheld too, and deliberately: it authorises the host's
  // SSH keys, which is the same reason `lib/env.js` refuses to forward it.
  assert.deepEqual(summary.withheld, ['DEEPSEEK_API_KEY', 'GH_TOKEN', 'SSH_AUTH_SOCK'])
  assert.equal(summary.fastctxBash, 'C:\\bash.exe')
  assert.equal(summary.psModulePath.present, true)
  // No value of a withheld name appears anywhere in the record.
  assert.equal(JSON.stringify(summary).includes('do-not-record'), false)
})

await test('a spawn records whether the child could inherit a console', async () => {
  // Windows PowerShell 5.1 only rewrites an inherited PSModulePath when all
  // three standard handles are the parent's console; that is the fact the
  // preparation handoff lives or dies on.
  assert.equal(spawnShape({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).inheritsConsole, false)
  assert.equal(spawnShape({ stdio: 'inherit' }).inheritsConsole, true)
  assert.equal(spawnShape({}).inheritsConsole, false)
  assert.deepEqual(spawnShape({ stdio: ['ignore', 'pipe', 'pipe'] }).stdio, ['ignore', 'pipe', 'pipe'])
})

await test('an enabled trace writes one versioned line per event, and a disabled one writes nothing', async () => {
  const file = path.join(scenarioDir('trace-sink'), 'handoff.jsonl')
  await withFlag(undefined, () => {
    traceEvent('bash', { outcome: 'settled' }, { file })
    assert.equal(fs.existsSync(file), false, 'a disabled trace must not create the file')
  })
  await withFlag('1', () => {
    traceEvent('bash', { outcome: 'settled', exitCode: 0 }, { file })
  })
  traceEvent('bash', { outcome: 'settled', exitCode: 1 }, { file, force: true })
  const lines = records(file)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].v, TRACE_VERSION)
  assert.equal(lines[0].kind, 'bash')
  assert.equal(lines[0].exitCode, 0)
  assert.equal(lines[0].pid, process.pid)
  assert.equal(typeof lines[0].at, 'string')
  // The second line is well-formed JSON of its own: appends never splice.
  assert.equal(lines[1].exitCode, 1)
})

await test('a log at the cap is rotated once, not grown forever', async () => {
  const directory = scenarioDir('trace-rotate')
  const file = path.join(directory, 'handoff.jsonl')
  fs.writeFileSync(file, 'x'.repeat(TRACE_MAX_BYTES))
  traceEvent('bash', { outcome: 'settled' }, { file, force: true })
  assert.equal(fs.existsSync(file), true, 'a fresh log must exist after rotation')
  assert.equal(fs.statSync(file).size < TRACE_MAX_BYTES, true)
  assert.equal(fs.existsSync(file.replace(/\.jsonl$/, '.1.jsonl')), true)
  assert.equal(records(file).length, 1)
})

await test('a trace that cannot be written never breaks the caller', async () => {
  // A directory is not a file: `appendFileSync` fails, and the failure must be
  // swallowed rather than surfacing as a tool error.
  const directory = scenarioDir('trace-unwritable')
  traceEvent('bash', { outcome: 'settled' }, { file: directory, force: true })
  const value = await traceHandoff('bash', { note: 'x' }, async () => 7, { file: directory, force: true })
  assert.equal(value, 7)
  // An exception in the observed body is rethrown unchanged, not wrapped.
  await assert.rejects(
    () => traceHandoff('bash', {}, async () => { throw new TypeError('boom') }, { file: directory, force: true }),
    error => error instanceof TypeError && error.message === 'boom',
  )
  assert.equal(fs.existsSync(path.join(directory, 'handoff.jsonl')), false)
})

await test('the preparation handoff is recorded with both halves, and still rejects as before', async () => {
  const root = scenarioDir('trace-preparation-root')
  const unintended = path.join(scenarioDir('trace-preparation'), 'handoff.jsonl')
  await withFlag('1', async () => {
    // An executable that cannot exist: the handoff rejects exactly as it would
    // without tracing, and the record names the interpreter and the environment
    // it was handed. Platform-neutral on purpose — the record is the thing under
    // test, not PowerShell — and the failure text is the platform's own answer
    // (`ENOENT` when the spawn reaches the OS, `EPERM` from a confined token),
    // so only its presence is asserted.
    await assert.rejects(
      () => runPreparation(root, { executable: path.join(root, 'no-such-interpreter'), args: [] }),
      error => error instanceof Error,
    )
  })
  assert.equal(fs.existsSync(unintended), false, 'the record belongs in the sink, not beside the workspace')
  const preparation = records(traceFile()).find(record => record.kind === 'preparation')
  assert.ok(preparation, 'the preparation hop must have been recorded')
  assert.equal(preparation.root, root)
  assert.equal(preparation.outcome, 'rejected')
  assert.match(preparation.failure, /no-such-interpreter|spawn|ENOENT|EPERM/)
  assert.equal(preparation.spawn.inheritsConsole, false, 'the preparation executor is never console-attached')
  // The environment the interpreter was actually handed, not the host's: where
  // the host has a module path, the handoff removes it before the spawn.
  if (process.env.PSModulePath !== undefined) {
    assert.equal(preparation.env.psModulePath.present, false, 'the recorded environment must be the scrubbed one')
  }
  assert.equal(typeof preparation.env.count, 'number')
})

await test('a log can be redirected per experiment, so a sweep cannot mix evidence', async () => {
  const file = path.join(scenarioDir('trace-redirect'), 'probe-a.jsonl')
  const saved = process.env[TRACE_FILE_ENV]
  process.env[TRACE_FILE_ENV] = file
  try {
    assert.equal(traceFile(), file)
    assert.equal(path.isAbsolute(traceFile()), true)
  } finally {
    if (saved === undefined) delete process.env[TRACE_FILE_ENV]
    else process.env[TRACE_FILE_ENV] = saved
  }
  assert.equal(traceFile(), path.join(TEST_HOME, 'dsh-ops', 'trace', 'handoff.jsonl'))
})

await test('an argv is classified by whether the host runner wraps it', async () => {
  const direct = describeArgv(['C:\\w\\dsh-ops-worker.exe'])
  assert.equal(direct.runnerWrapped, false)
  assert.equal(direct.head, 'C:\\w\\dsh-ops-worker.exe')

  // The ACL backend's contract: [node, runner.js, '--workspace', …, '--', argv].
  // Seeing the wrapper is the only way to tell "the child never started" from
  // "the child crashed" — both are just a non-zero exit code.
  const wrapped = describeArgv(['C:\\node.exe', 'C:\\pkg\\acl\\lib\\runner.js', '--workspace', 'E:\\ws', '--', 'C:\\w\\worker.exe'])
  assert.equal(wrapped.runnerWrapped, true)
  assert.match(wrapped.wrapper, /runner\.js$/)

  assert.equal(describeArgv(undefined).head, null)
  assert.equal(describeArgv([]).runnerWrapped, false)
})

await test('an executable probe is recorded with the environment it was handed', async () => {
  const root = scenarioDir('trace-probe')
  await withFlag('1', () => {
    const result = probeBinary(path.join(root, 'no-such-binary'))
    assert.equal(result.ok, false)
  })
  const probe = records(traceFile()).find(record => record.kind === 'probe')
  assert.ok(probe, 'the probe hop must have been recorded')
  assert.equal(probe.outcome, 'failed')
  assert.match(probe.file, /no-such-binary/)
  // A candidate is never handed the host environment: this is the whole reason
  // `lib/env.js` exists, and the record shows it.
  assert.equal(probe.env.psModulePath.present, false)
})

await test('the preparation gate names its own reason', async () => {
  // "The hook never ran" and "the hook ran and skipped" look identical from
  // outside, and the difference decides whether a shell failure is a preparation
  // bug at all. The reason is therefore a value, not a nested condition.
  for (const tool of ['pwsh', 'bash', 'run_code', 'pwsh_persistent', 'bash_persistent']) {
    assert.equal(watchGate({ name: tool }, { id: 's' }), 'watched', tool)
  }
  for (const tool of ['read', 'ops_glob', 'ops_replace', 'write']) {
    assert.equal(watchGate({ name: tool }, { id: 's' }), 'not-watched', tool)
  }
  assert.equal(watchGate({ name: 'pwsh' }, undefined), 'no-session')
  assert.equal(watchGate(undefined, { id: 's' }), 'not-watched')
})

report('trace')
