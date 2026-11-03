<#
.SYNOPSIS
Prompts for the six Functions P1 pilot credentials without echoing or logging
them, then writes them directly to the pilot Key Vault using the signed-in
Azure CLI identity.

.NOTES
Run from an authenticated PowerShell session on the temporarily allowlisted
client address. Secret values are never accepted as arguments, written to
files, or printed. The Azure CLI token and values exist only in process memory.
#>
[CmdletBinding()]
param(
  [string]$VaultName = 'thesisexpkv20261103'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($VaultName -notmatch '^[a-zA-Z0-9-]{3,24}$') {
  throw 'Invalid Key Vault name.'
}

$secrets = @(
  @{ Name = 'functions-p1-controller-key'; Source = 'Function App setting TRIAL_REQUEST_KEY' },
  @{ Name = 'functions-p1-function-key'; Source = 'HTTP function key for thesisRun' },
  @{ Name = 'resource-admin-key'; Source = 'Research host ADMIN_TOKEN in /etc/thesis-research/resource.env' },
  @{ Name = 'collector-admin-key'; Source = 'Collector host ADMIN_TOKEN in /etc/thesis-research/collector.env' },
  @{ Name = 'functions-p1-resource-verifier-key'; Source = 'Research host VERIFIER_TOKEN in /etc/thesis-research/resource.env' },
  @{ Name = 'functions-p1-collector-verifier-key'; Source = 'Collector host VERIFIER_TOKEN in /etc/thesis-research/collector.env' }
)

$token = $null
$headers = $null
try {
  $token = (& az account get-access-token --resource 'https://vault.azure.net' --query accessToken -o tsv 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
    throw 'Azure CLI could not obtain a Key Vault token. Sign in with az login and retry.'
  }

  $headers = @{ Authorization = "Bearer $token" }
  foreach ($secret in $secrets) {
    $secureValue = Read-Host -Prompt "Enter $($secret.Name) ($($secret.Source))" -AsSecureString
    if ($secureValue.Length -lt 1) {
      $secureValue.Dispose()
      throw "Empty value refused for $($secret.Name). No trial was started."
    }

    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    $value = $null
    try {
      $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
      if ($value -match '[\r\n]') { throw "Invalid value format for $($secret.Name)." }
      $body = @{ value = $value } | ConvertTo-Json -Compress
      $uri = "https://$VaultName.vault.azure.net/secrets/$([Uri]::EscapeDataString($secret.Name))?api-version=7.4"
      $null = Invoke-RestMethod -Method Put -Uri $uri -Headers $headers `
        -ContentType 'application/json' -Body $body -TimeoutSec 30
      Write-Host "Saved secret: $($secret.Name)"
    }
    catch {
      throw "Could not save $($secret.Name). Check Key Vault role propagation, network access, and the entered value; no value was printed."
    }
    finally {
      if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      }
      $value = $null
      $body = $null
      $secureValue.Dispose()
    }
  }

  Write-Host 'All six pilot secrets were submitted. Their values were not displayed.'
}
finally {
  $token = $null
  if ($headers) { $headers.Clear() }
}
