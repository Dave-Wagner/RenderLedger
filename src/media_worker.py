import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def eleven_request(path, body=None, timeout=10):
    request = urllib.request.Request(
        "https://api.elevenlabs.io" + path,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"],
                 "Content-Type": "application/json"},
    )
    return urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout)


def quota():
    with eleven_request("/v1/user/subscription") as response:
        data = json.loads(response.read(262145))
    used, limit = data.get("character_count"), data.get("character_limit")
    tier = data.get("tier")
    if type(used) is not int or type(limit) is not int or used < 0 or limit <= 0 or not isinstance(tier, str):
        raise ValueError("Invalid ElevenLabs subscription quota")
    return {"used": used, "limit": limit, "remaining": max(0, limit - used),
            "reserve": max(500, (limit + 9) // 10), "tier": tier,
            "reset": data.get("next_character_count_reset_unix"),
            "overageDisabled": data.get("max_credit_limit_extension") == 0}


def check_quota(balance, settings):
    if settings["source"] == "eleven-music" and balance["tier"] == "free":
        raise SystemExit("ElevenLabs Music v2.5 is blocked on your Free plan. Choose ElevenLabs Multilingual v2 for text-to-speech or MusicGen for local music. No generation request was sent.")
    if balance["tier"] != "free":
        if not settings.get("allowSubscription") or not balance["overageDisabled"]:
            raise SystemExit("Only Free plans are enabled by default. Subscription use requires explicit setup and provider overages disabled.")
    if settings["source"] == "eleven-music":
        estimate = settings.get("musicCeiling")
        if balance["tier"] == "free" or not estimate:
            raise SystemExit("Hosted music requires a supported subscription and a configured credit ceiling.")
    else:
        estimate = len(settings["text"].encode("utf-8"))
    if balance["remaining"] < balance["reserve"] + estimate:
        raise SystemExit(f"Generation blocked: {balance['remaining']} credits left, with {balance['reserve']} reserved and {estimate} budgeted for this request.")


def generate(settings):
    source = settings["source"]
    text = settings["text"]
    if source == "windows":
        script = """
Add-Type -AssemblyName System.Speech -ErrorAction Stop
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$audio = New-Object System.IO.MemoryStream
try {
    $voice.SetOutputToWaveStream($audio)
    $voice.Speak([Console]::In.ReadToEnd())
    [Console]::Write([Convert]::ToBase64String($audio.ToArray()))
} finally {
    $voice.Dispose()
    $audio.Dispose()
}
"""
        script = "[Console]::InputEncoding = [Text.Encoding]::UTF8; " + script
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            input=text.encode("utf-8"), capture_output=True, check=True,
        )
        return base64.b64decode(result.stdout, validate=True), {}

    if source in ("local-music", "local-video"):
        return generate_local(settings), {}

    if source == "eleven-speech":
        path = "/v1/text-to-speech/" + settings["voice"]
        body = {"text": text, "model_id": settings["model"]}
    else:
        path = "/v1/music"
        body = {"prompt": text, "model_id": settings["model"],
                "music_length_ms": 10000, "force_instrumental": True}

    print("progress:Checking ElevenLabs plan and credits", flush=True)
    balance = quota()
    check_quota(balance, settings)
    print(f"progress:Credit check passed ({balance['remaining']} credits left). Waiting for ElevenLabs", flush=True)
    with eleven_request(path + "?output_format=mp3_44100_128", body, timeout=75) as response:
        print("progress:Downloading audio from ElevenLabs", flush=True)
        if response.headers.get_content_type() != "audio/mpeg":
            raise ValueError("Unexpected media type")
        cost = response.headers.get("character-cost", "")
        return response.read(24_000_001), {"characterCost": int(cost) if cost.isdecimal() else None,
                                          "quotaBefore": balance}


def generate_local(settings):
    checkpoint = settings["checkpoint"]
    if not os.path.isdir(checkpoint):
        raise ValueError("Checkpoint directory missing")
    import torch
    if settings["source"] == "local-music":
        torch.set_num_threads(2)
        import wave
        from transformers import AutoProcessor, MusicgenForConditionalGeneration
        processor = AutoProcessor.from_pretrained(checkpoint, local_files_only=True)
        model = MusicgenForConditionalGeneration.from_pretrained(checkpoint, local_files_only=True)
        inputs = processor(text=[settings["text"]], return_tensors="pt", padding=True)
        with torch.inference_mode():
            samples = model.generate(**inputs, max_new_tokens=256, do_sample=True)[0, 0]
        audio = io.BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setparams((1, 2, model.config.audio_encoder.sampling_rate, 0, "NONE", "not compressed"))
            wav.writeframes((samples.clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes())
        return audio.getvalue()

    from diffusers import WanPipeline
    from diffusers.utils import export_to_video
    if not torch.cuda.is_available():
        raise SystemExit("Wan requires a CUDA-capable NVIDIA GPU and CUDA PyTorch. Run setup-video.ps1 to check the driver and install the runtime.")
    pipeline = WanPipeline.from_pretrained(checkpoint, local_files_only=True, torch_dtype=torch.float16)
    pipeline.enable_model_cpu_offload()
    frames = pipeline(prompt=settings["text"], height=320, width=512,
                      num_frames=17, num_inference_steps=20).frames[0]
    with tempfile.TemporaryDirectory() as directory:
        output = os.path.join(directory, "clip.mp4")
        export_to_video(frames, output, fps=8)
        with open(output, "rb") as file:
            return file.read(24_000_001)


try:
    if sys.argv[1:] == ["quota"]:
        print(json.dumps(quota()))
        sys.exit(0)
    audio, usage = generate(json.load(sys.stdin))
    if not 0 < len(audio) <= 24_000_000:
        raise ValueError("Media size limit exceeded")
    print(json.dumps({"data": base64.b64encode(audio).decode("ascii"), "usage": usage}))
except urllib.error.HTTPError as error:
    stage = "credit check" if error.url.endswith("/v1/user/subscription") else "generation"
    advice = {
        401: "Check the API key.",
        403: "Check key permissions and plan access.",
        429: "The provider is rate limiting requests. Check usage and wait before retrying.",
    }.get(error.code, "Check provider status and usage before retrying.")
    sys.exit(f"ElevenLabs {stage} failed (HTTP {error.code}). {advice}")
except (TimeoutError, urllib.error.URLError):
    sys.exit("Could not complete the connection to ElevenLabs. Check provider usage before retrying.")
except (OSError, ValueError, RuntimeError, ImportError, subprocess.CalledProcessError):
    sys.exit("Media generation failed. Check installed voices, local model dependencies and hardware, or provider status and usage.")
