use std::{env, io, path::Path, process::Command};

pub fn run(model: &str, device: &str, pixels: &str) -> io::Result<String> {
    if !crate::DEVICES.contains(&device) {
        return Err(io::Error::other("Choose CPU, GPU, or NPU."));
    }
    if pixels.len() != 28 * 28 * 2 || !pixels.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(io::Error::other("Expected a 28 × 28 grayscale drawing."));
    }
    let path = match model {
        "mnist" => {
            let path = Path::new("models/mnist-8.onnx");
            if !path.is_file() {
                return Err(io::Error::other(
                    "The MNIST model is missing. See the download command in README.md.",
                ));
            }
            path.to_path_buf()
        }
        "conv-small" | "conv-wide" | "conv-large" => crate::models::generate()?
            .into_iter()
            .find(|path| path.file_stem().is_some_and(|stem| stem == model))
            .ok_or_else(|| io::Error::other("Generated model is missing."))?,
        _ => return Err(io::Error::other("Unknown task model.")),
    };

    let root = env::current_dir()?;
    let venv = root.join(".venv/Scripts/python.exe");
    let local = root.join(".runtime");
    let bundled = env::var_os("USERPROFILE").map(|profile| {
        Path::new(&profile)
            .join(".cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe")
    });
    let mut command = if let Some(python) = env::var_os("NPU_LAB_PYTHON") {
        Command::new(python)
    } else if venv.is_file() {
        Command::new(venv)
    } else if let Some(python) = bundled.filter(|path| path.is_file() && local.is_dir()) {
        let mut command = Command::new(python);
        command.env("PYTHONPATH", local);
        command
    } else {
        crate::genai::python_command()?
    };

    command
        .args([
            "-X",
            "utf8",
            "-c",
            include_str!("task_openvino.py"),
            model,
            device,
        ])
        .arg(path.canonicalize()?);
    let (output, errors, ok) =
        crate::guard::run(&mut command, Some(pixels.as_bytes()), 30, |_| Ok(()))?;
    if ok {
        Ok(output)
    } else {
        Err(io::Error::other(errors.trim().to_owned()))
    }
}
