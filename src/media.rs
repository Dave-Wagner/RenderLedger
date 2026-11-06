use std::{io, sync::Mutex, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

use serde_json::{Value, json};

const KEY: &str = "ELEVENLABS_API_KEY";
static QUOTA: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

pub fn configured_key() -> io::Result<String> {
    match crate::runpod::configured_key("ELEVENLABS_DEV_KEY") {
        Ok(key) => Ok(key),
        Err(dev_error) => crate::runpod::configured_key(KEY).map_err(|_| dev_error),
    }
}

fn local_checkpoint(variable: &str, default: &str, manifest: &str, script: &str) -> io::Result<String> {
    let path = crate::runpod::configured_key(variable).unwrap_or_else(|_| default.to_owned());
    if !std::path::Path::new(&path).join(manifest).is_file() {
        return Err(io::Error::other(format!(
            "Model files are missing in {path}. Run {script} or set {variable} to a complete checkpoint folder."
        )));
    }
    Ok(path)
}

pub fn music_checkpoint() -> io::Result<String> {
    local_checkpoint("NPU_LAB_MUSIC_MODEL", "models/musicgen-small", "config.json", "setup-musicgen.ps1")
}

pub fn video_checkpoint() -> io::Result<String> {
    let driver_paths = [("WINDIR", "System32/nvidia-smi.exe"),
        ("ProgramFiles", "NVIDIA Corporation/NVSMI/nvidia-smi.exe")];
    let installed = driver_paths.into_iter().any(|(variable, relative)| {
        std::env::var_os(variable).is_some_and(|root| std::path::Path::new(&root).join(relative).is_file())
    });
    let on_path = std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|path| path.join("nvidia-smi.exe").is_file())
    });
    if !installed && !on_path {
        return Err(io::Error::other("Local Wan is unavailable. It requires an NVIDIA CUDA GPU and driver."));
    }
    local_checkpoint("NPU_LAB_VIDEO_MODEL", "models/wan2.1-t2v-1.3b", "model_index.json", "setup-video.ps1")
}

pub fn quota() -> Value {
    let mut cache = QUOTA.lock().unwrap();
    if let Some((checked, value)) = &*cache
        && checked.elapsed() < Duration::from_secs(if value["error"].is_null() { 60 } else { 120 })
    {
        return value.clone();
    }
    let value = match fetch_quota() {
        Ok(mut value) => {
            value["updated"] = json!(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs());
            value
        }
        Err(error) => {
            let mut last = cache.as_ref().map(|(_, value)| value.clone()).unwrap_or_else(|| json!({}));
            last["error"] = json!(error.to_string());
            last
        }
    };
    *cache = Some((Instant::now(), value.clone()));
    value
}

fn fetch_quota() -> io::Result<Value> {
    let mut command = crate::genai::python_command()?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.args(["-X", "utf8", "-c", include_str!("media_worker.py"), "quota"])
        .env(KEY, configured_key()?);
    let output = command.stdin(std::process::Stdio::null()).output()?;
    if !output.status.success() {
        return Err(io::Error::other(String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

pub fn run(input: &[u8], mut emit: impl FnMut(&str) -> io::Result<()>) -> io::Result<Value> {
    let request: Value = serde_json::from_slice(input)?;
    let text = request["text"].as_str().unwrap_or_default().trim();
    let source = request["source"].as_str().unwrap_or_default();
    let voice = request["voice"].as_str().filter(|voice| !voice.is_empty())
        .unwrap_or("JBFqnCBsd6RMkjVDRZzb");
    let (model, location, mime, limit) = match source {
        "windows" => ("Windows System.Speech", "Local · CPU", "audio/wav", 1000),
        "eleven-speech" => ("eleven_multilingual_v2", "External · ElevenLabs", "audio/mpeg", 1000),
        "eleven-music" => ("music_v2_5", "External · ElevenLabs", "audio/mpeg", 500),
        "local-music" => ("MusicGen Small", "Local · CPU", "audio/wav", 500),
        "local-video" => ("Wan2.1 T2V 1.3B", "Local · CUDA", "video/mp4", 500),
        _ => return Err(io::Error::other("Choose an available media model.")),
    };
    if text.is_empty() || text.chars().count() > limit {
        return Err(io::Error::other(format!("Enter between 1 and {limit} characters.")));
    }
    if source == "eleven-speech"
        && (voice.len() > 64 || !voice.bytes().all(|byte| byte.is_ascii_alphanumeric()))
    {
        return Err(io::Error::other("Enter a valid ElevenLabs voice ID."));
    }
    let checkpoint = match source {
        "local-music" => Some(music_checkpoint()?),
        "local-video" => Some(video_checkpoint()?),
        _ => None,
    };
    let mut settings = json!({"version": 1, "source": source, "text": text, "model": model,
        "checkpoint": checkpoint, "voice": (source == "eleven-speech").then_some(voice)});
    if request["replay"].as_bool() == Some(true) {
        let mut result = crate::history::media_replay(&settings).map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => io::Error::other("No exact saved match. Choose Run fresh to generate one."),
            _ => io::Error::other(error),
        })?;
        result["replay"] = json!(true);
        return Ok(result);
    }
    let external = source.starts_with("eleven-");
    let dedicated_python = match source {
        "local-music" => Some(".runtime/musicgen-venv/Scripts/python.exe"),
        "local-video" => Some(".runtime/wan-venv/Scripts/python.exe"),
        _ => None,
    };
    let mut command = if let Some(python) = dedicated_python
        && std::path::Path::new(python).is_file()
    {
        let mut command = std::process::Command::new(std::env::current_dir()?.join(python));
        command.env_remove("PYTHONPATH");
        command
    } else {
        crate::genai::python_command()?
    };
    command.args(["-X", "utf8", "-c", include_str!("media_worker.py")])
        .env_remove(KEY)
        .env_remove("ELEVENLABS_DEV_KEY");
    if external {
        if request["allowPaid"].as_bool() != Some(true) {
            return Err(io::Error::other("Authorize this individual external request first."));
        }
        command.env(KEY, configured_key()?);
    }
    let saved_settings = settings.clone();
    if external {
        settings["allowSubscription"] = json!(
            crate::runpod::configured_key("NPU_LAB_ELEVENLABS_ALLOW_SUBSCRIPTION").as_deref().ok() == Some("1")
        );
        settings["musicCeiling"] = json!(crate::runpod::configured_key("NPU_LAB_ELEVENLABS_MUSIC_CREDIT_CEILING")
            .ok().and_then(|value| value.parse::<u32>().ok()));
    }
    let timeout = if checkpoint.is_some() { 600 } else { 90 };
    emit(&format!("progress:Starting {model} · {location} · {timeout}s time limit"))?;
    let start = Instant::now();
    let (audio, error, success) =
        crate::guard::run(&mut command, Some(settings.to_string().as_bytes()), timeout, &mut emit)?;
    if !success {
        return Err(io::Error::other(if error.trim().is_empty() {
            "Media worker exited without producing audio or video."
        } else {
            error.trim()
        }));
    }
    let output: Value = serde_json::from_str(audio.lines().last().unwrap_or_default())?;
    let result = json!({
        "audio": output["data"], "mime": mime, "model": model, "source": source, "location": location,
        "settings": saved_settings, "usage": output["usage"],
        "elapsedMs": start.elapsed().as_millis(), "text": text,
        "voice": if source == "eleven-speech" { Some(voice) } else { None },
        "billing": if external { "Check provider usage" } else { "No provider charge" },
    });
    emit("progress:Saving result to Media Studio history")?;
    crate::history::save_media(&result).map_err(io::Error::other)
}
