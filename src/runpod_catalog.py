import json
import os
import urllib.parse
import urllib.request

query = """
query {
  gpuTypes {
    id displayName memoryInGb
    lowestPrice(input: {gpuCount: 1, secureCloud: true}) {
      stockStatus uninterruptablePrice availableGpuCounts
    }
  }
}
"""

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

try:
    key = os.environ["RUNPOD_API_KEY_DEV_READONLY"].strip()
    if not key:
        raise ValueError("missing key")
    url = "https://api.runpod.io/graphql?" + urllib.parse.urlencode({"api_key": key})
    request = urllib.request.Request(
        url, data=json.dumps({"query": query}).encode(),
        headers={"Content-Type": "application/json"},
    )
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with client.open(request, timeout=12) as response:
        payload = json.loads(response.read(1_000_001))
    if payload.get("errors"):
        raise ValueError("catalog query rejected")
    print(json.dumps(payload["data"]["gpuTypes"]))
except urllib.error.HTTPError as error:
    raise SystemExit(f"Runpod rejected the catalog query (HTTP {error.code}).") from None
except (OSError, KeyError, ValueError):
    raise SystemExit("Could not read Runpod's GPU catalog. Check the API key and connection.") from None

