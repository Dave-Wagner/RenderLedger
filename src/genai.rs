use std::{env, io, path::Path, process::Command};

const CHAT_MODELS: [(&str, &str, &str); 2] = [
    ("baseline", "Qwen2 0.5B Instruct INT4", "models/chat"),
    ("qwen25-7b", "Qwen2.5 7B Instruct INT4", "models/chat-qwen25-7b"),
];

pub fn chat_models() -> serde_json::Value {
    serde_json::json!(CHAT_MODELS.map(|(id, label, path)| serde_json::json!({
        "id": id, "label": label,
        "installed": Path::new(path).join("openvino_model.bin").is_file(),
    })))
}

pub fn max_input(kind: &str) -> usize {
    if matches!(kind, "image" | "reference") {
        262_144
    } else {
        32_768
    }
}

pub fn run(kind: &str, device: &str, input: &[u8]) -> io::Result<String> {
    run_stream(kind, device, input, |_| Ok(()))
}

pub fn run_stream(
    kind: &str,
    device: &str,
    input: &[u8],
    emit: impl FnMut(&str) -> io::Result<()>,
) -> io::Result<String> {
    if !matches!(
        (kind, device),
        ("chat", "CPU" | "GPU" | "NPU")
            | ("image", "CPU" | "GPU")
            | ("reference", "CPU" | "GPU" | "NPU")
    ) {
        return Err(io::Error::other("Unsupported task or device."));
    }
    if input.is_empty() || input.len() > max_input(kind) {
        return Err(io::Error::other("The request is empty or too large."));
    }
    let chat_model = if kind == "chat" {
        let request: serde_json::Value = serde_json::from_slice(input)?;
        let id = request["model"].as_str().unwrap_or("baseline");
        Some(CHAT_MODELS.iter().find(|entry| entry.0 == id)
            .ok_or_else(|| io::Error::other("Unknown chat model."))?)
    } else {
        None
    };
    let model = Path::new(chat_model.map_or("models/image", |entry| entry.2));
    let marker = if kind == "chat" {
        "openvino_model.bin"
    } else {
        "unet/openvino_model.bin"
    };
    if !model.join(marker).is_file() {
        return Err(io::Error::other(
            "Model files are missing. See the GenAI setup in README.md.",
        ));
    }
    if kind == "reference" && !model.join("vae_encoder/openvino_model.bin").is_file() {
        return Err(io::Error::other(
            "The reference mode needs the VAE encoder. Download the full image model as shown in README.md.",
        ));
    }
    let mut command = python_command()?;
    command
        .args([
            "-X",
            "utf8",
            "-c",
            include_str!("generate_openvino.py"),
            kind,
            device,
        ])
        .arg(env::current_dir()?.join(model));
    let output = execute(
        &mut command,
        input,
        if chat_model.is_some_and(|entry| entry.0 == "qwen25-7b") { 300 }
        else if kind == "chat" { 60 } else { 150 },
        emit,
    )?;
    if let Some((_, label, _)) = chat_model {
        let mut result: serde_json::Value = serde_json::from_str(&output)?;
        result["model"] = serde_json::json!(label);
        return Ok(result.to_string());
    }
    Ok(output)
}

pub(crate) fn python_command() -> io::Result<Command> {
    if let Some(python) = env::var_os("NPU_LAB_GENAI_PYTHON") {
        return Ok(Command::new(python));
    }
    let venv = if cfg!(windows) { ".genai-venv/Scripts/python.exe" } else { ".genai-venv/bin/python" };
    if Path::new(venv).is_file() {
        return Ok(Command::new(env::current_dir()?.join(venv)));
    }
    if cfg!(windows) && let Some(profile) = env::var_os("USERPROFILE") {
        let python = Path::new(&profile)
            .join(".cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe");
        if python.is_file() {
            let mut command = Command::new(python);
            command.env("PYTHONPATH", env::current_dir()?.join(".genai"));
            return Ok(command);
        }
    }
    Ok(Command::new(if cfg!(windows) { "python.exe" } else { "python3" }))
}

fn execute(
    command: &mut Command,
    input: &[u8],
    seconds: u64,
    emit: impl FnMut(&str) -> io::Result<()>,
) -> io::Result<String> {
    let (output, errors, ok) = crate::guard::run(command, Some(input), seconds, emit)?;
    if !ok {
        return Err(io::Error::other(errors.trim().to_owned()));
    }
    output
        .lines()
        .last()
        .map(str::to_owned)
        .ok_or_else(|| io::Error::other("Generation returned no result."))
}
