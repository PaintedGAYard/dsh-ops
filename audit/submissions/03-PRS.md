# Pull requests (drafts, not opened)

Both are written against the repository's own PR template
(`.github/PULL_REQUEST_TEMPLATE.md`): `Closes #`, **What was wrong**, **The change**, **Validation**,
**Environment**.

Before either is opened, in this order:

1. **Claim** the issue (comment) — `CONTRIBUTING.md:29-33` makes an unclaimed PR unacceptable.
2. Apply the change on a `work/<topic>` branch of the fork, synced with `upstream/main`.
3. Run `npm run verify` on Windows x64 and paste the **real** output into Validation. The `⚠` blocks
   below are placeholders and must be replaced, not ticked.
4. Add the `## [Unreleased]` entry to `docs/CHANGELOG.md`.

---

## P1

**Branch** `work/preparation-module-free`
**Title**

```
fix(preparation): read the DACL through .NET so the bootstrap needs no PowerShell module
```

**Body**

```markdown
Closes #<issue>

## What was wrong

`bin/prepare-workspace.ps1` is spawned by `lib/workspace-preparation.js` with `windowsHide: true` and
`stdio: ['ignore', 'pipe', 'pipe']`. In that launch shape Windows PowerShell 5.1 does **not** rewrite
an inherited `PSModulePath`; it keeps it verbatim, and command discovery then resolves `Get-Acl` to
the first `Microsoft.PowerShell.Security` manifest on the list — the pwsh 7 one, whose
`CompatiblePSEditions = @("Core")` cannot load in the desktop edition:

    The 'Get-Acl' command was found in the module 'Microsoft.PowerShell.Security',
    but the module could not be loaded.   (CouldNotAutoloadMatchingModule)

The script then exits non-zero on its first DACL read, `tools/execute` aborts the dispatch, and every
`run_code` / `pwsh` / `bash` / `*_persistent` call fails for the rest of the host process's life.

#83 removes the variable before the spawn, which fixes the symptom. It does not remove the dependency:
`Microsoft.PowerShell.Security` is the only module this script needs that 5.1 does not already have,
so a DACL *read* is the only reason the bootstrap needs a module at all — the DACL *write* has gone
through .NET since #74 (`[IO.Directory]::SetAccessControl`, `SetKernelObjectSecurity`).

Measured inside the failing launch, same 5.1 process:

| command | module | detached launch |
| --- | --- | --- |
| `Get-Item`, `Join-Path`, `Set-Content` | Management | resolves |
| `Where-Object` | Core | resolves |
| `Add-Type`, `Write-Output`, `Get-Date` | Utility | resolves |
| `Get-Acl`, `Set-Acl` | **Security** | **unresolved** |

## The change

`bin/prepare-workspace.ps1`, both call sites:

```diff
-$acl = Get-Acl -LiteralPath $item.FullName
+# Read the DACL through .NET. Get-Acl resolves through module autoload, and PowerShell 5.1 keeps an
+# inherited PSModulePath verbatim when it is launched detached — no console, redirected stdio — which
+# is exactly how lib/workspace-preparation.js launches it. Microsoft.PowerShell.Security is the only
+# module this script needs that 5.1 does not already have.
+$acl = [System.IO.Directory]::GetAccessControl($item.FullName)
```

```diff
-    $after = Get-Acl -LiteralPath $item.FullName
+    $after = [System.IO.Directory]::GetAccessControl($item.FullName)
```

`Directory.GetAccessControl(string)` is .NET Framework 4.x, which is what 5.1 runs on; the script only
ever runs under 5.1, and `lib/workspace-preparation.js` hardcodes that interpreter.

`test/permissions.test.mjs` gains one behavioural case, and the comment above the existing
`preparationEnvironment` cases is corrected: the trigger is the detached launch, not merely an
inherited variable.

```js
// The bootstrap must not depend on PowerShell module autoload. This case spawns Windows PowerShell 5.1
// the same way lib/workspace-preparation.js does — hidden, all three stdio handles redirected — and
// hands it a pwsh 7-shaped PSModulePath. In that shape 5.1 keeps the inherited value verbatim, so
// `Get-Acl` resolves to the Core-only pwsh 7 manifest and the script cannot run. Revert the .NET DACL
// read above and this case fails with CouldNotAutoloadMatchingModule.
await test('preparation script reads the DACL with no PowerShell module available', async () => {
  if (process.platform !== 'win32') {
    console.log('preparation-script-autoload fixture unavailable: Windows PowerShell 5.1 only')
    return
  }
  const interpreter = join(process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!existsSync(interpreter)) {
    console.log('preparation-script-autoload fixture unavailable: no Windows PowerShell 5.1')
    return
  }
  await withTempDir('dshops-preparation-autoload', async (root) => {
    const script = fileURLToPath(new URL('../bin/prepare-workspace.ps1', import.meta.url))
    // `withTempDir` creates a directory the current user owns with the usual inherited grant, which is
    // the `ready` path: the script must reach it without writing anything.
    ownWindowsFixture(root)
    const run = spawnSync(interpreter, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Workspace', root, '-BackupDir', join(root, '.receipts'),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PSModulePath: [
          join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'Modules'),
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        ].join(';'),
      },
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.match(run.stdout, /ready|prepared/)
  })
})
```

## Validation

⚠ Replace with the real run before opening.

```
$ node scripts/validate-manifest.mjs
<output>

$ node test/run.mjs permissions
<output — must show the new case, the existing preparation cases, and zero skips>

$ DSH_OPS_REQUIRE_RUNTIME=1 npm run verify
<output — pass/skip/fail counts>
```

Red/green: with the two `[System.IO.Directory]::GetAccessControl` lines reverted to `Get-Acl`, the new
case fails with `CouldNotAutoloadMatchingModule`; with them in place it passes.

`docs/CHANGELOG.md` `## [Unreleased]`:

```
### Preparation bootstrap no longer needs a PowerShell module

- `bin/prepare-workspace.ps1` reads the DACL with `[System.IO.Directory]::GetAccessControl` instead of
  `Get-Acl`. PowerShell 5.1 keeps an inherited `PSModulePath` verbatim when it is launched detached
  (hidden, stdio redirected) — the shape `lib/workspace-preparation.js` uses — so `Get-Acl` could
  resolve to the Core-only pwsh 7 module and abort every shell tool. #83's environment scrub stays;
  this removes the dependency it was working around.
```

No user-facing documentation change: no configuration key, tool contract, default or refusal condition
changes. `docs/troubleshooting.md` (and `常见问题.md`) keep describing the same remediation.

## Environment

Windows 11 `10.0.26200` · DSH `0.2.0-rc.2` · Node `<24.x>` · Windows PowerShell `5.1.26100.9444` ·
upstream `main` at the commit this branch is rebased on · installed as a profile dependency.
```

---

## P2

**Branch** `work/preparation-spawn-env-policy`
**Title**

```
fix(preparation): apply the documented child-environment policy to the preparation spawn and the runtime probe
```

**Body**

```markdown
Closes #<issue>

## What was wrong

`PROVENANCE.md` states the rule as a property of the plugin:

> the credential rule both spawn paths keep: a child never inherits credential-shaped names or ambient
> `DSH_*` facts

There are four spawn paths, and two of them do not keep it:

| call site | child environment |
| --- | --- |
| `lib/handshake.js` FastCtx server | `childEnv()` — credential-shaped names and ambient `DSH_*` dropped |
| `lib/shells.js` `ops_bash` | the host subprocess service's credential scrub |
| `lib/workspace-preparation.js` Windows PowerShell 5.1 | **all of `process.env`, minus `PSModulePath`** |
| `lib/binary.js` `probeBinary` (`fastctx --version`) | **`process.env` by default** |

The preparation comment is deliberate about the three variables it names — "PATH, SystemRoot and
DSH_HOME are the child's own inputs" — but the rule it does not apply is about credentials, not about
location inputs. This is the least confined process in the chain: it runs with the host's full token,
before the sandbox is entered, on the first shell call of every `workspace-write` session.

No leak has been observed; this is about the invariant the project already states and pins elsewhere.

## The change

1. Extract the existing heuristic into `lib/child-env.js` (`childEnv`, `CREDENTIAL_PATTERN`,
   `DSH_ENV_PREFIX`); `lib/tools.js` imports it instead of keeping its own copy. Behaviour there is
   unchanged.
2. `preparationEnvironment()` composes them, in a stated order: scrub credentials and ambient `DSH_*`,
   then delete `PSModulePath`.
3. `probeBinary()` defaults to `childEnv()` instead of `process.env`.

```diff
-export function preparationEnvironment(source = process.env) {
-  const env = { ...source }
-  delete env.PSModulePath
-  return env
-}
+export function preparationEnvironment(source = process.env) {
+  // Two rules, in order: no credential-shaped name or ambient DSH_* fact (the same rule the FastCtx
+  // child and `ops_bash` keep), then no inherited PowerShell module search path (#83). `DSH_HOME` is
+  // read in the parent and passed to the script as `-BackupDir`, so the child does not need it.
+  const env = childEnv(source)
+  delete env.PSModulePath
+  return env
+}
```

```js
// test/permissions.test.mjs
await test('preparation spawn strips credentials and ambient DSH facts, keeping location inputs', async () => {
  const env = preparationSpawnSpec('C:\\work\\scratch').options.env
  for (const name of ['PSModulePath', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'MY_SECRET', 'DSH_SESSION_ID']) {
    assert.equal(Object.keys(env).some((k) => k.toUpperCase() === name), false, `${name} must not reach 5.1`)
  }
  assert.equal(env.DSH_HOME, undefined)   // passed as -BackupDir, not as an inherited fact
  assert.ok(Object.keys(env).some((k) => k.toUpperCase() === 'PATH'))
  assert.ok(Object.keys(env).some((k) => k.toUpperCase() === 'SYSTEMROOT'))
})
```

## Validation

⚠ Replace with the real run before opening.

```
$ node test/run.mjs permissions
<output>

$ node test/run.mjs mount
<output — the FastCtx childEnv() cases must be unchanged after the extraction>

$ npm run verify
<output>
```

Red/green: revert `preparationEnvironment()` to the spread-and-delete form and the new case fails on
`OPENAI_API_KEY` … `DSH_SESSION_ID`; revert `probeBinary`'s default and the probe case fails.

`docs/CHANGELOG.md` `## [Unreleased]`:

```
### Preparation spawn keeps the credential rule

- The Windows preparation interpreter and the `fastctx --version` probe now receive the same scrubbed
  environment the FastCtx server and `ops_bash` already receive: credential-shaped names and ambient
  `DSH_*` facts are dropped, location inputs (`PATH`, `SystemRoot`) are kept, and `DSH_HOME` reaches
  the child only as `-BackupDir`.
```

`PROVENANCE.md`: the "Two spawn paths, one credential policy" section becomes "Four spawn paths, one
credential policy", with the two new rows.

## Environment

Same as the linked issue.
```

---

## Notes for us (not for the submission)

- **P1 is the one that matters.** P2 is small and correct, but it touches `lib/tools.js` via the
  extraction; if a reviewer objects to that churn, the fallback is to duplicate the four-line filter in
  `lib/workspace-preparation.js` and drop item 3 (`probeBinary`).
- P1's new case needs `spawnSync` with piped stdio. That is exactly what this session's confined shell
  refuses (`spawn EPERM`), so **it has never been executed here**. Run it on an unconfined Windows host
  before opening the PR — if the case does not go red when the fix is reverted, the case is wrong and
  the PR should not be opened with it.
- Both PRs are independent; P1 does not touch P2's files and vice versa.
