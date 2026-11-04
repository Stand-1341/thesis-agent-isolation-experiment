[CmdletBinding()]
param(
  [string]$SubscriptionId = 'dddc5a29-1701-44ad-b367-50b466089d4b',
  [string]$ResourceGroup = 'RG-THESIS-RESEARCH-PILOT-EUS',
  [string]$Location = 'eastus',
  [string]$VnetName = 'vnet-thesis-pilot-eus',
  [string]$SubnetName = 'aci-experiment',
  [string]$ControllerVmName = 'thesis-controller-pilot',
  [string]$RegistryServer = 'thesisacr74a95224.azurecr.io',
  [string]$PullIdentityName = 'id-thesis-acr-pull',
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9-]+\.azurecr\.io/.+@sha256:[a-fA-F0-9]{64}$')]
  [string]$ImageDigestReference,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9_.-]{3,90}$')]
  [string]$WorkloadIdentityName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-AzCapture {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $output = & az @Arguments --only-show-errors 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw 'Azure CLI operation failed; diagnostic output was suppressed.'
  }
  return ($output -join "`n")
}

function Invoke-AzJson {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $raw = Invoke-AzCapture -Arguments $Arguments
  try { return ($raw | ConvertFrom-Json -ErrorAction Stop) }
  catch { throw 'Azure CLI returned an invalid response; diagnostic output was suppressed.' }
}

function New-RandomCredential {
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Write-PrivateParameterFile {
  param([Parameter(Mandatory = $true)][string]$Directory, [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Parameters)

  if ($env:OS -eq 'Windows_NT') {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $currentUser, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Directory -AclObject $acl
  } else {
    & chmod 700 -- $Directory
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect temporary parameter directory.' }
  }

  $json = $Parameters | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
  if ($env:OS -ne 'Windows_NT') {
    & chmod 600 -- $Path
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect temporary parameter file.' }
  }
}

function Get-ContainerSnapshot {
  param([string]$Name)
  $arguments = @(
    'container','show','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,'--name',$Name,
    '--query','{provisioningState:provisioningState,containerState:containers[0].instanceView.currentState.state,privateIp:ipAddress.ip}','-o','json')
  $output = & az @arguments --only-show-errors 2>&1
  if ($LASTEXITCODE -ne 0) {
    $diagnostic = $output -join "`n"
    if ($diagnostic -match '(?i)ResourceNotFound|ContainerGroupNotFound|was not found|could not be found') { return $null }
    throw 'Could not determine ACI container-group state; cleanup status is unknown.'
  }
  try { return ($output -join "`n" | ConvertFrom-Json -ErrorAction Stop) }
  catch { throw 'Azure CLI returned an invalid ACI group snapshot.' }
}

$template = Join-Path $PSScriptRoot 'aci-agent-group-pilot.bicep'
if (-not (Test-Path -LiteralPath $template -PathType Leaf)) { throw 'ACI health-smoke template is missing.' }
if (-not $ImageDigestReference.StartsWith("$RegistryServer/", [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The digest-pinned image must come from the configured Azure Container Registry.'
}

$groupSuffix = [Guid]::NewGuid().ToString('N').Substring(0, 24)
$groupName = "thesis-aci-health-$groupSuffix"
$deploymentName = "aci-health-$groupSuffix"
$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "aci-health-$groupSuffix"
$parameterFile = Join-Path $tempDirectory 'parameters.json'
$groupMayExist = $false
$cleanupConfirmed = $false
$healthPassed = $false
$privateIp = $null
$failure = $null
$failureStage = 'preflight'

try {
  New-Item -ItemType Directory -Path $tempDirectory -ErrorAction Stop | Out-Null

  $subnet = Invoke-AzJson -Arguments @(
    'network','vnet','subnet','show','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,
    '--vnet-name',$VnetName,'--name',$SubnetName,'--query','{id:id,nat:natGateway.id,routeTable:routeTable.id,delegations:delegations[].serviceName}','-o','json')
  if (-not $subnet.id -or -not $subnet.nat -or $subnet.routeTable -or
      @($subnet.delegations) -notcontains 'Microsoft.ContainerInstance/containerGroups') {
    throw 'ACI subnet preflight failed: expected a NAT-attached dedicated subnet with no route table.'
  }

  $pullIdentity = Invoke-AzJson -Arguments @(
    'identity','show','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,'--name',$PullIdentityName,
    '--query','{id:id,clientId:clientId}','-o','json')
  $workloadIdentity = Invoke-AzJson -Arguments @(
    'identity','show','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,'--name',$WorkloadIdentityName,
    '--query','{id:id,clientId:clientId}','-o','json')
  if (-not $pullIdentity.id -or -not $workloadIdentity.id -or
      $pullIdentity.id -eq $workloadIdentity.id -or -not $workloadIdentity.clientId) {
    throw 'ACI identity preflight failed: separate ACR-pull and workload identities are required.'
  }
  $controllerState = Invoke-AzCapture -Arguments @(
    'vm','get-instance-view','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,'--name',$ControllerVmName,
    '--query',"instanceView.statuses[?starts_with(code, 'PowerState/')].displayStatus | [0]",'-o','tsv')
  if ($controllerState.Trim() -ne 'VM running') { throw 'Controller VM must be running for the private health probe.' }

  $workloadToken = New-RandomCredential
  $trialRequestKey = New-RandomCredential
  if ($workloadToken -eq $trialRequestKey) { throw 'Disposable credential generation failed.' }

  # Reserved .invalid research endpoints cannot act on fixtures. The Blob URL
  # must pass the app's Azure Storage hostname validation; this random account
  # name has no credentials or configured account and is never contacted by /health.
  $dummyEndpoint = 'https://aci-health-smoke.invalid'
  $dummyBlobEndpoint = 'https://acihealth' + [Guid]::NewGuid().ToString('N').Substring(0, 15) + '.blob.core.windows.net/'
  $parameterObject = @{
    '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
    contentVersion = '1.0.0.0'
    parameters = @{
      location = @{ value = $Location }
      containerGroupName = @{ value = $groupName }
      subnetId = @{ value = $subnet.id }
      imageDigestReference = @{ value = $ImageDigestReference }
      registryServer = @{ value = $RegistryServer }
      pullIdentityId = @{ value = $pullIdentity.id }
      workloadIdentityId = @{ value = $workloadIdentity.id }
      workloadIdentityClientId = @{ value = $workloadIdentity.clientId }
      researchUrl = @{ value = $dummyEndpoint }
      collectorUrl = @{ value = $dummyEndpoint }
      blobEndpoint = @{ value = $dummyBlobEndpoint }
      workloadToken = @{ value = $workloadToken }
      trialRequestKey = @{ value = $trialRequestKey }
      cpu = @{ value = 1 }
      memoryInGiB = @{ value = '1.5' }
      dnsServer = @{ value = '168.63.129.16' }
    }
  }
  Write-PrivateParameterFile -Directory $tempDirectory -Path $parameterFile -Parameters $parameterObject
  $parameterObject = $null
  $workloadToken = $null
  $trialRequestKey = $null

  # Mark before calling ARM because a failed/ambiguous deployment can still create the group.
  $failureStage = 'deploy'
  $groupMayExist = $true
  $deployment = Invoke-AzJson -Arguments @(
    'deployment','group','create','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,
    '--name',$deploymentName,'--template-file',$template,'--parameters',"@$parameterFile",'-o','json')

  $deadline = [DateTime]::UtcNow.AddMinutes(12)
  do {
    $snapshot = Get-ContainerSnapshot -Name $groupName
    if ($null -eq $snapshot) { throw 'ACI group was not found after deployment.' }
    $privateIp = [string]$snapshot.privateIp
    if ($snapshot.provisioningState -eq 'Failed' -or $snapshot.containerState -eq 'Terminated') {
      throw 'ACI group failed to reach a running state.'
    }
    if ($snapshot.provisioningState -eq 'Succeeded' -and $snapshot.containerState -eq 'Running' -and
        $privateIp -match '^10\.48\.13\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$') { break }
    Start-Sleep -Seconds 8
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($snapshot.provisioningState -ne 'Succeeded' -or $snapshot.containerState -ne 'Running' -or
      $privateIp -notmatch '^10\.48\.13\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$') {
    throw 'ACI group did not become healthy before the startup deadline.'
  }

  $failureStage = 'private-health-probe'
  $probeScript = 'echo ACI_HEALTH_PROBE_BEGIN; curl --silent --show-error --connect-timeout 5 --max-time 10 http://__ACI_PRIVATE_IP__:8080/health; echo ACI_HEALTH_CURL_EXIT=$?'
  $probeScript = $probeScript.Replace('__ACI_PRIVATE_IP__', $privateIp)
  $probe = Invoke-AzJson -Arguments @(
    'vm','run-command','invoke','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,
    '--name',$ControllerVmName,'--command-id','RunShellScript','--scripts',$probeScript,'-o','json')
  $probeText = (@($probe.value) | ForEach-Object { [string]$_.message }) -join "`n"
  if ($probeText -notmatch 'ACI_HEALTH_PROBE_BEGIN' -or $probeText -notmatch 'ACI_HEALTH_CURL_EXIT=0' -or
      $probeText -notmatch '"ready":true') {
    if ($probeText -match 'ACI_HEALTH_CURL_EXIT=(\d+)') { $failureStage = "private-health-curl-$($matches[1])" }
    elseif ($probeText -match 'ACI_HEALTH_PROBE_BEGIN') { $failureStage = 'private-health-invalid-response' }
    else { $failureStage = 'private-health-no-result' }
    throw 'Controller-side private health probe did not confirm readiness.'
  }
  $healthPassed = $true
  $failureStage = 'complete'
} catch {
  $failure = $_
} finally {
  if ($groupMayExist) {
    try {
      $existing = $true
      $current = Get-ContainerSnapshot -Name $groupName
      if ($null -eq $current) { $existing = $false }
      if ($existing) {
        $null = Invoke-AzCapture -Arguments @(
          'container','delete','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,'--name',$groupName,'--yes')
        $deleteDeadline = [DateTime]::UtcNow.AddMinutes(8)
        do {
          $current = Get-ContainerSnapshot -Name $groupName
          if ($null -eq $current) { $cleanupConfirmed = $true; break }
          Start-Sleep -Seconds 5
        } while ([DateTime]::UtcNow -lt $deleteDeadline)
      } else { $cleanupConfirmed = $true }
    } catch { $cleanupConfirmed = $false }
  } else { $cleanupConfirmed = $true }

  if (Test-Path -LiteralPath $tempDirectory) {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
  $parameterFile = $null
  $workloadToken = $null
  $trialRequestKey = $null
}

if (-not $cleanupConfirmed) {
  Write-Output ("ACI_HEALTH_SMOKE status=cleanup_failed group={0} health={1}" -f $groupName,([string]$healthPassed).ToLowerInvariant())
  throw 'ACI health smoke could not confirm cleanup; inspect the named group before another attempt.'
}
if ($failure) {
  Write-Output ("ACI_HEALTH_SMOKE status=failed stage={0} group={1} cleanup=confirmed" -f $failureStage,$groupName)
  throw 'ACI health smoke failed; diagnostic details were suppressed to avoid exposing sensitive values.'
}
Write-Output ("ACI_HEALTH_SMOKE status=passed group={0} health=passed cleanup=confirmed private_ip={1} trials=0" -f $groupName,$privateIp)
