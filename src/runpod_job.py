import base64
import contextlib
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import wave
import zlib
import zipfile

directory = Path("runpod-job")
directory.mkdir(exist_ok=True)
journal = directory / "pending.json"
cancel = directory / "stop"
status = directory / "status.json"
mode, catalog_source = sys.argv[1:]
worker_source = os.environ.pop("NPU_RUNPOD_WORKER_SOURCE")
context_run = mode == "train-dayton-context"
extended = mode == "train-dayton-extended" or context_run
dayton = mode == "train-dayton" or extended
if dayton:
    mode = "train"
launch_ns = int(os.environ.pop("NPU_RUNPOD_STARTED_NS", str(time.time_ns())))
key = os.environ.pop("RUNPOD_API_KEY")
limit = 0.65
run_details = {"run": secrets.token_hex(8), "started": time.time(), "events": []}


def dayton_dataset(context=False):
    review = "DaytonWitch-context.csv" if context else "DaytonWitch-review.csv"
    with (Path("datasets") / review).open(encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))
    images, hashes = [], set()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for row in rows:
            if row["split"] not in ("train", "holdout"):
                continue
            name = row["file"]
            if Path(name).name != name or not name.lower().endswith(".png") or not row["caption"].strip():
                raise ValueError("DaytonWitch rows need a PNG filename and a caption.")
            raw = (Path("datasets/DaytonWitch") / name).read_bytes()
            digest = hashlib.sha256(raw).hexdigest()
            if digest != row["sha256"].lower() or digest in hashes:
                raise ValueError(f"Changed or duplicate DaytonWitch image: {name}")
            hashes.add(digest)
            image_id = len(images) + 1
            images.append({"id": image_id, "split": row["split"], "sha256": digest,
                           "caption": row["caption"], "filename": f"{image_id}.png"})
            if row["split"] == "train":
                if buffer.tell() + len(raw) > 31_900_000:
                    raise ValueError("DaytonWitch archive exceeds the worker upload limit.")
                archive.writestr(f"{image_id}.png", raw)
    if sum(row["split"] == "train" for row in images) != 13 or len(images) != 17:
        raise ValueError("Expected the reviewed DaytonWitch split of 13 training and four holdout images.")
    return json.dumps({
        "dataset": "DaytonWitch",
        "model": "stabilityai/stable-diffusion-xl-base-1.0",
        "revision": "462165984030d82259a11f4367a4eed129e94a7b",
        "images": images,
    }).encode(), buffer.getvalue()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

def write(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value), encoding="utf-8")
    os.replace(temporary, path)

def report(phase, **data):
    timestamp = time.time()
    if run_details.get("phase") != phase:
        run_details["events"].append({"phase": phase, "time": timestamp})
    run_details.update(phase=phase, time=timestamp, **data)
    for path in (directory / ("run-" + run_details["run"] + ".json"), status):
        try:
            write(path, run_details)
        except OSError:
            # A dashboard file read must never interrupt Pod cleanup.
            pass

def request(url, token, method="GET", payload=None, max_bytes=4_000_000):
    req = urllib.request.Request(
        url, method=method, data=payload if isinstance(payload, bytes) else
        None if payload is None else json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + token,
                 "Content-Type": "application/octet-stream" if isinstance(payload, bytes) else "application/json",
                 "Accept": "application/json", "User-Agent": "NPU-Lab/0.1"},
    )
    with client.open(req, timeout=12) as response:
        data = response.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError("Runpod response exceeded the size limit.")
        return json.loads(data) if data else None

def api(path, method="GET", payload=None):
    return request("https://rest.runpod.io/v1/pods" + path, key, method, payload)

def pod_path(pod_id):
    if not re.fullmatch(r"[a-z0-9]+", pod_id):
        raise ValueError("Invalid Pod ID.")
    return "/" + pod_id

def cleanup():
    saved = json.loads(journal.read_text(encoding="utf-8"))
    pod_id = saved.get("id")
    if not pod_id:
        matches = [pod for pod in api("") if pod.get("name") == saved["name"]]
        if not matches:
            if time.time() - journal.stat().st_mtime < 120:
                raise RuntimeError("Pod creation is still settling. Retry cleanup two minutes after the create attempt.")
            time.sleep(3)
            matches = [pod for pod in api("") if pod.get("name") == saved["name"]]
            if not matches:
                journal.unlink()
                return False
        if len(matches) > 1:
            raise RuntimeError("Runpod lists multiple Pods with the journaled name. Check Runpod Pods before retrying.")
        pod_id = matches[0]["id"]
    path = pod_path(pod_id)
    try:
        api(path, "DELETE")
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    try:
        api(path)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            journal.unlink()
            return True
        raise
    raise RuntimeError("Runpod still lists the Pod. Retry cleanup.")

def choose(minimum_vram, disk_gb):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(catalog_source, {})
    offers = []
    for row in json.loads(output.getvalue()):
        quote = row.get("lowestPrice") or {}
        price = quote.get("uninterruptablePrice")
        counts = quote.get("availableGpuCounts")
        if ("NVIDIA" in row["id"].upper() and row["memoryInGb"] >= minimum_vram
                and quote.get("stockStatus") in ("Low", "Medium", "High")
                and (counts is None or 1 in counts) and isinstance(price, (int, float))
                and 0 < price <= limit - 0.007 * disk_gb / 50):
            offers.append((price, row["id"]))
    return min(offers, default=None)

def save_result(result, manifest=None, evaluation=None):
    png = base64.b64decode(result["png"], validate=True)
    if not png.startswith(b"\x89PNG\r\n\x1a\n") or len(png) < 100:
        raise ValueError("The worker returned an invalid PNG.")
    training = manifest is not None
    model = run_details.get("model", "SDXL Base + botanical LoRA") if training or evaluation else "SDXL Turbo"
    prompt = run_details.get("prompt") or (
        model + " comparison grid" if training else "Watercolor fox in an autumn forest")
    profile = json.loads(manifest).get("training", {}) if training else (evaluation or {}).get("training", {})
    steps = profile.get("inferenceSteps", 20) if training or evaluation else 2
    if training:
        artifact_dir = directory / ("artifacts-" + run_details["run"])
        artifact_dir.mkdir(exist_ok=True)
        (artifact_dir / "dataset-manifest.json").write_bytes(manifest)
        for step in profile.get("checkpoints", [60, 120]):
            checkpoint = f"step-{step}"
            weights = base64.b64decode(result["artifacts"][checkpoint], validate=True)
            if len(weights) < 100 or not 0 < int.from_bytes(weights[:8], "little") < len(weights) - 8:
                raise ValueError("Invalid adapter artifact.")
            target = artifact_dir / (checkpoint + ".safetensors")
            target.write_bytes(weights)
        run_details["artifacts"] = str(artifact_dir)
        run_details["evaluationSeconds"] = result["evaluationSeconds"]
        run_details["prompts"] = result["prompts"]
    result = {key: result[key] for key in ("png", "device", "setupSeconds", "runSeconds", "seed")}
    db = sqlite3.connect(os.environ.get("NPU_LAB_DB", "npu-lab.sqlite3"))
    with contextlib.closing(db), db:
        db.execute("""CREATE TABLE IF NOT EXISTS image_runs (
            id INTEGER PRIMARY KEY, created TEXT NOT NULL DEFAULT (datetime('now')),
            kind TEXT NOT NULL, device TEXT NOT NULL, model TEXT NOT NULL,
            request TEXT NOT NULL, result TEXT, error TEXT)""")
        cursor = db.execute("INSERT INTO image_runs (kind, device, model, request, result) VALUES (?, ?, ?, ?, ?)",
                   ("image", "Runpod", model,
                    json.dumps({"prompt": prompt, "negativePrompt": run_details.get("negativePrompt", ""),
                                "seed": result["seed"], "steps": steps,
                                "batch": run_details.get("batch") or run_details.get("parentRun")}),
                    json.dumps(result)))
        return cursor.lastrowid

def check_stop():
    try:
        marker = cancel.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        return
    # An empty or partially written marker is treated as a stop request.
    if not marker.isdecimal() or int(marker) >= launch_ns:
        raise InterruptedError("Stopped by user.")

def run():
    worker_env = {}
    manifest = None
    dataset = None
    evaluation = None
    minimum_vram = 24 if mode in ("train", "music") else 16
    disk_gb = 50
    if mode == "chat":
        options = json.loads(os.environ.pop("NPU_EVAL_OPTIONS"))
        models = {
            "32b": ("Qwen/Qwen2.5-32B-Instruct-AWQ", 24, 65),
            "72b": ("Qwen/Qwen2.5-72B-Instruct-AWQ", 48, 85),
        }
        model, minimum_vram, disk_gb = models[options["variant"]]
        prompt, tokens, batch = options["prompt"].strip(), options["tokens"], options["batch"]
        if (not 1 <= len(prompt) <= 2400 or type(tokens) is not int or not 1 <= tokens <= 256
                or not re.fullmatch(r"[a-f0-9-]{36}", batch)):
            raise ValueError("Choose a valid chat prompt, reply limit, and comparison ID.")
        run_details.update(prompt=prompt, batch=batch, model=model, tokens=tokens)
        worker_env["NPU_CHAT_CONFIG"] = json.dumps({"model": model, "prompt": prompt, "tokens": tokens})
    if mode == "music":
        options = json.loads(os.environ.pop("NPU_EVAL_OPTIONS"))
        prompt = options["prompt"].strip()
        batch = options["batch"]
        if not 1 <= len(prompt) <= 500 or not re.fullmatch(r"[a-f0-9-]{36}", batch):
            raise ValueError("Enter a music prompt of up to 500 characters.")
        if options.get("variant", "3b") != "3b":
            raise ValueError("Only HeartMuLa 3B is available. The official 7B checkpoint is unreleased.")
        lyrics = options.get("lyrics", "")
        if not isinstance(lyrics, str) or len(lyrics) > 1500:
            raise ValueError("Enter lyrics of up to 1500 characters.")
        duration = options.get("duration", 30)
        if type(duration) is not int or duration not in (30, 60, 90, 120):
            raise ValueError("Choose a HeartMuLa length of 30, 60, 90, or 120 seconds.")
        run_details.update(prompt=prompt, lyrics=lyrics.strip(), batch=batch, model="HeartMuLa 3B Happy New Year",
                           seed=42, requestedDurationSeconds=duration)
        worker_env["NPU_MUSIC_CONFIG"] = json.dumps(
            {"prompt": prompt, "lyrics": lyrics.strip(), "seed": 42, "duration": duration})
    if mode in ("run", "eval") and "NPU_EVAL_OPTIONS" in os.environ:
        options = json.loads(os.environ.pop("NPU_EVAL_OPTIONS"))
        prompt, seed = options["prompt"].strip(), options["seed"]
        negative = options.get("negativePrompt", "")
        if not isinstance(negative, str) or len(negative) > 1000:
            raise ValueError("Enter a negative prompt of up to 1000 characters.")
        negative = negative.strip()
        if mode == "run" and negative:
            raise ValueError("SDXL Turbo does not support negative prompts.")
        run_details["negativePrompt"] = negative
        if not 1 <= len(prompt) <= 1000 or type(seed) is not int or not 0 <= seed <= 2147483647:
            raise ValueError("Choose a prompt of up to 1000 characters and a valid seed.")
        batch = options.get("batch")
        if batch is not None:
            if not isinstance(batch, str) or not re.fullmatch(r"[a-f0-9-]{36}", batch):
                raise ValueError("Invalid comparison batch ID.")
            run_details["batch"] = batch
        if mode == "run":
            run_details.update(prompt=prompt, seed=seed)
            worker_env["NPU_IMAGE_CONFIG"] = json.dumps({"prompt": prompt, "seed": seed})
    if mode == "eval":
        report("Checking saved adapters")
        parent, prompt, seed = options["run"], options["prompt"].strip(), options["seed"]
        if not re.fullmatch(r"[a-f0-9]{16}", parent) or not 1 <= len(prompt) <= 1000:
            raise ValueError("Choose a training run and a prompt of up to 1000 characters.")
        if type(seed) is not int or not 0 <= seed <= 2147483647:
            raise ValueError("Seed must be an integer between 0 and 2147483647.")
        artifacts = directory / ("artifacts-" + parent)
        model = json.loads((artifacts / "dataset-manifest.json").read_bytes())
        if model.get("dataset") == "DaytonWitch":
            run_details["model"] = ("SDXL Base + DaytonWitch Context LoRA" if model.get("captionProfile")
                                    else "SDXL Base + DaytonWitch LoRA")
        profile = model.get("training", {})
        evaluation = {"model": model["model"], "revision": model["revision"], "training": profile,
                      "prompt": prompt, "negativePrompt": negative, "seed": seed, "hashes": {}}
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for step in profile.get("checkpoints", [60, 120]):
                name = f"step-{step}.safetensors"
                raw = (artifacts / name).read_bytes()
                evaluation["hashes"][name] = hashlib.sha256(raw).hexdigest()
                archive.writestr(name, raw)
        dataset = buffer.getvalue()
        if len(dataset) > 112_000_000:
            raise ValueError("The adapter bundle exceeds the worker upload limit.")
        worker_env["NPU_EVAL_CONFIG"] = json.dumps(evaluation)
        run_details.update(parentRun=parent, prompt=prompt, seed=seed, steps=20)
    if dayton:
        report("Verifying DaytonWitch captions and local image hashes")
        manifest, dataset = dayton_dataset(context_run)
        if extended:
            config = json.loads(manifest)
            config["training"] = {"checkpoints": [240, 480], "rank": 8, "resolution": 768, "inferenceSteps": 30}
            if context_run:
                config["captionProfile"] = "consistency-v1"
            manifest = json.dumps(config).encode()
            run_details["training"] = config["training"]
        worker_env["NPU_TRAIN_MANIFEST"] = base64.b64encode(zlib.compress(manifest)).decode()
        run_details.update(model="SDXL Base + DaytonWitch LoRA", dataset="DaytonWitch",
                           datasetSha256=hashlib.sha256(manifest).hexdigest())
        if context_run:
            run_details["model"] = "SDXL Base + DaytonWitch Context LoRA"
    elif mode == "train":
        report("Checking botanical dataset manifest")
        manifest = Path("datasets/met-botanical-48.json").read_bytes()
        rows = json.loads(manifest)["images"]
        if (len(rows) != 48 or sum(row["split"] == "train" for row in rows) != 40
                or len({row["id"] for row in rows}) != 48
                or any(row["license"] != "CC0" or not re.fullmatch(r"[a-f0-9]{64}", row["sha256"]) for row in rows)):
            raise ValueError("The botanical manifest must contain 48 unique CC0 images and 40 training rows.")
        worker_env["NPU_TRAIN_MANIFEST"] = base64.b64encode(zlib.compress(manifest)).decode()
        dataset = Path("datasets/met-botanical-train.zip").read_bytes()
        if len(dataset) > 32_000_000:
            raise ValueError("The dataset archive exceeds the worker upload limit.")
        with zipfile.ZipFile(io.BytesIO(dataset)) as archive:
            for row in rows:
                if row["split"] == "train":
                    raw = archive.read(f"{row['id']}.jpg")
                    if hashlib.sha256(raw).hexdigest() != row["sha256"]:
                        raise ValueError(f"Local training image {row['id']} does not match the manifest.")
        run_details["datasetSha256"] = hashlib.sha256(manifest).hexdigest()
    until = time.monotonic() + 7200
    while time.monotonic() < until:
        check_stop()
        report("Checking capacity")
        offer = choose(minimum_vram, disk_gb)
        if offer:
            break
        report("Waiting for an eligible GPU")
        for _ in range(60):
            check_stop()
            time.sleep(1)
    else:
        raise TimeoutError("No eligible GPU appeared in two hours.")
    check_stop()
    price, gpu = offer
    name = "npu-lab-" + secrets.token_hex(8)
    token = secrets.token_urlsafe(32)
    write(journal, {"name": name})
    report("Creating Pod", gpu=gpu, quote=price)
    runtime_limit = 7200 if mode == "train" else 1200
    until = time.monotonic() + runtime_limit
    try:
        check_stop()
    except InterruptedError:
        journal.unlink()
        raise
    try:
        pod = api("", "POST", {
            "name": name, "cloudType": "SECURE", "computeType": "GPU",
            "gpuTypeIds": [gpu], "gpuCount": 1, "interruptible": False,
            "imageName": "runpod/pytorch:1.5.0-cu1281-torch280-ubuntu2404",
            "containerDiskInGb": disk_gb, "volumeInGb": 0, "ports": ["8080/http"],
            "dockerEntrypoint": ["python", "-u", "-c"], "dockerStartCmd": [worker_source],
            "env": {**worker_env, "NPU_JOB_TOKEN": token},
        })
    except urllib.error.HTTPError as error:
        if error.code in (400, 401, 403, 422):
            journal.unlink()
        raise RuntimeError(f"Runpod refused Pod creation (HTTP {error.code}).") from None
    pod_id = pod["id"]
    write(journal, {"name": name, "id": pod_id})
    report("Verifying Pod rate", pod=pod_id, name=name, podCreated=time.time())
    rate = float(api(pod_path(pod_id))["costPerHr"])
    if not math.isfinite(rate) or not 0 < rate <= limit:
        raise RuntimeError("Runpod's actual rate failed the configured price check.")
    run_details["rate"] = rate
    worker_url = f"https://{pod_id}-8080.proxy.runpod.net"
    startup_deadline = time.monotonic() + 300
    progress_deadline = None
    last_progress = None
    attempts = 0
    worker_seen = False
    uploaded = 0
    while time.monotonic() < until:
        check_stop()
        attempts += 1
        try:
            result = request(worker_url + "/result", token,
                             max_bytes=(144_000_000 if extended else 100_000_000) if mode == "train"
                             else 34_000_000 if mode == "music" else 16_000_000)
            worker_seen = True
            if dataset is not None and result["phase"] != "Error":
                while uploaded < len(dataset):
                    check_stop()
                    if time.monotonic() >= until:
                        raise RuntimeError("Pod deadline reached during dataset upload.")
                    report("Uploading saved adapters" if evaluation else "Uploading verified training dataset",
                           gpu=gpu, pod=pod_id, rate=rate, uploadedBytes=uploaded, uploadBytes=len(dataset))
                    chunk = dataset[uploaded:uploaded + 524288]
                    request(f"{worker_url}/dataset/{uploaded}/{len(dataset)}", token, "POST", chunk)
                    uploaded += len(chunk)
                    startup_deadline = time.monotonic() + 120
                report("Dataset upload confirmed", uploadedBytes=uploaded, uploadBytes=len(dataset))
                dataset = None
        except (OSError, ValueError) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code == 429:
                raise RuntimeError("Worker endpoint returned HTTP 429. Polling stopped to respect the rate limit.") from None
            detail = f"HTTP {error.code}" if isinstance(error, urllib.error.HTTPError) else type(error).__name__
            if isinstance(error, urllib.error.HTTPError) and error.code in (400, 401, 403, 409, 413):
                raise RuntimeError(f"Worker rejected the request: {detail}.") from None
            if time.monotonic() >= (progress_deadline or startup_deadline):
                raise TimeoutError(f"Worker stopped making progress after {attempts} checks. Last response: {detail}.") from None
            report("Waiting for dataset upload" if dataset is not None and worker_seen
                   else "Waiting for worker", gpu=gpu, pod=pod_id, rate=rate,
                   attempts=attempts, workerIssue=detail)
            time.sleep(4)
            continue
        if result["phase"] == "Error":
            raise RuntimeError(("Music" if mode == "music" else "Image") + " worker failed: " + result["error"])
        if result["phase"] == "Ready":
            if mode == "chat":
                reply = result["chatReply"]
                if not isinstance(reply, str) or not reply.strip() or len(reply) > 16_000:
                    raise ValueError("Chat worker returned an invalid reply.")
                report("Chat reply saved", chatReply=reply, device=result["device"],
                       runSeconds=result["runSeconds"], outputTokens=result["outputTokens"])
                return
            if mode == "music":
                audio = base64.b64decode(result["audio"], validate=True)
                if not audio.startswith(b"RIFF") or audio[8:12] != b"WAVE" or len(audio) > 24_000_000:
                    raise ValueError("Music worker returned invalid WAV audio.")
                with wave.open(io.BytesIO(audio), "rb") as wav:
                    actual_duration = wav.getnframes() / wav.getframerate()
                saved = {"audio": result["audio"], "mime": "audio/wav", "model": run_details["model"],
                         "source": "runpod-music", "location": "External · Runpod",
                         "text": run_details["prompt"], "lyrics": run_details["lyrics"],
                         "durationSeconds": actual_duration, "requestedDurationSeconds": duration,
                         "elapsedMs": int(result["runSeconds"] * 1000),
                         "billing": "See Runpod billing", "runpodRun": run_details["run"]}
                with contextlib.closing(sqlite3.connect(os.environ.get("NPU_LAB_DB", "npu-lab.sqlite3"))) as db, db:
                    db.execute("""CREATE TABLE IF NOT EXISTS media_runs (
                        id INTEGER PRIMARY KEY, created TEXT NOT NULL DEFAULT (datetime('now')), result TEXT NOT NULL)""")
                    media_id = db.execute("INSERT INTO media_runs (result) VALUES (?)", (json.dumps(saved),)).lastrowid
                report("Audio saved", mediaId=media_id, device=result["device"], runSeconds=result["runSeconds"])
                return
            result_id = save_result(result, manifest, evaluation)
            report("Comparison grid saved" if mode in ("train", "eval") else "Image saved", resultId=result_id, device=result["device"],
                   setupSeconds=result["setupSeconds"], runSeconds=result["runSeconds"],
                   model=run_details.get("model", "SDXL Base + botanical LoRA") if mode in ("train", "eval") else "SDXL Turbo",
                   prompt=run_details.get("prompt") or (
                       run_details.get("model", "Botanical LoRA") + " comparison grid" if mode == "train" else "Watercolor fox in an autumn forest"),
                   seed=result["seed"], steps=run_details.get("training", (evaluation or {}).get("training", {})).get(
                       "inferenceSteps", 20) if mode in ("train", "eval") else 2)
            return
        progress = (result["phase"], result.get("step"))
        if progress != last_progress:
            last_progress = progress
            progress_deadline = time.monotonic() + 900
        elif time.monotonic() >= progress_deadline:
            raise TimeoutError(f"No progress for 15 minutes during {result['phase']}.")
        report(result["phase"], gpu=gpu, pod=pod_id, rate=rate,
               step=result.get("step"), totalSteps=result.get("totalSteps"),
               attempts=attempts, workerIssue=None)
        time.sleep(4)
    raise TimeoutError(f"The Pod reached the {runtime_limit // 60}-minute local deadline.")

with (directory / "lock").open("a+b") as lock:
    lock.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit("A Runpod job is already running.")
    if mode != "cleanup" and journal.exists():
        report("Cleanup required", error="Resolve the previous Pod before starting another.")
        sys.exit(1)
    if mode == "cleanup" and status.exists():
        previous = json.loads(status.read_text(encoding="utf-8"))
        if previous.get("run"):
            run_details = previous
    error = run_details.get("error") if mode == "cleanup" else None
    try:
        if mode != "cleanup":
            run()
    except (Exception, SystemExit) as exc:
        error = (f"Runpod returned HTTP {exc.code}." if isinstance(exc, urllib.error.HTTPError)
                 else str(exc).replace(key, "[redacted]"))
    if journal.exists():
        report("Deleting Pod")
        cleanup_issue = None
        for _ in range(3):
            try:
                if cleanup():
                    report("Pod deletion verified", deletedAt=time.time())
                else:
                    report("No Pod found in Runpod", cleanupIssue=None)
                break
            except urllib.error.HTTPError as exc:
                cleanup_issue = f"Pod cleanup returned HTTP {exc.code}."
                if exc.code == 429:
                    break
                time.sleep(3)
            except Exception as exc:
                cleanup_issue = str(exc).replace(key, "[redacted]")
                time.sleep(3)
    if journal.exists():
        pending = json.loads(journal.read_text(encoding="utf-8"))
        report("Cleanup required", pod=pending.get("id"), name=pending["name"],
               cleanupIssue=cleanup_issue, error=error or "Could not verify Pod deletion. Retry cleanup.")
    else:
        report("Failed" if error else "Complete", error=error, ended=time.time())
