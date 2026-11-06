import json
import re
import sys
import time
import urllib.error
import urllib.request

request = json.load(sys.stdin)
connection = request.pop("connection", None)
if not isinstance(connection, dict):
    raise SystemExit("Enter the Colab tunnel URL and pairing token.")
url = connection.get("url", "").rstrip("/")
token = connection.get("token", "")
if not re.fullmatch(r"https://[a-z0-9-]+\.trycloudflare\.com", url):
    raise SystemExit("Use the HTTPS trycloudflare.com URL printed by the notebook.")
if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
    raise SystemExit("Enter the pairing token printed by the notebook.")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}

def call(path, data=None):
    req = urllib.request.Request(url + path, data=data, headers=headers)
    try:
        with client.open(req, timeout=12) as response:
            return json.loads(response.read(2_000_001))
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Colab rejected the request (HTTP {exc.code}).") from None
    except (OSError, ValueError):
        raise SystemExit("Could not read a response from the Colab notebook.") from None

payload = {key: request[key] for key in ("prompt", "seed", "steps", "strength", "reference") if key in request}
job = call("/jobs", json.dumps(payload).encode())["id"]
if not re.fullmatch(r"[a-f0-9]{32}", job):
    raise SystemExit("Unexpected job ID from Colab.")
while True:
    state = call("/jobs/" + job)
    if state["status"] == "done":
        result = state["result"]
        if not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", result.get("png", "")):
            raise SystemExit("Colab returned an invalid image.")
        print(json.dumps(result))
        break
    if state["status"] == "error":
        raise SystemExit(state["error"])
    time.sleep(1)
