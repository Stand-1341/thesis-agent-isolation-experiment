[CmdletBinding()]
param(
  [string]$SubscriptionId = 'dddc5a29-1701-44ad-b367-50b466089d4b',
  [string]$ResourceGroup = 'RG-THESIS-RESEARCH-PILOT-EUS',
  [string]$VmName = 'thesis-controller-pilot',
  [string]$ControllerIdentityClientId = '011128da-854a-43e6-ba75-461be5958b1b',
  [string]$KeyVaultUri = 'https://thesisexpkv20261103.vault.azure.net',
  [string]$KeyVaultSecretName = 'aci-p1-controller-key'
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
  $value = Invoke-AzText -Arguments @(
    'vm','get-instance-view','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,
    '--name',$VmName,'--query',"instanceView.statuses[?starts_with(code, 'PowerState/')].code | [0]",'-o','tsv')
  return $value.Trim()
}

$startedByThisScript = $false
$deallocationConfirmed = $false
$initialPowerState = $null
$kvResult = 'NOT_RUN'
$armResult = 'NOT_RUN'
$runtimeResult = 'NOT_RUN'
$python = @'
import json
import urllib.error
import urllib.parse
import urllib.request

CLIENT_ID = '__CONTROLLER_CLIENT_ID__'
SUBSCRIPTION_ID = '__SUBSCRIPTION_ID__'
RESOURCE_GROUP = '__RESOURCE_GROUP__'
KEY_VAULT_URI = '__KEY_VAULT_URI__'
KEY_VAULT_SECRET_NAME = '__KEY_VAULT_SECRET_NAME__'

def get_json(url, token=None, metadata=False):
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if metadata:
        headers['Metadata'] = 'true'
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, {}
    except Exception:
        return 0, {}

def get_token(resource):
    query = urllib.parse.urlencode({'api-version': '2018-02-01', 'resource': resource, 'client_id': CLIENT_ID})
    status, body = get_json('http://169.254.169.254/metadata/identity/oauth2/token?' + query, metadata=True)
    return body.get('access_token') if status == 200 else None

try:
    token = get_token('https://vault.azure.net')
    status, body = get_json(KEY_VAULT_URI + '/secrets/' + KEY_VAULT_SECRET_NAME + '?api-version=7.4', token)
    print('KV_SECRET_READ=' + ('PASS' if status == 200 and isinstance(body.get('value'), str) else 'FAIL_HTTP_' + str(status)))
except Exception:
    print('KV_SECRET_READ=FAIL_PROBE_ERROR')

try:
    token = get_token('https://management.azure.com/')
    url = ('https://management.azure.com/subscriptions/' + SUBSCRIPTION_ID + '/resourceGroups/' +
           urllib.parse.quote(RESOURCE_GROUP, safe='') + '/providers/Microsoft.ContainerInstance/containerGroups?api-version=2023-05-01')
    status, body = get_json(url, token)
    print('ACI_ARM_LIST=' + ('PASS_' + str(len(body['value'])) if status == 200 and isinstance(body.get('value'), list) else 'FAIL_HTTP_' + str(status)))
except Exception:
    print('ACI_ARM_LIST=FAIL_PROBE_ERROR')
print('PROBE_FINISHED=YES')
'@
$python = $python.Replace('__CONTROLLER_CLIENT_ID__', $ControllerIdentityClientId)
$python = $python.Replace('__KEY_VAULT_URI__', $KeyVaultUri.TrimEnd('/'))
$python = $python.Replace('__KEY_VAULT_SECRET_NAME__', $KeyVaultSecretName)
$python = $python.Replace('__SUBSCRIPTION_ID__', $SubscriptionId)
$python = $python.Replace('__RESOURCE_GROUP__', $ResourceGroup)
$encodedPython = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($python))
$remoteScript = "if command -v python3 >/dev/null 2>&1; then printf '%s' '$encodedPython' | base64 -d | python3 -; else echo RUNTIME=FAIL_PYTHON_MISSING; fi"

try {
  $state = Get-PowerState
  $initialPowerState = $state
  if ($state -ne 'PowerState/running') {
    $null = Invoke-AzText -Arguments @('vm','start','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,'--name',$VmName)
    $startedByThisScript = $true
    $deadline = (Get-Date).AddMinutes(5)
    do {
      Start-Sleep -Seconds 5
      $state = Get-PowerState
    } while ($state -ne 'PowerState/running' -and (Get-Date) -lt $deadline)
    if ($state -ne 'PowerState/running') { throw 'Controller VM did not start before timeout.' }
  }

  $raw = & az vm run-command invoke --subscription $SubscriptionId --resource-group $ResourceGroup --name $VmName `
    --command-id RunShellScript --scripts $remoteScript -o json --only-show-errors 2>$null
  if ($LASTEXITCODE -ne 0) {
    $kvResult = 'RUN_COMMAND_FAILED'
    $armResult = 'RUN_COMMAND_FAILED'
    $runtimeResult = 'RUN_COMMAND_FAILED'
  } else {
    try {
      $result = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop
      $messages = (@($result.value) | ForEach-Object { [string]$_.message }) -join "`n"
      if ($messages -match 'KV_SECRET_READ=(PASS|FAIL_[A-Za-z0-9_]+)') { $kvResult = $matches[1] } else { $kvResult = 'NO_MARKER' }
      if ($messages -match 'ACI_ARM_LIST=(PASS_\d+|FAIL_[A-Za-z0-9_]+)') { $armResult = $matches[1] } else { $armResult = 'NO_MARKER' }
      if ($messages -match 'RUNTIME=(FAIL_[A-Za-z0-9_]+)') { $runtimeResult = $matches[1] }
      elseif ($messages -match 'PROBE_FINISHED=YES') { $runtimeResult = 'PASS' }
      else { $runtimeResult = 'NO_MARKER' }
    } catch {
      $kvResult = 'INVALID_RUN_COMMAND_RESPONSE'
      $armResult = 'INVALID_RUN_COMMAND_RESPONSE'
      $runtimeResult = 'INVALID_RUN_COMMAND_RESPONSE'
    }
  }
} finally {
  if ($startedByThisScript) {
    $null = Invoke-AzText -Arguments @('vm','deallocate','--subscription',$SubscriptionId,'--resource-group',$ResourceGroup,'--name',$VmName)
    $deadline = (Get-Date).AddMinutes(3)
    do {
      Start-Sleep -Seconds 5
      $state = Get-PowerState
      if ($state -eq 'PowerState/deallocated') { $deallocationConfirmed = $true; break }
    } while ((Get-Date) -lt $deadline)
  } else {
    $deallocationConfirmed = (Get-PowerState) -eq $initialPowerState
  }
}

[pscustomobject]@{
  keyVaultSecretRead = $kvResult
  aciArmList = $armResult
  nodeRuntime = $runtimeResult
  controllerVmReturnedToInitialState = $deallocationConfirmed
  controllerVmDeallocated = (Get-PowerState) -eq 'PowerState/deallocated'
  secretValuesDisplayed = $false
} | ConvertTo-Json -Compress

if (-not $deallocationConfirmed) { throw 'Controller VM state was not restored.' }
if ($kvResult -notlike 'PASS' -or $armResult -notlike 'PASS_*') { exit 2 }
