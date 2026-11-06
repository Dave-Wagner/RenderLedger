"""Bridge between the Rust workbench and OpenVINO's local inference API."""

import json
import sys
from time import perf_counter

import numpy as np
import openvino as ov

model, device, path = sys.argv[1:]
pixels = np.frombuffer(bytes.fromhex(sys.stdin.read()), dtype=np.uint8)
image = pixels.reshape(28, 28).astype(np.float32) / 255
core = ov.Core()
started = perf_counter()
compiled = core.compile_model(path, device, {"INFERENCE_NUM_THREADS": 2} if device == "CPU" else {})
compile_ms = (perf_counter() - started) * 1000

if model == "mnist":
    tensor = image.reshape(1, 1, 28, 28)
else:
    side = compiled.input().shape[2]
    indices = np.arange(side) * 28 // side
    expanded = image[np.ix_(indices, indices)]
    tensor = np.broadcast_to(expanded, (1, 3, side, side)).copy()

started = perf_counter()
output = np.asarray(compiled([tensor])[compiled.output()], dtype=np.float32)
inference_ms = (perf_counter() - started) * 1000
devices = compiled.get_property("EXECUTION_DEVICES")
result = {
    "devices": [devices] if isinstance(devices, str) else list(devices),
    "compileMs": compile_ms,
    "inferenceMs": inference_ms,
}

if model == "mnist":
    logits = output.reshape(10)
    weights = np.exp(logits - logits.max())
    result["scores"] = (weights / weights.sum()).tolist()
else:
    channels = output[0]
    index = int(channels.mean(axis=(1, 2)).argmax())
    activation = channels[index]
    peak = float(activation.max())
    indices = np.arange(28) * activation.shape[0] // 28
    sampled = activation[np.ix_(indices, indices)]
    result.update(
        channel=index,
        peak=peak,
        heatmap=(sampled / peak if peak else sampled).ravel().tolist(),
    )

print(json.dumps(result, allow_nan=False))

