"""List Key Vault secret names only through the controller managed identity."""
import json
import urllib.error
import urllib.parse
import urllib.request

VAULT_URL = "https://thesisexpkv20261103.vault.azure.net"
CLIENT_ID = "011128da-854a-43e6-ba75-461be5958b1b"


def get_json(url, token=None):
    headers = {"Metadata": "true"} if token is None else {"Authorization": "Bearer " + token}
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


try:
    params = urllib.parse.urlencode({
        "api-version": "2018-02-01",
        "resource": "https://vault.azure.net",
        "client_id": CLIENT_ID,
    })
    identity = get_json("http://169.254.169.254/metadata/identity/oauth2/token?" + params)
    token = identity.get("access_token")
    if not isinstance(token, str) or not token:
        print(json.dumps({"error": "managed_identity_token_missing"}))
        raise SystemExit(2)
    url = VAULT_URL + "/secrets?api-version=7.4"
    names = []
    while url:
        result = get_json(url, token)
        names.extend(item.get("id", "").rsplit("/", 1)[-1] for item in result.get("value", []))
        url = result.get("nextLink")
    print(json.dumps({"secretNames": sorted(name for name in names if name)}, separators=(",", ":")))
except urllib.error.HTTPError as error:
    print(json.dumps({"error": "keyvault_http_error", "status": error.code}))
    raise SystemExit(3)
except Exception as error:
    print(json.dumps({"error": type(error).__name__}))
    raise SystemExit(4)
