# RenderLedger

A Rust CLI and local browser workbench for comparing AI models across chat, images, speech, music, and video. It tracks outputs, performance, and costs across local hardware and cloud providers.

RenderLedger was previously called NPU Lab. It reads the existing history database and browser settings when started from the same workspace and dashboard address.

## Start here

```powershell
cargo run --release -- probe
cargo run --release -- suite 50
cargo run --release -- gui
```

Open [the dashboard](http://127.0.0.1:8765). **Detect hardware** shows the connected GPU and accelerator. **Run benchmark** compares CPU, GPU, and NPU using either the three convolution graphs or the MNIST digit classifier. Switch the chart between median warm latency, first inference, and throughput. The raw log includes compilation and device details. The dashboard binds only to the loopback address and reports results after the run completes.

## Internal distribution

On Windows x64, run `powershell -NoProfile -File .\package-windows.ps1` from the project folder. The ZIP and its SHA-256 checksum appear in `target/distribution/packages`. Recipients extract it into a writable folder and open `Start-RenderLedger.cmd`. The ZIP contains the app, license, and setup instructions. Each recipient supplies their own credentials, model weights, and optional local inference runtime.

For Authenticode signing, pass `-CertificateThumbprint <thumbprint> -SignTool <path-to-signtool.exe>` on a machine with access to the code-signing certificate and its private key. The script signs and timestamps the executable and verifies its signature before creating the signed ZIP. A signature identifies the publisher. SmartScreen reputation and an organization's App Control policy still determine what users can run. For managed PCs, ask IT to approve the signer or deploy an allow rule. [Microsoft SmartScreen and signing guidance](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)

The [Linux ARMv7 workflow](.github/workflows/build-armv7.yml) cross-compiles for `armv7-unknown-linux-gnueabihf`, runs the CLI and dashboard under QEMU, and uploads a tarball and checksum. Use **Actions → Build Linux ARMv7 → Run workflow** after the workflow is on GitHub. The target is 32-bit ARMv7 Linux with glibc and hard-float support. The workflow checks the dashboard and SQLite history. Local inference requires an ARM-compatible runtime and model, and remote integrations require Python 3 and provider credentials.

## Try a model by hand

- **MNIST digit classifier.** Draw a digit or choose an expected digit and load a typeset sample. Run the same drawing across devices to compare scores and predictions. The optional expected label records a match or mismatch. The scores come from a softmax over the model outputs and do not measure accuracy on their own.
- **Convolution visualizer.** Pick any of the three synthetic graphs and draw a line, loop, or corner. The heatmap shows the output channel with the highest average activation. Each heatmap uses its own peak for scaling, and the result shows that peak separately. These fixed filters have no learned classes.

The trial log keeps results in the current page session. Drawings run locally. Each task invocation compiles the model and reports compilation time and first-call time separately. Use the benchmark chart for repeated warm measurements.

The ONNX Model Zoo weights are already in this checkout. To restore them on another checkout:

```powershell
New-Item -ItemType Directory -Force models | Out-Null
curl.exe -fL https://huggingface.co/onnxmodelzoo/mnist-8/resolve/main/mnist-8.onnx -o models/mnist-8.onnx
Get-FileHash models/mnist-8.onnx
```

Expected SHA-256 is `2f06e72de813a8635c9bc0397ac447a601bdbfa7df4bebc278723b958831c9bf`. [ONNX Model Zoo model card](https://huggingface.co/onnxmodelzoo/mnist-8)

## Install the inference runtime

This checkout has a project-local OpenVINO 2026.4.1 runtime under `.runtime`. The runner discovers it when launched from the project folder. The task playground uses the same OpenVINO installation through a small Python bridge. On a fresh checkout, use a supported 64-bit Python installation to create a project-local environment.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install openvino
cargo run --release -- suite 50
```

[OpenVINO installation](https://docs.openvino.ai/2026/get-started/install-openvino/install-openvino-pip.html) · [Benchmark tool reference](https://docs.openvino.ai/nightly/get-started/learn-openvino/openvino-samples/benchmark-tool.html)

## Bring your own model

```powershell
cargo run --release -- generate
cargo run --release -- bench .\models\conv-large.xml NPU 100
cargo run --release -- bench "C:\path\to\model.onnx" all 100
```

Keep an OpenVINO XML model's paired BIN file alongside it. For an ONNX model, keep any external weights in their original relative paths. Start with static input shapes. The runner uses synthetic inputs and does not evaluate task accuracy. Generative-model prefill and tokens per second require a generation-specific workload.

For new manual tasks, add the input preparation and output decoding for the model in `src/task_openvino.py`, register the model in `src/tasks.rs`, and add the appropriate controls in the dashboard. For example, a text model needs a tokenizer and a generation loop, while an object detector needs image resizing and a way to map boxes back to the original image.

| Workload | Input | Output channels |
|---|---|---:|
| conv-small | 1 × 3 × 32 × 32 | 16 |
| conv-wide | 1 × 3 × 64 × 64 | 32 |
| conv-large | 1 × 3 × 128 × 128 | 64 |

## First run on this laptop

Median steady-state inference latency in milliseconds over 50 synchronous iterations per model and device. The laptop has an Intel Core Ultra 5 225U with Intel Graphics and Intel AI Boost.

| Workload | CPU | GPU | NPU |
|---|---:|---:|---:|
| conv-small | 0.050 | 0.034 | 0.546 |
| conv-wide | 0.279 | 0.155 | 0.660 |
| conv-large | 1.580 | 0.658 | 1.370 |

OpenVINO reported NPU execution for all three NPU runs. Its first inference took 134–442 ms across the suite. The run measured synthetic inference latency and throughput. Power, battery impact, model accuracy, and text generation were outside this run.

Each run requests an explicit device and uses synchronous inference with the latency hint. OpenVINO reports latency and throughput. Model compilation and initial inference can have different costs from steady-state inference. Device plugins can choose different internal precisions, so compare these numbers as deployed latency, not as a precision-controlled hardware test. Unsupported models or unavailable devices show the runtime error and no measurement. For longer comparisons, run plugged in with the same power mode, close other busy applications, and repeat each experiment.

## Local chat and image generation

Use **Chat rooms** or **Image studio** in the dashboard. Qwen2 0.5B Instruct (INT4) handles short prompts and follow-up turns. The dashboard streams replies as they arrive. Rooms are stored in this browser for the dashboard address. The model sees up to six previous exchanges per turn. Stable Diffusion 1.5 (INT8 OpenVINO export) generates a 256 × 256 preview PNG with adjustable seed and up to eight steps. Save the PNG using the link beneath the preview. The device label shows the explicit target passed to OpenVINO GenAI. Each request starts a new pipeline, so setup and generation have separate timings.

Model sources: [Qwen2 0.5B Instruct](https://huggingface.co/OpenVINO/Qwen2-0.5B-Instruct-int4-ov) and [Stable Diffusion 1.5](https://huggingface.co/OpenVINO/stable-diffusion-v1-5-int8-ov).

On a fresh checkout, use a 64-bit Python environment to install the runtime and download the model folders:

```powershell
python -m venv .genai-venv
.\.genai-venv\Scripts\python.exe -m pip install openvino-genai==2026.4.1.0 huggingface_hub pillow
.\.genai-venv\Scripts\hf.exe download OpenVINO/Qwen2-0.5B-Instruct-int4-ov --local-dir models/chat --exclude "*checkpoint*"
.\.genai-venv\Scripts\hf.exe download OpenVINO/stable-diffusion-v1-5-int8-ov --local-dir models/image
```

Generation runs locally after downloading the files. If using a different Python environment, set NPU_LAB_GENAI_PYTHON to its Python executable.

```powershell
'{"messages":[{"role":"user","content":"Suggest three names for a moon garden."}],"tokens":64}' | cargo run --release -- gen chat CPU
$reply = '{"prompt":"Watercolor fox in an autumn forest","seed":42,"steps":4}' | cargo run --release -- gen image CPU | ConvertFrom-Json
[IO.File]::WriteAllBytes((Join-Path (Get-Location) 'fox.png'), [Convert]::FromBase64String($reply.png))
```

On this laptop, the Qwen export answered on CPU and integrated GPU. The Intel NPU rejected compilation with both the driver compiler and the OpenVINO bundled compiler. The NPU option is available for retesting and reports the runtime error directly.

Before the preview limits, the first 10-step integrated GPU run produced a 512 × 512 PNG in roughly 94 seconds of setup and 168 seconds of generation. This was a functional test with overlapping system work, so the figures are a rough guide to wait time.
A separate 10-step CPU run also produced a PNG, with roughly 45 seconds of setup and 162 seconds of generation.


## Workload controls

The dashboard runs one workload at a time. **Stop active workload** cancels the running child process. CPU workloads use two OpenVINO inference threads and inference processes run below normal priority on Windows. The per-process deadlines are 30 seconds for drawing, 45 seconds per benchmark target, 60 seconds for chat, and 150 seconds for image previews. Benchmark numbers taken before these limits used different CPU settings.

Separate CLI processes are independent of the dashboard workload queue.

Try **Tiny story** or **Easy explanation** in Chat rooms, or **Watercolor fox** and **Moonlit library** in Image studio. Sample buttons fill the prompt so you can edit it before running.


### Compare a reference image

In **Image studio**, choose a PNG, JPEG, or WebP. The browser fits it onto a 256 × 256 canvas with black padding as needed and shows the exact preview sent to the local image-to-image pipeline. Leave the prompt blank to test reconstruction or add a prompt to guide changes. Keep strength, steps, seed, and prompt fixed while running CPU, GPU, and NPU in turn. Changing settings starts a new comparison on the next run.

Each device card shows the output, timing, and average RGB pixel difference, or the runtime error if the model cannot run on that device. A lower RGB difference means the pixel values are closer. Judge visual similarity from the images themselves. NPU uses an explicit target, so unsupported model operations appear as an error. **Stop active workload** also cancels reference runs.


## Image experiments

- [Save and compare image runs](docs/image-experiments.md)
- [Archived Colab experiment](archive/colab/README.md)

RenderLedger source code is licensed under the [MIT License](LICENSE). Model weights have their own upstream licenses.

## Runpod capacity watch

Open **Runpod** in the dashboard to see the cheapest quoted on-demand Secure Cloud GPU with at least 16 GB of VRAM. The watch checks once a minute for two hours. Quotes show GPU rates before disk and are subject to capacity at deployment.

Set RUNPOD_API_KEY_DEV_READONLY in the project .env file or in the process environment. Start RenderLedger from the project folder. Choose **Enable browser alerts**, grant browser permission, and select **Start watching**. Keep the dashboard tab open for desktop alerts. The catalog watch itself runs in the dashboard server.

The monitor only reads the catalog. Runpod's current CLI guidance says the older automatic Pod shutdown flags never worked. Unattended deployment needs a verified shutdown mechanism that survives laptop disconnects. [Runpod CLI guidance](https://github.com/runpod/runpod-plugins-official/blob/main/plugins/runpod/skills/runpodctl/SKILL.md)


## Dashboard styles

The Runpod view and shared navigation use Tailwind CSS and daisyUI. Rust serves the compiled stylesheet locally. To rebuild it after changing dashboard styles or classes, run `npm ci` and `npm run build:css` from the project folder, then rebuild the Rust app.

## Runpod one-shot image test

In **Runpod**, choose **Arm one paid test** to wait for the cheapest eligible single Secure Cloud NVIDIA GPU with at least 16 GB of VRAM. The runner waits up to two hours and selects a catalog quote under $0.65/hour including estimated disk. It uses a fixed public prompt and SDXL Turbo, saves the output under **Saved image runs**, and verifies that the Pod is deleted. The actual Pod rate is checked immediately after creation. A mismatch triggers cleanup, though a brief charge can already have accrued.

The backend reads RUNPOD_API_KEY for Pod operations and RUNPOD_API_KEY_DEV_READONLY for catalog queries. The Pod receives a per-job result token. **Cancel test** stops waiting or requests cleanup. The local 20-minute deadline and cleanup depend on this computer staying online. If cleanup cannot be confirmed, the app retains the Pod ID or unique name and blocks further rentals until the previous request is resolved. Use **Retry Pod cleanup** to resume that operation. After an ambiguous creation response, check the Runpod console if the app cannot reconcile the Pod by name.

## Botanical LoRA pilot

The **Arm botanical LoRA pilot** button runs one SDXL Base fine-tuning job on Runpod. The [Met botanical manifest](datasets/met-botanical-48.json) pins 48 Japanese botanical woodblock prints from the Met Open Access dataset, including 40 training images and eight held-out references. The local runner verifies the cached training archive before renting a Pod, then uploads it over an authenticated connection. The worker verifies those same hashes before training. The public dataset and base weights require no Hugging Face key.

The pilot trains a rank-4 adapter at 512 × 512 for 120 steps. It saves the 60- and 120-step adapters and compares both with the base model using four fixed prompts and a fixed seed. The comparison grid appears under **Saved image runs**, and the run card shows the adapter directory and stage timings. The Runpod view refreshes billing automatically and updates the charge on each run card when Runpod posts it.

The pilot waits for a single NVIDIA Secure Cloud GPU with at least 24 GB VRAM within the $0.65/hour quoted ceiling. It requests cleanup at its two-hour local Pod deadline. At the ceiling, two hours is about $1.30 before any time needed to confirm cleanup. Keep this laptop connected until deletion is verified.


## Media Studio

On Windows, run `powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-musicgen.ps1` for local music or `powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-video.ps1` for local video. Restart the rebuilt dashboard after setup. The app looks for checkpoints in `models/musicgen-small` and `models/wan2.1-t2v-1.3b` by default. Set the model path variables below only when using a different folder. Wan setup checks for NVIDIA hardware and verifies CUDA before downloading the checkpoint.

Open **Media Studio** for Windows CPU speech, ElevenLabs Multilingual v2 speech, and ElevenLabs Music v2.5. Use the same sample text across the speech engines and choose two saved runs to listen side by side. The local SQLite database stores successful audio outputs, prompts, selected models, voices and runtime. Replay a saved run to avoid generating it again.

Create a restricted key in [Developers → API Keys](https://elevenlabs.io/app/api/api-keys). Enable Text to Speech and User/Subscription read access and set a provider-side key credit limit. Copy the key at creation into `ELEVENLABS_DEV_KEY` in `.env`. Media Studio shows the provider's included-credit balance and checks it again before every fresh hosted request. If the balance cannot be verified or the request would leave fewer than 10% of included credits (minimum 500), the app blocks generation. Free plans are the default. To enable a supported subscription with overages disabled, set `NPU_LAB_ELEVENLABS_ALLOW_SUBSCRIPTION=1`. Hosted music also requires Music permission and `NPU_LAB_ELEVENLABS_MUSIC_CREDIT_CEILING` set to a conservative per-clip estimate for that plan. Use a provider key limit to enforce a cap across concurrent activity.

Windows speech uses an installed desktop voice. For ElevenLabs, set `ELEVENLABS_DEV_KEY` in the gitignored project `.env` or server environment. Existing `ELEVENLABS_API_KEY` setups are supported as a fallback. The browser receives only whether the key is configured. Use a key with the permissions needed for the models you plan to run. Each external request requires approval and sends its input to ElevenLabs. Music requests are limited to a ten-second instrumental clip. Check the provider dashboard for actual charges.

**Stop active workload** cancels the local worker. A submitted ElevenLabs request may continue processing and incur a charge. The app makes no automatic retries. Check provider usage before repeating a failed or stopped request.

**Replay exact match** looks up a previous result for the selected model, settings and prompt. It skips generation and records no new charge or timing sample. **Run fresh** always invokes the selected model. Runs created before exact replay was added remain available in the history selectors. Use versioned checkpoint directories when replacing local models.

For local music, install PyTorch and Transformers into the Python environment used by RenderLedger, place a complete `facebook/musicgen-small` checkpoint on disk, and set `NPU_LAB_MUSIC_MODEL` to that directory in `.env`. For local video, install CUDA PyTorch, Diffusers, Transformers, Accelerate, and `imageio[ffmpeg]`, then set `NPU_LAB_VIDEO_MODEL` to a complete `Wan-AI/Wan2.1-T2V-1.3B-Diffusers` checkpoint directory. The adapters use local files only. Video produces a short 512 × 320 clip and requires an NVIDIA CUDA GPU. Either local workload can be stopped and has a ten-minute deadline.

Local chat records the token counts exposed by OpenVINO in SQLite without saving chat text in the usage table. Hosted audio saves the provider's character cost when returned. Actual billed amounts come from the provider.

**Model guide** distinguishes local and external runs and suggests what to measure before investing in training.

