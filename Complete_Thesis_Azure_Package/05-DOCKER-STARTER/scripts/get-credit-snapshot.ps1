param(
    [Parameter(Mandatory=$true)][string]$BillingAccountName,
    [Parameter(Mandatory=$true)][string]$BillingProfileName
)
$ErrorActionPreference = 'Stop'
if ($BillingAccountName -notmatch '^[A-Za-z0-9:_-]+$' -or $BillingProfileName -notmatch '^[A-Za-z0-9_-]+$') {
    throw 'Invalid billing account or profile identifier.'
}
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path (Split-Path -Parent (Split-Path -Parent $projectRoot)) 'Use-ExperimentTools.ps1') 6>$null
$billingAccountPath = [Uri]::EscapeDataString($BillingAccountName)
$billingProfilePath = [Uri]::EscapeDataString($BillingProfileName)
$url = "https://management.azure.com/providers/Microsoft.Billing/billingAccounts/$billingAccountPath/billingProfiles/$billingProfilePath/providers/Microsoft.Consumption/credits/balanceSummary?api-version=2024-08-01"
$response = az rest --method get --url $url -o json
if ($LASTEXITCODE -ne 0) { throw 'Azure credit query failed.' }
$properties = ($response | ConvertFrom-Json).properties
if (-not $properties.balanceSummary.currentBalance.currency -or $null -eq $properties.balanceSummary.currentBalance.value) {
    throw 'Unexpected Azure credit response.'
}
[pscustomobject]@{
    queriedAtUtc = [DateTime]::UtcNow.ToString('o')
    currentBalance = $properties.balanceSummary.currentBalance
    estimatedBalance = $properties.balanceSummary.estimatedBalance
    pendingEligibleCharges = $properties.pendingEligibleCharges
    expiredCredit = $properties.expiredCredit
    isEstimated = $properties.isEstimatedBalance
    limitation = 'Reported balances and charges may lag metered usage.'
} | ConvertTo-Json -Depth 5
