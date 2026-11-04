[CmdletBinding()]
param(
  [string]$SubscriptionId = 'dddc5a29-1701-44ad-b367-50b466089d4b',
  [string]$ResourceGroup = 'RG-THESIS-RESEARCH-PILOT-EUS',
  [string]$VmName = 'thesis-controller-pilot',
  [string]$ControllerIdentityClientId = '011128da-854a-43e6-ba75-461be5958b1b',
  [string]$WorkloadIdentityId = '/subscriptions/dddc5a29-1701-44ad-b367-50b466089d4b/resourceGroups/rg-thesis-research-pilot-eus/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-thesis-aci-p1',
  [string]$WorkloadClientId = '01d6565e-8239-4001-9215-6936c52d2517',
  [string]$PullIdentityId = '/subscriptions/dddc5a29-1701-44ad-b367-50b466089d4b/resourceGroups/rg-thesis-research-pilot-eus/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-thesis-acr-pull',
  [string]$SubnetId = '/subscriptions/dddc5a29-1701-44ad-b367-50b466089d4b/resourceGroups/RG-THESIS-RESEARCH-PILOT-EUS/providers/Microsoft.Network/virtualNetworks/vnet-thesis-pilot-eus/subnets/aci-experiment',
  [string]$RegistryServer = 'thesisacr74a95224.azurecr.io',
  [string]$ImageDigestReference = 'thesisacr74a95224.azurecr.io/thesis-agent-aci-pilot@sha256:2047e949a67adee221ab159b4003ac86d811215e489f2755128a4a8aab844d6b'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-AzText {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $output = & az @Arguments --only-show-errors 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Azure CLI operation failed.' }
  return ($output -join "`n")
}

function Get-PowerState {
  $value = Invoke-AzText -Arguments @('vm','get-instance-view','--subscription',$SubscriptionId,
    '--resource-group',$ResourceGroup,'--name',$VmName,'--query',
    "instanceView.statuses[?starts_with(code, 'PowerState/')].code | [0]",'-o','tsv')
  return $value.Trim()
}

$pythonPath = Join-Path $PSScriptRoot 'aci-controller-health-smoke.py'
$python = [System.IO.File]::ReadAllText($pythonPath)
$replacements = @{
  '__SUBSCRIPTION_ID__' = $SubscriptionId
  '__RESOURCE_GROUP__' = $ResourceGroup
  '__CONTROLLER_CLIENT_ID__' = $ControllerIdentityClientId
  '__WORKLOAD_IDENTITY_ID__' = $WorkloadIdentityId
  '__WORKLOAD_CLIENT_ID__' = $WorkloadClientId
  '__PULL_IDENTITY_ID__' = $PullIdentityId
  '__SUBNET_ID__' = $SubnetId
  '__REGISTRY_SERVER__' = $RegistryServer
  '__IMAGE_DIGEST_REFERENCE__' = $ImageDigestReference
}
foreach ($key in $replacements.Keys) { $python = $python.Replace($key, $replacements[$key]) }
if ($python -match '__[A-Z0-9_]+__') { throw 'Health-smoke configuration has unresolved placeholders.' }
$sourceBytes = [Text.Encoding]::UTF8.GetBytes($python)
$compressedBuffer = [System.IO.MemoryStream]::new()
$compressor = [System.IO.Compression.GZipStream]::new($compressedBuffer,[System.IO.Compression.CompressionMode]::Compress)
$compressor.Write($sourceBytes,0,$sourceBytes.Length)
$compressor.Dispose()
$encodedPython = [Convert]::ToBase64String($compressedBuffer.ToArray())
$compressedBuffer.Dispose()
$remoteScript = "if command -v python3 >/dev/null 2>&1; then printf '%s' '$encodedPython' | base64 -d | gzip -d | python3 -; else echo RUNTIME=FAIL_PYTHON_MISSING; fi"
if ($remoteScript.Length -gt 16384) { throw 'Compressed health-smoke script exceeds the local safety limit.' }

$startedByThisScript = $false
$vmStopped = $false
$vmStateRestored = $false
$initialPowerState = $null
$groupName = $null
$outcomes = @{}
try {
  $state = Get-PowerState
  $initialPowerState = $state
  if ($state -ne 'PowerState/running') {
    $null = Invoke-AzText -Arguments @('vm','start','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,'--name',$VmName)
    $startedByThisScript = $true
    $deadline = (Get-Date).AddMinutes(5)
    do { Start-Sleep -Seconds 5; $state = Get-PowerState } while ($state -ne 'PowerState/running' -and (Get-Date) -lt $deadline)
    if ($state -ne 'PowerState/running') { throw 'Controller VM startup timed out.' }
  }

  $raw = & az vm run-command invoke --subscription $SubscriptionId --resource-group $ResourceGroup --name $VmName `
    --command-id RunShellScript --scripts $remoteScript -o json --only-show-errors 2>$null
  if ($LASTEXITCODE -ne 0 -and -not $raw) { throw 'Controller-managed ACI health smoke failed to return.' }
  $result = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop
  $messages = (@($result.value) | ForEach-Object { [string]$_.message }) -join "`n"
  foreach ($key in @('ACI_ARM_LIST','ACI_CREATE','ACI_HEALTH','ACI_DELETE','ACI_GROUP_NAME')) {
    if ($messages -match "(?m)^$key=([^\r\n]+)") { $outcomes[$key] = $matches[1] }
  }
} finally {
  if ($startedByThisScript) {
    $null = Invoke-AzText -Arguments @('vm','deallocate','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,'--name',$VmName)
    $deadline = (Get-Date).AddMinutes(3)
    do { Start-Sleep -Seconds 5; $state = Get-PowerState; if ($state -eq 'PowerState/deallocated') { $vmStopped = $true; break } } while ((Get-Date) -lt $deadline)
    $vmStateRestored = $vmStopped
  } else {
    $state = Get-PowerState
    $vmStopped = $state -eq 'PowerState/deallocated'
    $vmStateRestored = $state -eq $initialPowerState
  }
}

$groupName = $outcomes['ACI_GROUP_NAME']
if ($groupName -and $groupName -ne 'none') {
  $aciGroupState = & az container show --subscription $SubscriptionId --resource-group $ResourceGroup --name $groupName `
    --query '{name:name,state:provisioningState}' -o json --only-show-errors 2>$null
  if ($LASTEXITCODE -eq 0) {
    & az container delete --subscription $SubscriptionId --resource-group $ResourceGroup --name $groupName --yes --only-show-errors 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Health smoke group cleanup failed; inspect its reported name.' }
    $outcomes['ACI_DELETE'] = 'FAILED_BY_CONTROLLER_CLEANED_BY_CLI'
  }
}

[pscustomobject]@{
  aciArmList = $outcomes['ACI_ARM_LIST']
  groupCreate = $outcomes['ACI_CREATE']
  privateHealth = $outcomes['ACI_HEALTH']
  groupDelete = $outcomes['ACI_DELETE']
  groupName = $groupName
  controllerVmDeallocated = $vmStopped
  controllerVmReturnedToInitialState = $vmStateRestored
  countedAsStudyTrials = $false
  trialRowsRun = 0
  secretValuesDisplayed = $false
} | ConvertTo-Json -Compress

if (-not $vmStateRestored) { throw 'Controller VM state was not restored.' }
if ($outcomes['ACI_CREATE'] -ne 'PASS' -or $outcomes['ACI_HEALTH'] -ne 'PASS' -or $outcomes['ACI_DELETE'] -ne 'PASS') { exit 2 }
