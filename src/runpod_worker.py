import base64
import hmac
import io
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

state = {"phase": "Starting training worker" if os.environ.get("NPU_TRAIN_MANIFEST")
         else "Installing image dependencies"}
dataset_ready = threading.Event()
dataset_bytes = None
upload = bytearray()
upload_total = None

class Handler(BaseHTTPRequestHandler):
    def authorized(self):
        return hmac.compare_digest(self.headers.get("Authorization", ""),
                                   "Bearer " + os.environ["NPU_JOB_TOKEN"])

    def do_POST(self):
        global dataset_bytes, upload_total
        match = re.fullmatch(r"/dataset/(\d{1,9})/(\d{1,9})", self.path)
        if not match or not self.authorized() or not (
            os.environ.get("NPU_TRAIN_MANIFEST") or os.environ.get("NPU_EVAL_CONFIG")
        ):
            self.send_error(404)
            return
        offset, total = map(int, match.groups())
        length = self.headers.get("Content-Length", "")
        if (not length.isdecimal() or not 1 <= int(length) <= 524288
                or not 1 <= total <= (112_000_000 if os.environ.get("NPU_EVAL_CONFIG") else 32_000_000)
                or offset + int(length) > total):
            self.send_error(413)
            return
        self.connection.settimeout(30)
        chunk = self.rfile.read(int(length))
        if len(chunk) != int(length):
            self.send_error(400)
            return
        if upload_total not in (None, total) or offset > len(upload):
            self.send_error(409)
            return
        upload_total = total
        if offset == len(upload):
            upload.extend(chunk)
        elif upload[offset:offset + len(chunk)] != chunk:
            self.send_error(409)
            return
        if len(upload) == total and not dataset_ready.is_set():
            dataset_bytes = upload
            dataset_ready.set()
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path != "/result" or not self.authorized():
            self.send_error(404)
            return
        body = json.dumps(state).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

threading.Thread(target=HTTPServer(("0.0.0.0", 8080), Handler).serve_forever, daemon=True).start()
def update(next_state):
    global state
    state = next_state

try:
    if os.environ.get("NPU_TRAIN_MANIFEST"):
        state = train_botanical(update)
    elif os.environ.get("NPU_EVAL_CONFIG"):
        state = evaluate_botanical(update)
    elif os.environ.get("NPU_CHAT_CONFIG"):
        import subprocess
        import sys
        update({"phase": "Installing vLLM chat runtime"})
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "vllm==0.10.2"],
                       check=True, timeout=420)
        os.environ["VLLM_ENABLE_V1_MULTIPROCESSING"] = "0"
        import torch
        from vllm import LLM, SamplingParams
        config = json.loads(os.environ["NPU_CHAT_CONFIG"])
        update({"phase": "Loading " + config["model"]})
        llm = LLM(model=config["model"], quantization="awq", dtype="half",
                  max_model_len=2048, gpu_memory_utilization=0.92,
                  max_num_seqs=1, enforce_eager=True)
        update({"phase": "Generating chat reply"})
        started = time.monotonic()
        reply = llm.chat([{"role": "user", "content": config["prompt"]}],
                         sampling_params=SamplingParams(temperature=0, max_tokens=config["tokens"]),
                         use_tqdm=False)[0].outputs[0]
        state = {"phase": "Ready", "chatReply": reply.text, "outputTokens": len(reply.token_ids),
                 "device": torch.cuda.get_device_name(), "runSeconds": time.monotonic() - started}
    elif os.environ.get("NPU_MUSIC_CONFIG"):
        import subprocess
        import sys
        from pathlib import Path
        import tempfile
        update({"phase": "Installing HeartMuLa dependencies"})
        subprocess.run([sys.executable, "-m", "pip", "install", "-q",
                        "git+https://github.com/HeartMuLa/heartlib.git"],
                       check=True, timeout=360)
        import torch
        from heartlib import HeartMuLaGenPipeline
        from huggingface_hub import snapshot_download
        config = json.loads(os.environ["NPU_MUSIC_CONFIG"])
        with tempfile.TemporaryDirectory(prefix="heartmula-") as folder:
            root = Path(folder)
            checkpoint = root / "ckpt"
            for repo, target in (
                ("HeartMuLaGen", checkpoint),
                ("HeartMuLa-oss-3B-happy-new-year", checkpoint / "HeartMuLa-oss-3B"),
                ("HeartCodec-oss-20260123", checkpoint / "HeartCodec-oss"),
            ):
                update({"phase": "Downloading " + repo})
                snapshot_download("HeartMuLa/" + repo, local_dir=target, token=False)
            update({"phase": "Loading HeartMuLa 3B"})
            pipe = HeartMuLaGenPipeline.from_pretrained(
                str(checkpoint), device={"mula": torch.device("cuda"), "codec": torch.device("cuda")},
                dtype={"mula": torch.bfloat16, "codec": torch.float32}, version="3B", lazy_load=True)
            tags, lyrics, output = root / "tags.txt", root / "lyrics.txt", root / "cue.wav"
            tags.write_text(",".join(tag.strip() for tag in config["prompt"].split(",") if tag.strip()), encoding="utf-8")
            lyrics.write_text(config["lyrics"] or "[Instrumental]\n", encoding="utf-8")
            torch.manual_seed(config["seed"])
            update({"phase": "Generating HeartMuLa audio"})
            started = time.monotonic()
            with torch.no_grad():
                pipe({"lyrics": str(lyrics), "tags": str(tags)}, max_audio_length_ms=config["duration"] * 1000,
                     save_path=str(output), topk=50, temperature=1.0, cfg_scale=3.0)
            audio = output.read_bytes()
        state = {"phase": "Ready", "audio": base64.b64encode(audio).decode(),
                 "device": torch.cuda.get_device_name(), "runSeconds": time.monotonic() - started}
    else:
        import subprocess
        import sys
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "diffusers==0.35.2",
                        "transformers==4.56.2", "accelerate==1.10.1", "safetensors"], check=True, timeout=360)
        state = {"phase": "Loading SDXL Turbo"}
        import torch
        from diffusers import AutoPipelineForText2Image
        started = time.monotonic()
        pipeline = AutoPipelineForText2Image.from_pretrained(
            "stabilityai/sdxl-turbo", variant="fp16", torch_dtype=torch.float16,
            use_safetensors=True, token=False,
        ).to("cuda")
        ready = time.monotonic()
        state = {"phase": "Generating image"}
        config = json.loads(os.environ.get("NPU_IMAGE_CONFIG", "{}"))
        seed = config.get("seed", 42)
        image = pipeline(
            config.get("prompt", "Watercolor fox in an autumn forest"), num_inference_steps=2, guidance_scale=0,
            width=512, height=512, generator=torch.Generator("cuda").manual_seed(seed),
        ).images[0]
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        state = {"phase": "Ready", "png": base64.b64encode(buffer.getvalue()).decode(),
                 "device": torch.cuda.get_device_name(), "setupSeconds": ready-started,
                 "runSeconds": time.monotonic()-ready, "seed": seed}
except Exception as error:
    detail = str(error)[:4000] if any(os.environ.get(name) for name in (
        "NPU_TRAIN_MANIFEST", "NPU_EVAL_CONFIG", "NPU_MUSIC_CONFIG", "NPU_CHAT_CONFIG"
    )) else ""
    state = {"phase": "Error", "error": " · ".join(filter(None, [state["phase"], type(error).__name__, detail]))}
threading.Event().wait(600)

