import datetime as dt
import json
import os
import sys
from email.utils import parsedate_to_datetime
import urllib.error
import urllib.parse
import urllib.request

key = os.environ.pop("RUNPOD_API_KEY")
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

def fetch(url, data=None):
    request = urllib.request.Request(url, data=data, headers={
        "Authorization": "Bearer " + key, "User-Agent": "NPU-Lab/0.1",
        "Accept": "application/json", "Content-Type": "application/json",
    })
    with client.open(request, timeout=10) as response:
        return json.loads(response.read(2_000_001))

def capture(label, action):
    try:
        return action()
    except urllib.error.HTTPError as error:
        snapshot[label + "Error"] = f"Runpod returned HTTP {error.code}."
        if error.code == 429:
            retry = error.headers.get("Retry-After", "")
            try:
                seconds = int(retry) if retry.isdecimal() else (
                    parsedate_to_datetime(retry) - now).total_seconds()
            except (TypeError, ValueError, OverflowError):
                seconds = 0
            snapshot["retryAfter"] = max(120, int(seconds) + 1)
    except (ValueError, OSError, KeyError, TypeError):
        snapshot[label + "Error"] = "Could not read Runpod's response."
    return None

now = dt.datetime.now(dt.timezone.utc)
snapshot = {"time": now.timestamp()}

def balance():
    url = "https://api.runpod.io/graphql?" + urllib.parse.urlencode({"api_key": key})
    return float(fetch(url, b'{"query":"query { myself { clientBalance } }"}')["data"]["myself"]["clientBalance"])

def billing():
    parameters = urllib.parse.urlencode({
        "startTime": (now - dt.timedelta(days=7)).isoformat(),
        "endTime": now.isoformat(), "grouping": "podId", "bucketSize": "day",
    })
    rows = fetch("https://rest.runpod.io/v1/billing/pods?" + parameters)
    charges = {}
    for row in rows:
        if row.get("podId"):
            record = charges.setdefault(row["podId"], {"usd": 0, "seconds": 0, "gpu": row.get("gpuTypeId")})
            record["usd"] += float(row["amount"])
            record["seconds"] += (row.get("timeBilledMs") or 0) / 1000
    return charges

if sys.argv[1] == "balance":
    snapshot["balance"] = capture("balance", balance)
else:
    snapshot["charges"] = capture("charges", billing)
print(json.dumps(snapshot, allow_nan=False))
