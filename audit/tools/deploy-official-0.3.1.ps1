# Deploy the OFFICIAL dsh-ops v0.3.1 from GitHub into a DSH profile.
#
# Why a script at all: v0.3.1 was released as a git tag plus a native runtime
# asset, and never published to npm (`latest` is still 0.3.0). A `file:` spec on
# a local worktree is not "official" -- it is whatever that worktree happens to
# contain. This acquires the two published artifacts, verifies them by digest,
# assembles a tree that is byte-for-byte what the tag plus the release asset
# describe, and then hands the install to phase0-install.ps1.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-official-0.3.1.ps1 -Plan
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-official-0.3.1.ps1 -Zero
#
# DSH MUST BE STOPPED. pnpm cannot swap node_modules/dsh-ops while the host holds
# it (`os error 32`); the script refuses to run otherwise unless -Force is given.
#
# Nothing here deletes a profile dependency tree by default. `-NukeNodeModules`
# RENAMES it aside and renames it back if the install did not take effect, because
# the tree holds the whole web profile (cordis and every dsh plugin), and a
# half-finished full reinstall leaves the GUI unable to start.
#
# TOOLCHAIN: Windows-native only. PowerShell 5.1, .NET (ZipFile, Get-FileHash,
# Invoke-WebRequest), and 7-Zip -- a native PE binary with no MSYS layer -- for the
# one thing .NET 4.x cannot do: read a .tar.gz. `System32\tar.exe` is bsdtar, a
# libarchive port, and it silently drops the five Chinese-named docs under docs/;
# it is deliberately not used anywhere in this script.

[CmdletBinding()]
param(
  [string]$Tag = 'v0.3.1',
  [string]$Profile = 'web',
  [string]$StagingRoot = (Join-Path $env:LOCALAPPDATA 'dsh-ops-src'),
  # Resolved after param(): $PSScriptRoot is not reliably populated inside a
  # param() default when the script is started with -File.
  [string]$CacheRoot,
  # Use only what is already in -CacheRoot; no network at all.
  [switch]$FromCache,
  # Uninstall the plugin before installing it: a true zero, not a spec swap.
  [switch]$Zero,
  # Rename <profile>\node_modules aside before installing, and rename it back if
  # the install did not take effect.
  [switch]$NukeNodeModules,
  # Rebuild the staging tree even when an existing one already verifies.
  [switch]$ReStage,
  # Acquire, assemble and verify the staging tree, then stop before touching the
  # profile. Useful for a dry run of the risky half, and for pre-staging.
  [switch]$StageOnly,
  # Print every step and exit without touching anything.
  [switch]$Plan,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$thisDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($CacheRoot)) { $CacheRoot = Join-Path $thisDir '.dsh-probe\dl' }

# --- pinned facts -------------------------------------------------------------
# Digests are what makes "official" verifiable. The runtime asset's digest is the
# worker executable itself, which is what the plugin's resolver probes; the
# tarball digest is pinned on first sight (a GitHub tag archive is stable, but we
# have not seen it in this workspace, so the receipt records it and later runs
# require it to match).
$pins = @{
  'v0.3.1' = @{
    version          = '0.3.1'
    tag              = 'v0.3.1'
    repo             = 'T-Auto/dsh-ops'
    tarballUrl       = 'https://codeload.github.com/T-Auto/dsh-ops/tar.gz/refs/tags/v0.3.1'
    runtimeUrl       = 'https://github.com/T-Auto/dsh-ops/releases/download/v0.3.1/native-win32-x64-runtime-v0.3.1.zip'
    runtimeZip       = 'native-win32-x64-runtime-v0.3.1.zip'
    workerSha256     = '89B8E1E9856E9FF6755C70EE6143EFFF65DC84A354A7E0D22A1D24AAC87C8225'
    # Completeness of the tag archive. Windows bsdtar cannot create the five
    # Chinese-named docs under docs/: it extracts 456 of 461 files and reports
    # "Archive entry has empty or unreadable filename". Two independent readers
    # agree on 461, so the count is pinned and checked after extraction.
    files            = 461
    nonAsciiDocs     = 5
    # Files that must NOT be in an official tree: they are our audit build's.
    absent           = @('lib\trace.js')
    # Strings that must NOT appear anywhere under lib\: the audit instrument.
    absentMarkers    = @('traceHandoff', 'traceEvent(')
  }
}

if (-not $pins.ContainsKey($Tag)) {
  Write-Host "FAILED: no pinned description for tag '$Tag'. Known: $($pins.Keys -join ', ')"
  exit 3
}
$pin = $pins[$Tag]
$version = $pin.version
$staging = Join-Path $StagingRoot $version
$receiptFile = Join-Path $staging '.source.json'
$profileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh') (Join-Path 'profiles' $Profile)

function Say([string]$text) { Write-Host $text }

# --- 1. preconditions ---------------------------------------------------------
Say "=== deploy official dsh-ops $Tag -> profile '$Profile' ==="
Say "staging : $staging"
Say "cache   : $CacheRoot"
Say "profile : $profileDir"

if (-not (Test-Path -LiteralPath $profileDir)) {
  Write-Host "FAILED: profile directory not found: $profileDir"
  exit 3
}

$busy = @(Get-Process -Name node, dsh, 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($busy.Count -gt 0) {
  Say "WARNING: $($busy.Count) process(es) still running:"
  $busy | ForEach-Object { Say ("  {0} pid={1}" -f $_.ProcessName, $_.Id) }
  if (-not $Force -and -not $Plan) {
    Say 'Refusing: stop DSH (and any editor holding the profile) and re-run; or add -Force.'
    exit 2
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'FAILED: node is not on PATH.'
  exit 3
}

# --- 2. verify a staging tree -------------------------------------------------
function Test-Staging([string]$path) {
  $problems = New-Object 'System.Collections.Generic.List[string]'
  if (-not (Test-Path -LiteralPath $path)) { $problems.Add('does not exist'); return $problems }
  $manifest = Join-Path $path 'package.json'
  if (-not (Test-Path -LiteralPath $manifest)) { $problems.Add('package.json missing'); return $problems }
  $declared = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
  if ($declared -ne $pin.version) { $problems.Add("package.json version is $declared, expected $($pin.version)") }
  if (-not (Test-Path -LiteralPath (Join-Path $path 'lib\env.js'))) { $problems.Add('lib/env.js missing (not a v0.3.1 tree)') }
  foreach ($relative in $pin.absent) {
    if (Test-Path -LiteralPath (Join-Path $path $relative)) { $problems.Add("$relative present (this is the audit build, not the official one)") }
  }
  $libFiles = @(Get-ChildItem -LiteralPath (Join-Path $path 'lib') -Recurse -File -Filter '*.js' -ErrorAction SilentlyContinue)
  foreach ($marker in $pin.absentMarkers) {
    $hit = $libFiles | Where-Object { Select-String -LiteralPath $_.FullName -Pattern $marker -SimpleMatch -Quiet } | Select-Object -First 1
    if ($hit) { $problems.Add("instrumentation marker '$marker' found in $($hit.Name) (audit build, not official)") }
  }
  $worker = Join-Path $path 'runtime\win32-x64\dsh-ops-worker.exe'
  if (-not (Test-Path -LiteralPath $worker)) {
    $problems.Add('runtime/win32-x64/dsh-ops-worker.exe missing (the release asset is not staged)')
  } else {
    $hash = (Get-FileHash -LiteralPath $worker -Algorithm SHA256).Hash
    if ($hash -ne $pin.workerSha256) { $problems.Add("worker sha256 is $hash, expected $($pin.workerSha256)") }
  }
  $receipt = Join-Path $path 'runtime\win32-x64\provenance.json'
  if (Test-Path -LiteralPath $receipt) {
    $staged = (Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json).version
    if ($staged -ne $pin.version) { $problems.Add("runtime receipt says $staged, expected $($pin.version)") }
  }
  # Completeness: the tag tree must be whole, including the non-ASCII doc names
  # that bsdtar silently drops. Only the TOP-LEVEL runtime\ (the separately staged
  # asset) is excluded -- `vendor/fastctx/src/runtime/*.rs` are tag files and count.
  $runtimePrefix = (Join-Path $path 'runtime') + '\'
  $treeFiles = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { -not $_.FullName.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase) -and $_.Name -ne '.source.json' })
  if ($treeFiles.Count -ne $pin.files) {
    $problems.Add("tag tree has $($treeFiles.Count) files, expected $($pin.files) (a lower count means the extractor skipped entries; a higher one means the tree is not the tag)")
  }
  $docs = @(Get-ChildItem -LiteralPath (Join-Path $path 'docs') -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '[^\x00-\x7F]' })
  if ($docs.Count -ne $pin.nonAsciiDocs) {
    $problems.Add("docs/ has $($docs.Count) non-ASCII-named files, expected $($pin.nonAsciiDocs) (bsdtar drops these)")
  }
  return $problems
}

function Show-Problems($problems) { foreach ($problem in $problems) { Say "  - $problem" } }

# Defined before the plan block: -Plan asks whether 7-Zip is present, and
# PowerShell resolves functions at execution time, not at parse time.
function Find-SevenZip {
  foreach ($candidate in @('7z.exe', '7z')) {
    $command = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  foreach ($path in @((Join-Path $env:ProgramFiles '7-Zip\7z.exe'), (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe'))) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  return $null
}

$existing = Test-Staging $staging
$stagingOk = ($existing.Count -eq 0)

Say ''
Say "staging verifies : $stagingOk"
if ($stagingOk) { Say '  (nothing to download; pass -ReStage to rebuild it)' } else { Show-Problems $existing }

# --- 3. the plan --------------------------------------------------------------
if ($Plan) {
  Say ''
  Say '--- plan (no changes made) ------------------------------------------'
  Say "1. $(if ($stagingOk -and -not $ReStage) { 'staging already verifies -> skip step 2 and 3' } else { "download cache: $CacheRoot" })"
  Say "2. tarball : $($pin.tarballUrl)"
  Say "3. asset   : $($pin.runtimeUrl)"
  Say "4. assemble: $staging  (tag tree + runtime/win32-x64 from the asset)"
  Say '   extractor: 7-Zip only -- native Windows PE, no *nix layer. bsdtar is not used.'
  if (-not (Find-SevenZip)) { Say '   NOTE: 7-Zip is not installed; staging needs it (winget install --id 7zip.7zip -e)' }
  Say "5. verify  : version=$($pin.version); $($pin.files) tag files; $($pin.nonAsciiDocs) non-ASCII doc names; lib/env.js present; $($pin.absent -join ', ') absent; worker sha256=$($pin.workerSha256.Substring(0,16))..."
  Say "6. install : phase0-install.ps1 -Source `"$staging`" -Label deploy-$version$(if ($Zero) { ' -UninstallFirst' } else { '' }) -Force"
  if ($NukeNodeModules) { Say "   (before step 6: rename $profileDir\node_modules aside; restore it if the install does not take effect)" }
  Say '   then: verify the installed copy is 0.3.1, has the pinned worker, and carries no instrumentation.'
  Say '7. report  : receipt, rollback recipe, and what changed.'
  Say ''
  Say 'Run without -Plan to execute.'
  exit 0
}

# --- 4. acquire ---------------------------------------------------------------
function Find-SingleRoot([string]$directory) {
  $roots = @(Get-ChildItem -LiteralPath $directory -Directory -Force -ErrorAction SilentlyContinue)
  if ($roots.Count -ne 1) { return $null }
  return $roots[0].FullName
}

function Test-TreeComplete([string]$root) {
  if (-not $root) { return $false }
  $count = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue).Count
  return $count -eq $pin.files
}

# Extract the tag archive with 7-Zip and nothing else.
#
# `System32\tar.exe` is bsdtar -- a libarchive port, not a Windows tool. It cannot
# create the five Chinese-named docs under docs/: it skips them, prints "Archive
# entry has empty or unreadable filename", and still hands back a tree that looks
# plausible. It is not used here at all. 7-Zip is a native PE binary with no MSYS
# layer, decodes the same archive completely (461/461), and is the only external
# tool this script allows.
function Expand-TagArchive {
  param([string]$Archive, [string]$Scratch)

  $seven = Find-SevenZip
  if (-not $seven) {
    throw 'extracting the tag archive needs 7-Zip (native Windows build). Install it with: winget install --id 7zip.7zip -e'
  }
  Say "  extractor: 7-Zip ($seven) -- native, no *nix layer"

  $innerDir = Join-Path $Scratch 'inner'
  New-Item -ItemType Directory -Force -Path $innerDir | Out-Null
  & $seven x -y "-o$innerDir" $Archive | Out-Null
  $inner = @(Get-ChildItem -LiteralPath $innerDir -File -Force -Filter '*.tar')
  if ($inner.Count -ne 1) { throw "7-Zip produced $($inner.Count) inner .tar file(s) in $innerDir; expected exactly one" }

  $tree = Join-Path $Scratch 'tree'
  New-Item -ItemType Directory -Force -Path $tree | Out-Null
  & $seven x -y "-o$tree" $inner[0].FullName | Out-Null

  $root = Find-SingleRoot $tree
  if (-not $root) { throw "the tag archive should contain exactly one top-level directory; found $(@(Get-ChildItem -LiteralPath $tree -Directory -Force).Count)" }
  if (-not (Test-TreeComplete $root)) {
    $count = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue).Count
    throw "7-Zip produced $count of $($pin.files) tag files; refusing a short tree"
  }
  return $root
}

New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
$tarballPath = Join-Path $CacheRoot "dsh-ops-$version.tar.gz"
$runtimeZipPath = Join-Path $CacheRoot $pin.runtimeZip

function Get-Artifact([string]$url, [string]$target) {
  if (Test-Path -LiteralPath $target) {
    Say "  cached   : $target"
    return
  }
  if ($FromCache) { throw "-FromCache was given but $target is not present." }
  Say "  download : $url"
  Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing
  if (-not (Test-Path -LiteralPath $target)) { throw "download produced nothing: $url" }
  Say "  saved    : $target ($((Get-Item -LiteralPath $target).Length) B)"
}

if (-not ($stagingOk -and -not $ReStage)) {
  Say ''
  Say '--- acquire ---------------------------------------------------------'
  Get-Artifact $pin.tarballUrl $tarballPath
  Get-Artifact $pin.runtimeUrl $runtimeZipPath

  $tarballSha = (Get-FileHash -LiteralPath $tarballPath -Algorithm SHA256).Hash
  Say "  tarball  : sha256=$tarballSha"
  if (Test-Path -LiteralPath $receiptFile) {
    $previous = Get-Content -LiteralPath $receiptFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    if ($previous.tarballSha256 -and $previous.tarballSha256 -ne $tarballSha) {
      if (-not $Force) {
        throw "the tag archive digest changed ($($previous.tarballSha256) -> $tarballSha). A moved tag is a supply-chain event; re-run with -Force only if you accept it."
      }
      Say '  WARNING: tag archive digest changed; continuing because -Force was given.'
    }
  }

  Say ''
  Say '--- assemble --------------------------------------------------------'
  $scratch = Join-Path $env:TEMP ("dsh-ops-stage-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $scratch | Out-Null
  try {
    $source = Expand-TagArchive -Archive $tarballPath -Scratch $scratch
    Say "  tag tree : $source ($(@(Get-ChildItem -LiteralPath $source -Recurse -File -Force).Count) files)"

    # One directory move, not one move per entry: something in the tree holds a
    # non-ASCII name, and per-entry moves are where those get lost silently.
    # Move-Item renames $source ONTO $staging, so $staging must not exist but its
    # PARENT must -- the default StagingRoot is absent on a fresh machine.
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $staging) | Out-Null
    Move-Item -LiteralPath $source -Destination $staging

    $runtimeDir = Join-Path $staging 'runtime\win32-x64'
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    # .NET, not a ported unzip: Windows-native and encoding-correct.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($runtimeZipPath, $runtimeDir)
    Say "  runtime   : $((@(Get-ChildItem -LiteralPath $runtimeDir -Recurse -File -Force)).Count) files from the release asset"

    $receipt = [ordered]@{
      tag              = $pin.tag
      repo             = $pin.repo
      version          = $pin.version
      tarballUrl       = $pin.tarballUrl
      tarballSha256    = $tarballSha
      runtimeUrl       = $pin.runtimeUrl
      runtimeZip       = $pin.runtimeZip
      workerSha256     = $pin.workerSha256
      stagedAt         = (Get-Date).ToString('o')
      stagedBy         = $MyInvocation.MyCommand.Path
    }
    $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $staging '.source.json') -Encoding utf8
    Say "  assembled: $staging"
  } finally {
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

# --- 5. verify the staging tree ----------------------------------------------
Say ''
Say '--- verify staging --------------------------------------------------'
$problems = Test-Staging $staging
if ($problems.Count -gt 0) {
  Say 'FAILED: the staged tree is not the official v0.3.1 build:'
  Show-Problems $problems
  exit 1
}
$workerPath = Join-Path $staging 'runtime\win32-x64\dsh-ops-worker.exe'
Say "  version   : $((Get-Content -LiteralPath (Join-Path $staging 'package.json') -Raw | ConvertFrom-Json).version)"
Say "  worker    : $((Get-FileHash -LiteralPath $workerPath -Algorithm SHA256).Hash.Substring(0, 16))... (pinned match)"
Say "  pristine  : no lib/trace.js, no instrumentation markers"
Say "  complete  : $($pin.files) tag files (including $($pin.nonAsciiDocs) non-ASCII doc names), runtime asset staged"

if ($StageOnly) {
  Say ''
  Say 'RESULT: staged and verified. -StageOnly was given, so the profile was not touched.'
  Say "  spec for a later install: file:$staging"
  exit 0
}

# --- 6. optional: move the whole node_modules aside ---------------------------
$renamedTo = $null
if ($NukeNodeModules) {
  Say ''
  Say '--- isolate node_modules --------------------------------------------'
  $modules = Join-Path $profileDir 'node_modules'
  if (Test-Path -LiteralPath $modules) {
    $renamedTo = "$modules.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Rename-Item -LiteralPath $modules -NewName (Split-Path -Leaf $renamedTo) -ErrorAction Stop
    Say "  moved aside: $renamedTo"
    Say '  a full reinstall needs registry access and re-resolves every dependency.'
  } else {
    Say '  no node_modules present; nothing to move aside.'
  }
}

# --- 7. install (delegated: it already owns CLI resolution, retry, rollback) --
Say ''
Say '--- install ---------------------------------------------------------'
$installer = Join-Path $thisDir 'phase0-install.ps1'
if (-not (Test-Path -LiteralPath $installer)) { Write-Host "FAILED: missing $installer"; exit 3 }
$label = "deploy-$version"
$installArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer,
  '-Source', $staging, '-Label', $label, '-ProfileName', $Profile, '-Force')
if ($Zero) { $installArgs += '-UninstallFirst' }
& powershell.exe @installArgs
$installExit = $LASTEXITCODE
Say "phase0-install exit=$installExit"

# The plugin's installer reports "installed but verification failed" separately from
# "installed nothing"; read its result instead of guessing from the exit code.
$resultFile = Join-Path $thisDir ".dsh-probe\$label.result.txt"
$installResult = $null
if (Test-Path -LiteralPath $resultFile) {
  try { $installResult = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json } catch { }
}
$tookEffect = ($installResult -ne $null -and $installResult.ok -eq $true)
$installedBytes = ($installResult -ne $null -and $installResult.installed -eq $true)

if (-not $tookEffect -and -not $installedBytes -and $renamedTo) {
  Say ''
  Say '--- restore node_modules --------------------------------------------'
  $modules = Join-Path $profileDir 'node_modules'
  if (Test-Path -LiteralPath $modules) {
    Remove-Item -LiteralPath $modules -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $modules) {
    Say "  WARNING: could not clear $modules (a process may hold it);"
    Say "  the previous tree is still at: $renamedTo"
  } else {
    Rename-Item -LiteralPath $renamedTo -NewName 'node_modules' -ErrorAction Stop
    Say '  restored the previous node_modules; the profile is back to where it was.'
    $renamedTo = $null
  }
} elseif (-not $tookEffect -and $installedBytes) {
  Say ''
  Say '  NOT restoring the old node_modules: the install DID take effect (bytes are in place),'
  Say '  only verification failed. Inspect the messages above before deciding what to keep.'
  if ($renamedTo) { Say "  the old tree is still at: $renamedTo" }
}

if (-not $tookEffect) {
  Say ''
  Say 'RESULT: FAILED -- dsh-ops was not deployed. Inspect the phase0 log and the captured pnpm output.'
  exit 1
}

# --- 8. verify the installed copy --------------------------------------------
Say ''
Say '--- verify installed -------------------------------------------------'
$installed = Join-Path $profileDir 'node_modules\dsh-ops'
$installedProblems = New-Object 'System.Collections.Generic.List[string]'
if (-not (Test-Path -LiteralPath $installed)) {
  $installedProblems.Add('node_modules/dsh-ops is missing')
} else {
  $installedVersion = (Get-Content -LiteralPath (Join-Path $installed 'package.json') -Raw | ConvertFrom-Json).version
  Say "  installed version : $installedVersion"
  if ($installedVersion -ne $pin.version) { $installedProblems.Add("installed $installedVersion, expected $($pin.version)") }
  $installedWorker = Join-Path $installed 'runtime\win32-x64\dsh-ops-worker.exe'
  if (-not (Test-Path -LiteralPath $installedWorker)) {
    $installedProblems.Add('installed copy has no native worker')
  } else {
    $installedHash = (Get-FileHash -LiteralPath $installedWorker -Algorithm SHA256).Hash
    Say "  installed worker  : $($installedHash.Substring(0, 16))... "
    if ($installedHash -ne $pin.workerSha256) { $installedProblems.Add('installed worker digest differs from the pinned release asset') }
  }
  if (Test-Path -LiteralPath (Join-Path $installed 'lib\trace.js')) {
    $installedProblems.Add('installed copy carries lib/trace.js -- that is the audit build, not the official one')
  }
}

if ($installedProblems.Count -gt 0) {
  Say 'FAILED: the installed copy is not the official v0.3.1 build:'
  Show-Problems $installedProblems
  exit 1
}

# --- 9. report ----------------------------------------------------------------
Say ''
Say '--- done ------------------------------------------------------------'
Say "  spec now : file:$staging"
Say "  receipt  : $(Join-Path $staging '.source.json')"
Say "  profile  : $profileDir"
if ($renamedTo) { Say "  old tree : $renamedTo  (delete it once you are satisfied)" }
Say ''
Say 'Rollback to whatever the profile had before:'
Say '  1. stop DSH'
Say "  2. copy .dsh-probe\backup-profile-<stamp>\{package.json,pnpm-lock.yaml} back into $profileDir"
Say "     (phase0-install wrote that backup just before it ran; <stamp> is in the $(Join-Path $PSScriptRoot '.dsh-probe') directory)"
Say "  3. run pnpm install --frozen-lockfile inside $profileDir, then start DSH"
Say ''
Say 'RESULT: ok -- official v0.3.1 deployed. Start DSH and confirm the tool surface.'
exit 0
