use serde_json::{Value, json};
use std::{
    env, fs, io,
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn worker_command() -> io::Result<Command> {
    let mut command = crate::genai::python_command()?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.stdin(Stdio::null());
    Ok(command)
}

static MONITOR: Mutex<Monitor> = Mutex::new(Monitor {
    active: false,
    stop: false,
    last: None,
    started: None,
    ended: None,
    next: None,
    phase: "Idle",
    checks: 0,
    errors: 0,
    events: Vec::new(),
});

struct Monitor {
    active: bool,
    stop: bool,
    last: Option<Value>,
    started: Option<u64>,
    ended: Option<u64>,
    next: Option<u64>,
    phase: &'static str,
    checks: u32,
    errors: u32,
    events: Vec<Value>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn status() -> Value {
    let state = MONITOR.lock().unwrap();
    json!({ "active": state.active, "last": state.last, "started": state.started,
        "ended": state.ended, "next": state.next, "phase": state.phase, "checks": state.checks,
        "errors": state.errors, "events": state.events })
}

pub fn stop() {
    let mut state = MONITOR.lock().unwrap();
    if state.active {
        state.stop = true;
        state.phase = "Stopping";
        state.next = None;
    }
}

const READONLY_KEY: &str = "RUNPOD_API_KEY_DEV_READONLY";

fn readonly_key() -> io::Result<String> {
    configured_key(READONLY_KEY)
}

pub(crate) fn configured_key(variable: &str) -> io::Result<String> {
    if let Ok(key) = env::var(variable)
        && !key.trim().is_empty()
    {
        return Ok(key.trim().to_owned());
    }
    match fs::read_to_string(".env") {
        Ok(contents) => {
            for line in contents.trim_start_matches('\u{feff}').lines() {
                let Some((name, value)) = line.split_once('=') else {
                    continue;
                };
                if name.trim() == variable {
                    let value = value.trim();
                    let value = value
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                        .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                        .unwrap_or(value);
                    if !value.is_empty() {
                        return Ok(value.to_owned());
                    }
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    Err(io::Error::other(format!(
        "Set {variable} in .env or the process environment."
    )))
}

static JOB: Mutex<bool> = Mutex::new(false);

pub fn job_running() -> bool {
    *JOB.lock().unwrap()
}

fn billing_request(mode: &str) -> io::Result<Value> {
    let output = worker_command()?
        .args(["-X", "utf8", "-c", include_str!("runpod_billing.py")])
        .arg(mode)
        .env("RUNPOD_API_KEY", configured_key("RUNPOD_API_KEY")?)
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other("Could not read Runpod billing."));
    }
    serde_json::from_slice(&output.stdout).map_err(io::Error::other)
}

pub fn billing() -> io::Result<Value> {
    billing_request("charges")
}

static BALANCE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

pub fn balance() -> Value {
    let mut cached = BALANCE.lock().unwrap();
    if let Some((expires, snapshot)) = cached.as_ref()
        && Instant::now() < *expires
    {
        return snapshot.clone();
    }
    let mut snapshot = billing_request("balance")
        .unwrap_or_else(|error| json!({ "balanceError": error.to_string() }));
    let interval = snapshot["retryAfter"].as_u64().unwrap_or(
        if snapshot["balance"].is_number() { 30 } else { 60 }
    );
    if snapshot["balance"].is_number() {
        snapshot["updated"] = snapshot["time"].clone();
    } else if let Some((_, previous)) = cached.as_ref() {
        snapshot["balance"] = previous["balance"].clone();
        snapshot["updated"] = previous["updated"].clone();
    }
    snapshot["next"] = json!(now().saturating_add(interval));
    let expires = Instant::now().checked_add(Duration::from_secs(interval));
    if let Some(expires) = expires {
        *cached = Some((expires, snapshot.clone()));
    }
    snapshot
}

pub fn job_status() -> Value {
    let running = *JOB.lock().unwrap();
    let state = fs::read("runpod-job/status.json")
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let pending = std::path::Path::new("runpod-job/pending.json").exists();
    let mut runs: Vec<Value> = fs::read_dir("runpod-job").into_iter().flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("run-")
            && entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| serde_json::from_slice(&fs::read(entry.path()).ok()?).ok())
        .collect();
    runs.sort_by(|a, b| b["started"].as_f64().partial_cmp(&a["started"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
    runs.truncate(20);
    json!({ "running": running, "state": state, "pending": pending, "runs": runs })
}

pub fn stop_job() -> io::Result<()> {
    let running = JOB.lock().unwrap();
    let directory = std::path::Path::new("runpod-job");
    if directory.is_dir() {
        fs::write(directory.join("stop"), unix_nanos().to_string())?;
    }
    let recover = !*running && directory.join("pending.json").is_file();
    drop(running);
    if recover {
        start_job("cleanup", None)?;
    }
    Ok(())
}

fn unix_nanos() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()
}

pub fn paid_job_configured() -> bool {
    configured_key("RUNPOD_API_KEY").is_ok() && readonly_key().is_ok()
}

pub fn start_job(mode: &str, options: Option<&str>) -> io::Result<()> {
    if mode == "train"
        && !["datasets/met-botanical-48.json", "datasets/met-botanical-train.zip"]
            .iter()
            .all(|path| std::path::Path::new(path).is_file())
    {
        return Err(io::Error::other("The verified botanical dataset files are missing."));
    }
    let mut running = JOB.lock().unwrap();
    if *running {
        return Err(io::Error::other("A Runpod job is already active."));
    }
    if mode != "cleanup" && std::path::Path::new("runpod-job/pending.json").is_file() {
        return Err(io::Error::other("Resolve the pending Runpod Pod before starting another."));
    }
    let key = configured_key("RUNPOD_API_KEY")?;
    let mut command = worker_command()?;
    let worker = format!("{}\n{}", include_str!("runpod_training.py"), include_str!("runpod_worker.py"));
    command.args([
        "-X",
        "utf8",
        "-c",
        include_str!("runpod_job.py"),
        mode,
        include_str!("runpod_catalog.py"),
    ]);
    // Keep the embedded worker out of the Windows command-line size limit.
    command.env("NPU_RUNPOD_WORKER_SOURCE", worker);
    if mode != "cleanup" {
        command.env(READONLY_KEY, readonly_key()?);
    }
    if let Some(options) = options {
        command.env("NPU_EVAL_OPTIONS", options);
    }
    fs::create_dir_all("runpod-job")?;
    let mut child = command
        .env("RUNPOD_API_KEY", key)
        .env("NPU_RUNPOD_STARTED_NS", unix_nanos().to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    *running = true;
    thread::spawn(move || {
        let _ = child.wait();
        *JOB.lock().unwrap() = false;
    });
    Ok(())
}

pub fn start() -> io::Result<()> {
    let key = readonly_key()?;
    let mut state = MONITOR.lock().unwrap();
    if state.active {
        return Err(io::Error::other("The Runpod watch is already running."));
    }
    state.active = true;
    state.stop = false;
    state.last = None;
    state.started = Some(now());
    state.ended = None;
    state.next = None;
    state.phase = "Starting";
    state.checks = 0;
    state.errors = 0;
    state.events.clear();
    thread::spawn(move || watch(&key));
    Ok(())
}

fn watch(key: &str) {
    let deadline = Instant::now() + Duration::from_secs(7200);
    let mut rate_limited = false;
    while Instant::now() < deadline {
        {
            let mut state = MONITOR.lock().unwrap();
            if state.stop {
                break;
            }
            state.phase = "Checking Runpod";
            state.next = None;
        }
        let started = Instant::now();
        let result = catalog(key);
        {
            let mut state = MONITOR.lock().unwrap();
            let timestamp = now();
            state.checks += 1;
            let check = state.checks;
            let elapsed = started.elapsed().as_millis();
            let event = match result {
                Ok(rows) => json!({ "check": check, "time": timestamp, "gpu": cheapest(&rows),
                    "rows": rows.len(), "elapsed": elapsed }),
                Err(error) => {
                    state.errors += 1;
                    rate_limited = error.to_string().contains("HTTP 429");
                    json!({ "check": check, "time": timestamp, "error": error.to_string(), "elapsed": elapsed })
                }
            };
            state.last = Some(event.clone());
            state.events.push(event);
            if !state.stop {
                state.phase = "Waiting for next check";
                let remaining = deadline.saturating_duration_since(Instant::now());
                state.next = (remaining >= Duration::from_secs(60)).then_some(timestamp + 60);
            }
        }
        if rate_limited {
            break;
        }
        for _ in 0..60 {
            if MONITOR.lock().unwrap().stop || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_secs(1));
        }
    }
    let mut state = MONITOR.lock().unwrap();
    state.active = false;
    state.ended = Some(now());
    state.next = None;
    state.phase = if rate_limited {
        "Paused by Runpod rate limit"
    } else if state.stop {
        "Stopped"
    } else {
        "Watch complete"
    };
}

fn catalog(key: &str) -> io::Result<Vec<Value>> {
    let output = worker_command()?
        .args(["-X", "utf8", "-c", include_str!("runpod_catalog.py")])
        .env(READONLY_KEY, key)
        .env_remove("RUNPOD_API_KEY")
        .output()?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(io::Error::other(
            message
                .lines()
                .last()
                .unwrap_or("Runpod catalog query failed."),
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(io::Error::other)
}

fn cheapest(rows: &[Value]) -> Option<Value> {
    rows.iter()
        .filter_map(|row| {
            let id = row["id"].as_str()?;
            let name = row["displayName"].as_str()?;
            let memory = row["memoryInGb"].as_f64()?;
            let quote = &row["lowestPrice"];
            let price = quote["uninterruptablePrice"].as_f64()?;
            let stock = quote["stockStatus"].as_str()?;
            // The query already requests one GPU. Some live quotes omit the count list.
            let counts = &quote["availableGpuCounts"];
            let supports_single = counts.is_null()
                || counts
                    .as_array()
                    .is_some_and(|counts| counts.iter().any(|n| n.as_u64() == Some(1)));
            if !id.to_ascii_uppercase().contains("NVIDIA")
                || memory < 16.0
                || price <= 0.0
                || !matches!(stock, "Low" | "Medium" | "High")
                || !supports_single
            {
                return None;
            }
            Some((
                price,
                json!({ "id": id, "name": name, "vram": memory, "rate": price, "stock": stock }),
            ))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, gpu)| gpu)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_cheapest_eligible_single_gpu() {
        let offer = |id: &str, memory: u64, price: f64, stock: &str, counts: &[u64]| {
            json!({
                "id": id, "displayName": id, "memoryInGb": memory,
                "lowestPrice": { "uninterruptablePrice": price, "stockStatus": stock, "availableGpuCounts": counts }
            })
        };
        let mut rows = [
            offer("NVIDIA sold out", 24, 0.20, "None", &[]),
            offer("NVIDIA too small", 8, 0.10, "High", &[1]),
            offer("NVIDIA pair only", 24, 0.15, "High", &[2]),
            offer("AMD incompatible", 48, 0.16, "High", &[1]),
            offer("NVIDIA higher rate", 48, 0.59, "High", &[1]),
            offer("NVIDIA lowest rate", 16, 0.29, "Low", &[1]),
        ];
        assert_eq!(cheapest(&rows).unwrap()["id"], "NVIDIA lowest rate");
        rows[4]["lowestPrice"]["availableGpuCounts"] = Value::Null;
        rows[4]["lowestPrice"]["uninterruptablePrice"] = json!(0.25);
        assert_eq!(cheapest(&rows).unwrap()["id"], "NVIDIA higher rate");
    }
}
