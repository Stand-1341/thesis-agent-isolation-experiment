# Read-only usage snapshot. Usage and credit reporting can lag; this is not a cap.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path (Split-Path -Parent (Split-Path -Parent $projectRoot)) 'Use-ExperimentTools.ps1') 6>$null
$account = az account show -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $account.id -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Azure account unavailable' }
$url = 'https://management.azure.com/subscriptions/' + $account.id + '/providers/Microsoft.Consumption/usageDetails?api-version=2024-08-01'
$rows = @()
for ($page = 0; $url; $page++) {
    if ($page -ge 100 -or $url -notmatch '^https://management\.azure\.com/') { throw 'Unexpected usage pagination' }
    $response = az rest --method get --url $url -o json
    if ($LASTEXITCODE -ne 0) { throw 'Azure usage query failed' }
    $result = $response | ConvertFrom-Json
    if ($null -eq $result.value) { throw 'Unexpected usage response' }
    $rows += @($result.value | ForEach-Object { $_.properties })
    $url = $result.nextLink
}
if (@($rows | Where-Object { $_.billingCurrencyCode -ne 'USD' -or $null -eq $_.costInBillingCurrency }).Count) {
    throw 'Usage amounts are missing or use a currency other than USD'
}
$groups = @($rows | Group-Object consumedService | ForEach-Object {
    [pscustomobject]@{service=$_.Name; amountUsd=($_.Group | Measure-Object costInBillingCurrency -Sum).Sum; records=$_.Count}
})
[pscustomobject]@{queriedAtUtc=[DateTime]::UtcNow.ToString('o'); scope='all_returned_subscription_usage';
    records=$rows.Count; amountUsd=if ($rows.Count) {($rows | Measure-Object costInBillingCurrency -Sum).Sum} else {0};
    services=$groups; limitation='Usage reporting can lag; returned usage is not a final bill or remaining-credit balance.'} | ConvertTo-Json -Depth 4
