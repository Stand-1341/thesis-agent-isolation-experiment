# Read-only Cost Management query. Azure cost reporting may be delayed; an
# empty result is not proof that no billable usage has occurred.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path (Split-Path -Parent (Split-Path -Parent $projectRoot)) 'Use-ExperimentTools.ps1') 6>$null
$account = az account show -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $account.id) { throw 'Azure account unavailable' }
$request = @{type='ActualCost';timeframe='MonthToDate';dataset=@{granularity='None';aggregation=@{totalCost=@{name='PreTaxCost';function='Sum'}}}} | ConvertTo-Json -Depth 10 -Compress
$requestPath = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($requestPath, $request, [System.Text.UTF8Encoding]::new($false))
    $url = 'https://management.azure.com/subscriptions/' + $account.id + '/providers/Microsoft.CostManagement/query?api-version=2023-03-01'
    $response = az rest --method post --url $url --body "@$requestPath" -o json
    if ($LASTEXITCODE -ne 0) { throw 'Azure cost query failed' }
    $query = $response | ConvertFrom-Json
    if ($query.properties.nextLink) { throw 'Cost query pagination is not supported by this snapshot' }
    $columns = @($query.properties.columns | ForEach-Object { $_.name })
    if ($columns.Count -ne 2 -or $columns[0] -ne 'PreTaxCost' -or $columns[1] -ne 'Currency') { throw 'Unexpected cost query schema' }
    $rows = @($query.properties.rows | ForEach-Object {
        if ($_.Count -ne 2) { throw 'Unexpected cost row' }
        [pscustomobject]@{preTaxCost=$_[0];currency=$_[1]}
    })
    [pscustomobject]@{queriedAtUtc=[DateTime]::UtcNow.ToString('o');timeframe='MonthToDate';
        status=if ($rows.Count) {'reported_costs'} else {'no_reported_rows'};rows=$rows;
        limitation='Cost data can be delayed; this snapshot is not a spending cap or proof of zero usage.'} | ConvertTo-Json -Depth 5
} finally { Remove-Item -LiteralPath $requestPath -ErrorAction SilentlyContinue }
