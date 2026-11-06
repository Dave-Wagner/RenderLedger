def train_botanical(update):
    import hashlib
    import pathlib
    import re
    import subprocess
    import sys
    import urllib.request
    import zipfile
    import zlib

    started = time.monotonic()
    update({"phase": "Installing training dependencies"})
    subprocess.run([
        sys.executable, "-m", "pip", "install", "-q",
        "diffusers==0.35.2", "transformers==4.56.2", "accelerate==1.10.1",
        "datasets==3.6.0", "peft==0.17.1", "safetensors", "ftfy", "Jinja2", "tensorboard",
    ], check=True, timeout=480)

    from PIL import Image, ImageDraw, ImageOps
    from diffusers import StableDiffusionXLPipeline
    import torch

    root = pathlib.Path("/tmp/npu-lab-botanical")
    data = root / "data"
    data.mkdir(parents=True, exist_ok=True)
    output = root / "adapter"
    manifest = json.loads(zlib.decompress(base64.b64decode(os.environ["NPU_TRAIN_MANIFEST"])))
    rows = manifest["images"]
    dayton = manifest.get("dataset") == "DaytonWitch"
    profile = manifest.get("training", {})
    midpoint, final = profile.get("checkpoints", [60, 120])
    resolution = profile.get("resolution", 512)
    rank = profile.get("rank", 4)
    inference_steps = profile.get("inferenceSteps", 20)
    expected_total, expected_train = (17, 13) if dayton else (48, 40)
    if len(rows) != expected_total or sum(row["split"] == "train" for row in rows) != expected_train:
        raise ValueError(f"Expected {expected_train} training images in {expected_total} manifest rows.")
    update({"phase": "Waiting for verified dataset upload"})
    if not dataset_ready.wait(600):
        raise TimeoutError("Dataset upload did not arrive.")
    update({"phase": f"Verifying {expected_train} uploaded training images"})
    with zipfile.ZipFile(io.BytesIO(dataset_bytes)) as archive, (data / "metadata.jsonl").open("w", encoding="utf-8") as metadata:
        for row in rows:
            if row["split"] != "train":
                continue
            filename = f"{row['id']}.jpg"
            raw = archive.read(f"{row['id']}.png" if dayton else filename)
            if hashlib.sha256(raw).hexdigest() != row["sha256"]:
                raise ValueError(f"Training image {row['id']} no longer matches the manifest.")
            with Image.open(io.BytesIO(raw)) as image:
                prepared = ImageOps.pad(image.convert("RGB"), (resolution, resolution), color="#eee8d5")
                prepared.save(data / filename, quality=95)
            metadata.write(json.dumps({"file_name": filename, "text": row["caption"]}) + "\n")

    script = root / "train.py"
    url = ("https://raw.githubusercontent.com/huggingface/diffusers/v0.35.2/"
           "examples/text_to_image/train_text_to_image_lora_sdxl.py")
    with urllib.request.urlopen(url, timeout=20) as response:
        script.write_bytes(response.read(200_000))
    model = manifest["model"]
    revision = manifest["revision"]
    update({"phase": "Checking trainer imports and arguments"})
    preflight = subprocess.run([sys.executable, str(script), "--help"],
                               capture_output=True, text=True, errors="replace", timeout=90)
    if preflight.returncode:
        raise RuntimeError("Trainer preflight failed. " + preflight.stderr[-3000:])
    update({"phase": f"Training SDXL LoRA · {final} steps"})
    setup_seconds = time.monotonic() - started
    training_start = time.monotonic()
    env = {**os.environ, "HF_HUB_DISABLE_TELEMETRY": "1", "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1"}
    command = [
        sys.executable, str(script),
        "--pretrained_model_name_or_path=" + model, "--revision=" + revision, "--variant=fp16",
        "--train_data_dir=" + str(data), "--image_column=image", "--caption_column=text",
        "--output_dir=" + str(output), f"--resolution={resolution}", "--center_crop",
        "--train_batch_size=1", "--gradient_accumulation_steps=1", "--gradient_checkpointing",
        f"--max_train_steps={final}", f"--checkpointing_steps={midpoint}", f"--rank={rank}",
        "--learning_rate=0.0001", "--lr_scheduler=constant", "--lr_warmup_steps=0",
        "--mixed_precision=fp16", "--seed=42", "--report_to=tensorboard",
    ]
    with subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, errors="replace") as trainer:
        tail = []
        for line in trainer.stdout:
            tail = (tail + [line.strip()])[-30:]
            progress = re.search(rf"(\d+)/{final}\s*\[", line)
            if progress:
                update({"phase": "Training SDXL LoRA", "step": int(progress.group(1)), "totalSteps": final})
        if trainer.wait():
            raise RuntimeError("Training failed. " + "\n".join(tail)[-3500:])
    training_seconds = time.monotonic() - training_start

    update({"phase": "Generating 12 matched evaluation images"})
    evaluation_start = time.monotonic()
    pipe = StableDiffusionXLPipeline.from_pretrained(
        model, revision=revision, variant="fp16", torch_dtype=torch.float16,
        use_safetensors=True, token=False,
    ).to("cuda")
    comparisons = (
        ("Familiar subject", "Japanese botanical woodblock print on paper, white iris and a sparrow, muted colors and fine outlines."),
        ("Unseen subject", "Japanese botanical woodblock print on paper, purple pitcher plant with a cutaway showing its interior."),
        ("Style transfer", "Japanese botanical woodblock print on paper depicting a mechanical pocket watch as a specimen."),
        ("Control", "A modern studio photograph of a white iris on a black background."),
    )
    if dayton:
        comparisons = (
            ("Crystal", "dwstorybook illustration of Crystal Rowan, a short plus-size cottage witch with red-framed glasses, bright blue eyes, straight brown hair in a low ponytail and a silver crescent necklace, reading beside a snowy cottage window."),
            ("Root mischief", "dwstorybook illustration of Jazzy investigating a mossy root tangled around a wheelbarrow at a Dayton garden gate. Natural bark, gentle comedy, unlettered artwork."),
            ("New scene", "dwstorybook illustration of Crystal Rowan in a black dress with deep red plaid, cardigan and black work boots, helping David Bennett mend a garden gate beside a Dayton cottage after rain."),
            ("Control", "A modern studio photograph of a blue ceramic mug on a plain white background."),
        )
    if manifest.get("captionProfile") == "consistency-v1":
        comparisons = (
            ("Pair / porch", "dwstorybook. dwcrystal, Crystal Rowan, short and plus-size, blue eyes, red-framed glasses, straight brown ponytail, silver crescent necklace. Black dress with deep red plaid and cardigan. dwjazzy sits beside her on the Dayton cottage porch at dawn."),
            ("Pair / lantern walk", "dwstorybook. dwcrystal, Crystal Rowan, short and plus-size, blue eyes, red-framed glasses, straight brown ponytail, silver crescent necklace. Black dress with deep red plaid and cardigan. dwjazzy follows her past lanterns tangled in natural roots."),
            ("Jazzy alone", "dwstorybook. dwjazzy investigates a pumpkin nudged off its stand by the Undefeated Root. A natural mossy root and autumn leaves, warm light, gentle comedy, no lettering."),
            ("New cast / David", "dwstorybook. David Bennett, a sturdy dark-haired craftsman with warm brown eyes, flannel, jeans, work boots and a tape measure, repairs a Dayton garden gate. Grounded Midwest cottage fantasy, unlettered artwork."),
        )
    variants = [("Base", None), (f"LoRA {midpoint} steps", output / f"checkpoint-{midpoint}"), (f"LoRA {final} steps", output)]
    tile = 512 if profile else 320
    grid = Image.new("RGB", (tile * 3, (tile + 28) * 4 + 28), "#f4f2ed")
    draw = ImageDraw.Draw(grid)
    for column, (label, adapter) in enumerate(variants):
        draw.text((column * tile + 8, 8), label, fill="#151515")
        if adapter:
            pipe.load_lora_weights(str(adapter))
        for row, (category, prompt) in enumerate(comparisons):
            y = 28 + row * (tile + 28)
            image = pipe(prompt, height=resolution, width=resolution, num_inference_steps=inference_steps, guidance_scale=5,
                         generator=torch.Generator("cuda").manual_seed(42)).images[0]
            grid.paste(image.resize((tile, tile), Image.Resampling.LANCZOS), (column * tile, y + 28))
            draw.text((column * tile + 8, y + 8), category, fill="#151515")
        if adapter:
            pipe.unload_lora_weights()
    buffer = io.BytesIO()
    grid.save(buffer, format="PNG")
    artifacts = {
        label: base64.b64encode((folder / "pytorch_lora_weights.safetensors").read_bytes()).decode()
        for label, folder in ((f"step-{midpoint}", output / f"checkpoint-{midpoint}"), (f"step-{final}", output))
    }
    return {
        "phase": "Ready", "png": base64.b64encode(buffer.getvalue()).decode(),
        "device": torch.cuda.get_device_name(), "setupSeconds": setup_seconds,
        "runSeconds": training_seconds, "evaluationSeconds": time.monotonic() - evaluation_start,
        "seed": 42, "artifacts": artifacts, "prompts": dict(comparisons),
    }


def evaluate_botanical(update):
    import hashlib
    import pathlib
    import subprocess
    import sys
    import zipfile

    config = json.loads(os.environ["NPU_EVAL_CONFIG"])
    profile = config.get("training", {})
    checkpoints = profile.get("checkpoints", [60, 120])
    resolution = profile.get("resolution", 512)
    inference_steps = profile.get("inferenceSteps", 20)
    started = time.monotonic()
    update({"phase": "Installing comparison dependencies"})
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "diffusers==0.35.2",
                    "transformers==4.56.2", "accelerate==1.10.1", "peft==0.17.1", "safetensors"],
                   check=True, timeout=360)
    update({"phase": "Waiting for saved adapters"})
    if not dataset_ready.wait(600):
        raise TimeoutError("Saved adapter upload did not arrive.")
    from PIL import Image, ImageDraw
    from diffusers import StableDiffusionXLPipeline
    import torch

    root = pathlib.Path("/tmp/npu-lab-evaluation")
    root.mkdir(exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(dataset_bytes)) as archive:
        for step in checkpoints:
            filename = f"step-{step}.safetensors"
            raw = archive.read(filename)
            if hashlib.sha256(raw).hexdigest() != config["hashes"][filename]:
                raise ValueError(f"Adapter {step} did not match the local checkpoint.")
            (root / filename).write_bytes(raw)
    update({"phase": "Loading the pinned SDXL Base model"})
    pipe = StableDiffusionXLPipeline.from_pretrained(
        config["model"], revision=config["revision"], variant="fp16",
        torch_dtype=torch.float16, use_safetensors=True, token=False,
    ).to("cuda")
    ready = time.monotonic()
    grid = Image.new("RGB", (resolution * 3, resolution + 32), "#f4f2ed")
    draw = ImageDraw.Draw(grid)
    for column, step in enumerate((None, *checkpoints)):
        label = "SDXL Base" if step is None else f"LoRA {step} steps"
        update({"phase": "Generating " + label})
        if step is not None:
            pipe.load_lora_weights(str(root), weight_name=f"step-{step}.safetensors")
        image = pipe(config["prompt"], negative_prompt=config.get("negativePrompt") or None,
                     height=resolution, width=resolution, num_inference_steps=inference_steps, guidance_scale=5,
                     generator=torch.Generator("cuda").manual_seed(config["seed"])).images[0]
        grid.paste(image, (resolution * column, 32))
        draw.text((resolution * column + 10, 8), label, fill="#151515")
        if step is not None:
            pipe.unload_lora_weights()
    buffer = io.BytesIO()
    grid.save(buffer, format="PNG")
    return {"phase": "Ready", "png": base64.b64encode(buffer.getvalue()).decode(),
            "device": torch.cuda.get_device_name(), "setupSeconds": ready - started,
            "runSeconds": time.monotonic() - ready, "seed": config["seed"]}
