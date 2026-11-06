import base64
import io
import json
import sys
from contextlib import redirect_stdout
from time import perf_counter

wire = sys.stdout

kind, device, path = sys.argv[1:]
request = json.load(sys.stdin)
started = perf_counter()
import openvino_genai as genai

def stream(text):
    print(json.dumps({'delta': text}), file=wire, flush=True)
    return genai.StreamingStatus.RUNNING

def integer(key, default, low, high):
    value = request.get(key, default)
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{key} must be between {low} and {high}.")
    return value

with redirect_stdout(sys.stderr):
    if kind == "chat":
        messages = request["messages"]
        if not 1 <= len(messages) <= 13 or len(messages) % 2 != 1:
            raise ValueError("Send up to seven user messages with alternating replies.")
        history = genai.ChatHistory()
        for index, message in enumerate(messages):
            role = "assistant" if index % 2 else "user"
            content = message["content"]
            if message["role"] != role or not isinstance(content, str) or not 1 <= len(content.strip()) <= 2400:
                raise ValueError("Invalid chat message.")
            history.append({"role": role, "content": content})
        tokens = integer("tokens", 96, 1, 256)
        pipe = genai.LLMPipeline(path, device, **({"INFERENCE_NUM_THREADS": 2} if device == "CPU" else {}))
        loaded = perf_counter()
        response = pipe.generate(history, max_new_tokens=tokens, streamer=stream)
        result = {
            "text": response.texts[0],
            "tokens": response.perf_metrics.get_num_generated_tokens(),
            "inputTokens": response.perf_metrics.get_num_input_tokens()
                if hasattr(response.perf_metrics, "get_num_input_tokens") else None,
        }
    else:
        from PIL import Image
        prompt = request["prompt"].strip()
        if len(prompt) > 1000 or (kind == "image" and not prompt):
            raise ValueError("Enter an image prompt of up to 1000 characters.")
        seed = integer("seed", 42, 0, 2147483647)
        steps = integer("steps", 4, 1, 8)
        config = {"INFERENCE_NUM_THREADS": 2} if device == "CPU" else {}
        options = dict(width=256, height=256, num_inference_steps=steps, rng_seed=seed)
        negative = request.get("negativePrompt", "")
        if not isinstance(negative, str) or len(negative) > 1000:
            raise ValueError("Enter a negative prompt of up to 1000 characters.")
        if negative.strip():
            options.update(negative_prompt=negative.strip(), guidance_scale=7.5)
        if kind == "reference":
            import numpy as np
            from openvino import Tensor

            strength = request.get("strength", 0.5)
            if type(strength) not in (float, int) or not 0.25 <= strength <= 1:
                raise ValueError("Strength must be between 0.25 and 1.")
            if steps * strength < 1:
                raise ValueError("Increase steps or strength to allow at least one denoising step.")
            with Image.open(io.BytesIO(base64.b64decode(request["reference"], validate=True))) as source:
                if source.size != (256, 256):
                    raise ValueError("Reference input must be 256 × 256 pixels.")
                reference = np.array(source.convert("RGB"))
            pipe = genai.Image2ImagePipeline(path)
            pipe.reshape(1, 256, 256, 7.5)
            pipe.compile(device, **config)
            options.update(strength=float(strength), guidance_scale=7.5)
        else:
            pipe = genai.Text2ImagePipeline(path, device, **config)
        loaded = perf_counter()
        image = (pipe.generate(prompt, Tensor(reference[None]), **options)
                 if kind == "reference" else pipe.generate(prompt, **options))
        buffer = io.BytesIO()
        Image.fromarray(image.data[0]).save(buffer, format="PNG")
        result = {"png": base64.b64encode(buffer.getvalue()).decode("ascii"), "seed": seed}
        if kind == "reference":
            result["rgbDifference"] = float(np.abs(image.data[0].astype(np.float32) - reference).mean() / 255 * 100)
result.update(device=device, setupSeconds=loaded-started, runSeconds=perf_counter()-loaded)
print(json.dumps(result))

