# Phase 0.4 - install the upstream v0.3.1 baseline into the web profile.
#
# Run this with DSH STOPPED. pnpm cannot swap node_modules/dsh-ops while the host
# holds it (os error 32, tracked upstream as #175).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\phase0-install.ps1
#
# It resolves the dsh CLI itself and passes --dsh-cli, because the plugin installer
# otherwise falls back to a bare "dsh.cmd" and fails when that name is not on PATH.
# It backs up the profile manifest + lockfile first and restores them on failure.

[CmdletBinding()]
param(
  # The source tree to install from. Defaults to the local v0.3.1 worktree; the
  # deploy script points it at a GitHub-derived staging tree instead.
  [string]$Source,
  # Names the log / result / backup files, so two installers do not overwrite
  # each other's evidence.
  [string]$Label = 'phase0-install',
  # Target profile. The deploy script passes its own -Profile through this.
  [string]$ProfileName = 'web',
  # Uninstall the plugin before installing it: a true zero, not an in-place
  # replacement of the spec.
  [switch]$UninstallFirst,
  [switch]$Force,
  [switch]$ResolveCliOnly
)

$ErrorActionPreference = 'Stop'

$defaultBase = 'E:\Users\David\Source\Playgrounds\etc\dsh-ops-base'
if ([string]::IsNullOrWhiteSpace($Source)) { $Source = $defaultBase }
$base      = $Source
$profile   = Join-Path (Join-Path $env:USERPROFILE '.dsh') (Join-Path 'profiles' $ProfileName)
# Derived from this script, not hardcoded: the deploy script reads the result file
# from the same directory, and a moved checkout must keep them together.
$diary     = Join-Path $PSScriptRoot '.dsh-probe'
$result    = Join-Path $diary "$Label.result.txt"
$spec      = "file:$base"

New-Item -ItemType Directory -Force -Path $diary | Out-Null
$logFile   = Join-Path $diary "$Label.log"
$stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $diary "backup-profile-$stamp"

function Write-Both([string]$text) {
  Write-Host $text
  Add-Content -LiteralPath $logFile -Value $text -Encoding utf8
}

Write-Both "=== phase0 install $(Get-Date -Format o) ==="
Write-Both "spec    : $spec"
Write-Both "profile : $profile"

# --- 1. refuse to run against a live host -------------------------------------
$busy = @(Get-Process -Name node, dsh, 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($busy.Count -gt 0) {
  Write-Both "WARNING: $($busy.Count) process(es) still running:"
  $busy | ForEach-Object { Write-Both ("  {0} pid={1}" -f $_.ProcessName, $_.Id) }
  if (-not $Force) {
    Write-Both 'Refusing: stop DSH (and any node process holding the profile) and re-run.'
    Write-Both 'If you are certain, re-run with -Force.'
    exit 2
  }
  Write-Both 'Continuing because -Force was given.'
}

# --- 2. resolve a working dsh CLI ---------------------------------------------
function Resolve-DshCli {
  $candidates = New-Object 'System.Collections.Generic.List[string]'
  if ($env:DSH_OPS_DSH_CLI) { $candidates.Add($env:DSH_OPS_DSH_CLI) }
  # Prefer the global install. An npx-run host only provides a launcher inside its own
  # cache directory, and that entry point is not stable once the app is stopped -- which is
  # exactly the state this script requires.
  try {
    $prefix = (& npm prefix -g 2>$null | Select-Object -First 1)
    if ($prefix) { foreach ($name in 'dsh.cmd', 'dsh.exe') { $candidates.Add((Join-Path $prefix $name)) } }
  } catch { }
  foreach ($name in 'dsh.cmd', 'dsh.exe') {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $candidates.Add($cmd.Source) }
  }
  # Last resort: an npx cache launcher (known to vanish with the running host).
  Get-ChildItem 'E:\NodeJS\package-cache\_npx' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Join-Path $_.FullName 'node_modules\.bin\dsh.cmd'
    if (Test-Path -LiteralPath $p) { $candidates.Add($p) }
  } | Out-Null
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (-not $seen.Add($candidate)) { continue }
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    try {
      # Do not pipe the native call: `... | Select-Object -First 1` discards $LASTEXITCODE.
      $probe = & $candidate --version 2>&1
      $probeExit = $LASTEXITCODE
      $version = @($probe) | Select-Object -First 1
      if ($probeExit -eq 0 -and "$version" -match '^\d+\.\d+') {
        Write-Both "cli     : $candidate ($version)"
        return $candidate
      }
      Write-Both "cli skip: $candidate (exit=$probeExit, said: $version)"
    } catch { Write-Both "cli skip: $candidate ($($_.Exception.Message))" }
  }
  return $null
}

$cli = Resolve-DshCli
if (-not $cli) {
  Write-Both 'FAILED: no working dsh CLI found; set DSH_OPS_DSH_CLI to a launcher that answers --version.'
  @{ ok = $false; spec = $spec; at = (Get-Date).ToString('o'); error = 'no working dsh CLI' } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $result -Encoding utf8
  exit 3
}

if ($ResolveCliOnly) {
  Write-Both 'RESULT: cli resolved; nothing installed (-ResolveCliOnly).'
  exit 0
}

# --- 3. back up the profile manifest and lockfile -----------------------------
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
foreach ($name in 'package.json', 'pnpm-lock.yaml') {
  $src = Join-Path $profile $name
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $backupDir $name) -Force }
}
Write-Both "backup  : $backupDir"

try {
  # --- 4. install -------------------------------------------------------------
  # The plugin installer spawns the official CLI with `stdio: 'inherit'` (lib/profile-install.js),
  # so pnpm's real error text goes to the inherited console and `& node ... 2>&1` never sees it.
  # Spawning node with its own redirected handles captures the grandchild as well.
  $env:DSH_OPS_INSTALL_SPEC = $spec

  Write-Both '--- preflight ---'
  Write-Both ("node: " + (& node --version 2>&1))
  $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpmCmd) { Write-Both ("pnpm: " + $pnpmCmd.Source) } else { Write-Both 'pnpm: not on PATH (the official CLI carries its own)' }
  Write-Both ("node_modules/dsh-ops exists: " + (Test-Path -LiteralPath (Join-Path $profile 'node_modules\dsh-ops')))

  function Invoke-CliCaptured([string[]]$cliArgs, [string]$label) {
    $outFile = Join-Path $diary "$label-$stamp.out.txt"
    $errFile = Join-Path $diary "$label-$stamp.err.txt"
    $nodeExe = (Get-Command node).Source
    $proc = Start-Process -FilePath $nodeExe -ArgumentList $cliArgs -NoNewWindow -PassThru -Wait `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    foreach ($file in @($outFile, $errFile)) {
      if (Test-Path -LiteralPath $file) { Get-Content -LiteralPath $file | ForEach-Object { Write-Both "  $_" } }
    }
    return [pscustomobject]@{ code = $proc.ExitCode; out = $outFile; err = $errFile }
  }

  Write-Both '--- install ---'
  if ($UninstallFirst) {
    $uninstall = Invoke-CliCaptured @("$base\bin\dsh-ops.mjs", 'uninstall', '--profile', $ProfileName, '--dsh-cli', $cli) 'uninstall'
    Write-Both "uninstall exit=$($uninstall.code)"
    if ($uninstall.code -ne 0) {
      Write-Both 'WARNING: uninstall exited non-zero; continuing -- install replaces the entry anyway.'
    } else {
      # The profile has already been mutated: from here on, restoring the manifest
      # would re-add a dependency whose bytes are gone.
      $script:profileMutated = $true
    }
  }
  $install = Invoke-CliCaptured @("$base\bin\dsh-ops.mjs", 'install', '--profile', $ProfileName, '--dsh-cli', $cli) 'install'
  Write-Both "install exit=$($install.code)"

  if ($install.code -ne 0) {
    $first = ''
    foreach ($file in @($install.out, $install.err)) {
      if (Test-Path -LiteralPath $file) { $first += (Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue) }
    }
    # A store-lock or directory-lock failure is often transient (an indexer or a just-exited
    # process still holding a handle). One retry is cheaper than another stop/start cycle.
    if ($first -match 'ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK|os error 32|EBUSY|Access is denied|ECONNRESET|ETIMEDOUT|ECONNREFUSED') {
      Write-Both 'transient signature detected; retrying once after 10 s'
      Start-Sleep -Seconds 10
      $install = Invoke-CliCaptured @("$base\bin\dsh-ops.mjs", 'install', '--profile', $ProfileName, '--dsh-cli', $cli) 'install-retry'
      Write-Both "install retry exit=$($install.code)"
    }
  }
  if ($install.code -ne 0) { throw "install exited $($install.code); captured output in $($install.out) and $($install.err)" }
  $script:installSucceeded = $true

  # --- 5. verify --------------------------------------------------------------
  Write-Both '--- status ---'
  $statusResult = Invoke-CliCaptured @("$base\bin\dsh-ops.mjs", 'status', '--profile', $ProfileName) 'status'
  $statusText = ''
  if (Test-Path -LiteralPath $statusResult.out) { $statusText = Get-Content -LiteralPath $statusResult.out -Raw }
  # pnpm writes the spec with forward slashes and its own casing; compare normalized, never raw.
  $specNorm = ($spec -replace '\\', '/').ToLowerInvariant()
  if ($statusText.Replace('\', '/').ToLowerInvariant() -notlike "*$specNorm*") {
    throw "status does not report the file: spec: $statusText"
  }
  if ($statusText -notmatch '"enabled":\s*true') { throw "the bundle row is not enabled in the profile: $statusText" }

  # `status` reports the profile manifest, never a version: check the installed bytes.
  $installed = Join-Path $profile 'node_modules\dsh-ops'
  $item = Get-Item -LiteralPath $installed -Force
  Write-Both ("installed node_modules entry: linkType={0} target={1}" -f $item.LinkType, ($item.Target -join ','))
  $installedManifest = Join-Path $installed 'package.json'
  if (-not (Test-Path -LiteralPath $installedManifest)) { throw "installed package manifest missing: $installedManifest" }
  $version = (Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json).version
  Write-Both "installed package version: $version"
  if ($version -ne '0.3.1') { throw "installed package is $version, expected 0.3.1" }

  $receiptFile = Join-Path $installed 'runtime\win32-x64\provenance.json'
  if (-not (Test-Path -LiteralPath $receiptFile)) { throw "native runtime receipt missing: $receiptFile" }
  $receipt = Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json
  Write-Both "native runtime receipt: version=$($receipt.version) target=$($receipt.target)"
  if ($receipt.version -ne '0.3.1') { throw "staged native runtime is $($receipt.version), expected 0.3.1" }

  $residual = @(Get-ChildItem -LiteralPath $installed -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { Select-String -LiteralPath $_.FullName -Pattern 'temporary probe' -Quiet -ErrorAction SilentlyContinue })
  if ($residual.Count -gt 0) { throw "temporary probe still present in the installed package: $($residual[0].FullName)" }
  Write-Both 'no temporary probe found in the installed package'

  @{ ok = $true; spec = $spec; at = (Get-Date).ToString('o'); cli = $cli; version = $version; status = $statusText } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $result -Encoding utf8
  Write-Both 'RESULT: ok - restart DSH, then Phase 0.5 verification continues.'
  exit 0
}
catch {
  Write-Both "FAILED: $($_.Exception.Message)"

  # A verification failure must never undo a successful install: restoring the manifest alone
  # would leave package.json disagreeing with the bytes pnpm actually installed. The same holds
  # once an uninstall has already mutated the profile.
  if ($script:installSucceeded -or $script:profileMutated) {
    Write-Both 'install SUCCEEDED; verification failed. NOT rolling back -- the profile now holds'
    Write-Both 'what pnpm installed, and restoring only the manifest would make it inconsistent.'
    @{ ok = $false; installed = $true; spec = $spec; at = (Get-Date).ToString('o'); error = $_.Exception.Message } |
      ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $result -Encoding utf8
    Write-Both 'RESULT: installed, verification failed - inspect the messages above.'
    exit 1
  }

  # The captured files hold what the inherited-stdio grandchild wrote; name the likely cause.
  $captured = ''
  Get-ChildItem -LiteralPath $diary -Filter "*-$stamp.*.txt" -File -ErrorAction SilentlyContinue | ForEach-Object {
    $captured += (Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue)
  }
  if ($captured -match 'ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK|Access is denied\. \(os error 5\)') {
    Write-Both 'HINT: pnpm could not take the store operation lock.'
    Write-Both '      Lock files: %LOCALAPPDATA%\pnpm-store-operation-locks'
    Write-Both '      Another pnpm or DSH process still holds them. Close it and retry.'
  } elseif ($captured -match 'os error 32|EBUSY|being used by another process') {
    Write-Both 'HINT: something still holds the plugin directory. Not only DSH: an editor or'
    Write-Both '      Explorer can hold it too (VS Code was the holder once). Close them and retry.'
  } elseif ($captured -match 'ERR_PNPM_|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch') {
    Write-Both 'HINT: pnpm failed while fetching; check registry reachability from this terminal.'
  } else {
    Write-Both 'HINT: see the captured output files named above.'
  }

  Write-Both 'Restoring the profile manifest and lockfile...'
  foreach ($name in 'package.json', 'pnpm-lock.yaml') {
    $bak = Join-Path $backupDir $name
    if (Test-Path -LiteralPath $bak) { Copy-Item -LiteralPath $bak -Destination (Join-Path $profile $name) -Force }
  }
  @{ ok = $false; spec = $spec; at = (Get-Date).ToString('o'); error = $_.Exception.Message } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $result -Encoding utf8
  Write-Both 'RESULT: failed - profile manifest restored. Diagnose before retrying.'
  exit 1
}
