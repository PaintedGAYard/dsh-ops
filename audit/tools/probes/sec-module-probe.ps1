# Answers one question only: can this interpreter resolve the inbox Security
# commands, and from which module base? Writes JSON so the caller never has to
# parse PowerShell formatting.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Tag
)

$result = [ordered]@{
  tag                 = $Tag
  pid                 = $PID
  hostName            = $Host.Name
  version             = $PSVersionTable.PSVersion.ToString()
  psModulePathPresent = [bool]($null -ne (Get-Item -Path Env:PSModulePath -ErrorAction SilentlyContinue))
  psModulePath        = $env:PSModulePath
  candidateBases      = @()
  importError         = $null
  getAclError         = $null
  getAclResolved      = $false
}

try {
  $found = @(Get-Module -ListAvailable -Name Microsoft.PowerShell.Security -ErrorAction Stop)
  $result.candidateBases = @($found | ForEach-Object { $_.ModuleBase })
} catch {
  $result.importError = "LIST: $($_.Exception.GetType().Name): $($_.Exception.Message)"
}

if ($result.importError -eq $null) {
  try {
    Import-Module -Name Microsoft.PowerShell.Security -ErrorAction Stop
  } catch {
    $result.importError = "IMPORT: $($_.Exception.GetType().Name): $($_.Exception.Message)"
  }
}

try {
  $cmd = Get-Command -Name Get-Acl -ErrorAction Stop
  $result.getAclResolved = $true
  $result.candidateBases += @("GetAclSource=" + $cmd.Source)
} catch {
  $result.getAclError = "$($_.Exception.GetType().Name): $($_.Exception.Message)"
}

$result | ConvertTo-Json -Compress -Depth 4 | Out-File -FilePath $Out -Encoding utf8 -Force
exit 0
