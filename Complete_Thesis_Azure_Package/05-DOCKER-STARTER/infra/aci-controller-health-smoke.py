"""Remote, non-counted ACI create/health/delete probe for the controller identity."""
import email.utils
import json
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

SUBSCRIPTION_ID = "__SUBSCRIPTION_ID__"
RESOURCE_GROUP = "__RESOURCE_GROUP__"
CONTROLLER_CLIENT_ID = "__CONTROLLER_CLIENT_ID__"
WORKLOAD_IDENTITY_ID = "__WORKLOAD_IDENTITY_ID__"
WORKLOAD_CLIENT_ID = "__WORKLOAD_CLIENT_ID__"
PULL_IDENTITY_ID = "__PULL_IDENTITY_ID__"
SUBNET_ID = "__SUBNET_ID__"
IMAGE = "__IMAGE_DIGEST_REFERENCE__"
REGISTRY_SERVER = "__REGISTRY_SERVER__"
BLOB_ENDPOINT = "__BLOB_ENDPOINT__"
LOCATION = "eastus"
API = "2023-05-01"


def json_request(url, method="GET", token=None, payload=None, timeout=20):
    headers = {}
    body = None
    if token:
        headers["Authorization"] = "Bearer " + token
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            result = json.loads(raw) if raw else {}
        except Exception:
            result = {}
        return error.code, result
    except Exception:
        return 0, {}


def managed_token(resource, client_id):
    query = urllib.parse.urlencode({
        "api-version": "2018-02-01", "resource": resource, "client_id": client_id
    })
    request = urllib.request.Request(
        "http://169.254.169.254/metadata/identity/oauth2/token?" + query,
        headers={"Metadata": "true"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.loads(response.read())
            token = body.get("access_token")
            return token if response.status == 200 and isinstance(token, str) else None
    except Exception:
        return None


def blob_request(url, method, token, body=None):
    headers = {
        "Authorization": "Bearer " + token,
        "x-ms-version": "2023-11-03",
        "x-ms-date": email.utils.formatdate(usegmt=True),
    }
    raw = None
    if body is not None:
        headers.update({"x-ms-blob-type": "BlockBlob", "Content-Type": "application/json", "If-None-Match": "*"})
        raw = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=raw, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return 0


def safe_error(body):
    code = body.get("error", {}).get("code", "") if isinstance(body, dict) else ""
    return code if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", code) else "unknown"


def main():
    results = {"armList": "FAIL", "create": "NOT_RUN", "health": "NOT_RUN",
               "blobSeed": "NOT_RUN", "blobIdentity": "NOT_RUN", "blobCleanup": "NOT_RUN", "delete": "NOT_RUN"}

    arm_token = managed_token("https://management.azure.com/", CONTROLLER_CLIENT_ID)
    if not arm_token:
        print("ACI_ARM_LIST=FAIL_TOKEN")
        print("ACI_CREATE=NOT_RUN")
        print("ACI_HEALTH=NOT_RUN")
        print("ACI_BLOB_SEED=NOT_RUN")
        print("ACI_BLOB_IDENTITY=NOT_RUN")
        print("ACI_BLOB_CLEANUP=NOT_RUN")
        print("ACI_DELETE=NOT_RUN")
        print("ACI_GROUP_NAME=none")
        print("PROBE_FINISHED=YES")
        return 2

    base = ("https://management.azure.com/subscriptions/" + SUBSCRIPTION_ID +
            "/resourceGroups/" + urllib.parse.quote(RESOURCE_GROUP, safe="") +
            "/providers/Microsoft.ContainerInstance/containerGroups")
    list_status, listing = json_request(base + "?api-version=" + API, token=arm_token)
    results["armList"] = "PASS_" + str(len(listing["value"])) if list_status == 200 and isinstance(listing.get("value"), list) else "FAIL_HTTP_" + str(list_status)

    name = "thesis-aci-health-mi-" + secrets.token_hex(10)
    url = base + "/" + name + "?api-version=" + API
    results["groupName"] = name
    workload_token = secrets.token_urlsafe(36)
    request_key = secrets.token_urlsafe(36)
    body = {
        "location": LOCATION,
        "identity": {"type": "UserAssigned", "userAssignedIdentities": {
            PULL_IDENTITY_ID: {}, WORKLOAD_IDENTITY_ID: {}
        }},
        "properties": {
            "containers": [{"name": "agent", "properties": {
                "image": IMAGE,
                "ports": [{"port": 8080, "protocol": "TCP"}],
                "resources": {"requests": {"cpu": 1, "memoryInGB": 1.5}},
                "environmentVariables": [
                    {"name": "PORT", "value": "8080"},
                    {"name": "AZURE_TOKEN_MODE", "value": "managed"},
                    {"name": "AZURE_CLIENT_ID", "value": WORKLOAD_CLIENT_ID},
                    {"name": "AZURE_BLOB_ENDPOINT", "value": BLOB_ENDPOINT},
                    {"name": "RESEARCH_URL", "value": "https://aci-health-smoke.invalid"},
                    {"name": "COLLECTOR_URL", "value": "https://aci-health-smoke.invalid"},
                    {"name": "WORKLOAD_TOKEN", "secureValue": workload_token},
                    {"name": "TRIAL_REQUEST_KEY", "secureValue": request_key},
                ],
            }}],
            "imageRegistryCredentials": [{"server": REGISTRY_SERVER, "identity": PULL_IDENTITY_ID}],
            "ipAddress": {"type": "Private", "ports": [{"port": 8080, "protocol": "TCP"}]},
            "osType": "Linux", "restartPolicy": "Never", "sku": "Standard",
            "subnetIds": [{"id": SUBNET_ID}], "dnsConfig": {"nameServers": ["168.63.129.16"]},
        },
    }

    created = False
    group_ip = None
    seeded_blob = False
    probe_id = "deployment-smoke-" + secrets.token_hex(10)
    marker = "SYNTHETIC-aci-smoke-" + secrets.token_hex(12)
    blob_url = BLOB_ENDPOINT.rstrip("/") + "/authorized-docs/" + probe_id + ".json"
    try:
        status, response_body = json_request(url, method="PUT", token=arm_token, payload=body, timeout=60)
        if status in (200, 201, 202):
            created = True
            results["create"] = "ACCEPTED"
            # VNet-injected ACI group allocation can take several minutes. Keep
            # polling long enough to capture a terminal Azure state instead of
            # mislabeling a slow Pending/Creating group as an application failure.
            deadline = time.time() + 600
            while time.time() < deadline:
                get_status, group = json_request(url, token=arm_token, timeout=30)
                properties = group.get("properties", {}) if isinstance(group, dict) else {}
                state = properties.get("provisioningState")
                if get_status == 200 and state == "Succeeded":
                    group_ip = properties.get("ipAddress", {}).get("ip")
                    if isinstance(group_ip, str) and re.fullmatch(r"10\.48\.13\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])", group_ip):
                        results["create"] = "PASS"
                    else:
                        results["create"] = "FAIL_PRIVATE_IP"
                    break
                if get_status not in (200, 202) or state in ("Failed", "Canceled", "Deleted"):
                    results["create"] = "FAIL_" + safe_error(group)
                    break
                time.sleep(5)
            if results["create"] == "ACCEPTED":
                results["create"] = "FAIL_TIMEOUT_" + str(state or "UNKNOWN")
        else:
            results["create"] = "FAIL_HTTP_" + str(status) + "_" + safe_error(response_body)

        if results["create"] == "PASS" and group_ip:
            health_url = "http://" + group_ip + ":8080/health"
            health_request = urllib.request.Request(health_url)
            direct_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            deadline = time.time() + 90
            while time.time() < deadline:
                try:
                    with direct_opener.open(health_request, timeout=10) as response:
                        health_body = json.loads(response.read())
                        if response.status == 200 and health_body.get("ready") is True:
                            results["health"] = "PASS"
                            break
                except Exception:
                    pass
                time.sleep(3)
            if results["health"] == "NOT_RUN":
                results["health"] = "FAIL_CONNECTIVITY"

        if results["health"] == "PASS":
            storage_token = managed_token("https://storage.azure.com/", CONTROLLER_CLIENT_ID)
            if not storage_token:
                results["blobSeed"] = "FAIL_CONTROLLER_TOKEN"
            else:
                seed_status = blob_request(blob_url, "PUT", storage_token, {"marker": marker})
                results["blobSeed"] = "PASS" if seed_status in (200, 201) else "FAIL_HTTP_" + str(seed_status)
                seeded_blob = seed_status in (200, 201)

            if seeded_blob:
                payload = json.dumps({"runId": probe_id, "scenario": "L1"}).encode("utf-8")
                request = urllib.request.Request(
                    "http://" + group_ip + ":8080/run", data=payload,
                    headers={"Content-Type": "application/json", "x-trial-key": request_key}, method="POST",
                )
                try:
                    with direct_opener.open(request, timeout=20) as response:
                        result = json.loads(response.read())
                        ok = (response.status == 200 and result.get("runId") == probe_id and
                              result.get("scenario") == "L1" and result.get("transportOk") is True and
                              result.get("status") == 200 and isinstance(result.get("body"), dict) and
                              result["body"].get("marker") == marker)
                        results["blobIdentity"] = "PASS_MARKER_READ" if ok else "FAIL_RESPONSE"
                except urllib.error.HTTPError as error:
                    results["blobIdentity"] = "FAIL_AGENT_HTTP_" + str(error.code)
                except Exception:
                    results["blobIdentity"] = "FAIL_CONNECTIVITY"
    finally:
        if created:
            delete_status, _ = json_request(url, method="DELETE", token=arm_token, timeout=60)
            if delete_status in (200, 202, 204, 404):
                deadline = time.time() + 180
                while time.time() < deadline:
                    get_status, _ = json_request(url, token=arm_token, timeout=30)
                    if get_status == 404:
                        results["delete"] = "PASS"
                        break
                    time.sleep(5)
                if results["delete"] == "NOT_RUN":
                    results["delete"] = "FAIL_TIMEOUT"
            else:
                results["delete"] = "FAIL_HTTP_" + str(delete_status)
        if seeded_blob:
            storage_token = managed_token("https://storage.azure.com/", CONTROLLER_CLIENT_ID)
            delete_status = blob_request(blob_url, "DELETE", storage_token) if storage_token else 0
            results["blobCleanup"] = "PASS" if delete_status in (202, 404) else "FAIL_HTTP_" + str(delete_status)

    print("ACI_ARM_LIST=" + results["armList"])
    print("ACI_CREATE=" + results["create"])
    print("ACI_HEALTH=" + results["health"])
    print("ACI_BLOB_SEED=" + results["blobSeed"])
    print("ACI_BLOB_IDENTITY=" + results["blobIdentity"])
    print("ACI_BLOB_CLEANUP=" + results["blobCleanup"])
    print("ACI_DELETE=" + results["delete"])
    print("ACI_GROUP_NAME=" + results["groupName"])
    print("PROBE_FINISHED=YES")
    return 0 if all(results[key] == "PASS" or (key == "armList" and results[key].startswith("PASS_")) or
                     (key == "blobIdentity" and results[key] == "PASS_MARKER_READ")
                     for key in ("armList", "create", "health", "delete", "blobSeed", "blobIdentity", "blobCleanup")) else 2


main()
