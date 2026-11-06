mod genai;
mod guard;
mod gui;
mod history;
mod media;
mod models;
mod runpod;
mod tasks;

use std::{
    env, io,
    path::Path,
    process::{Command, ExitCode},
};

const DEVICES: [&str; 3] = ["CPU", "GPU", "NPU"];
const HELP: &str = "renderledger commands
  probe                                  Show Windows accelerator devices
  generate                               Create the synthetic models in models/
  suite [iterations]                     Compare all generated models on CPU, GPU, NPU
  bench <model> <CPU|GPU|NPU|all> [iterations]
                                         Benchmark a local ONNX or OpenVINO IR model
  gui [port|--open]                             Start the loopback dashboard (default 8765)
  gen <chat|image|reference> <device>              Run local generation from JSON on stdin
Set NPU_LAB_RUNNER to the full path of benchmark_app.exe if it isn't on PATH.";

fn main() -> ExitCode {
    match run(&env::args().skip(1).collect::<Vec<_>>()) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn iterations(value: Option<&str>) -> io::Result<u32> {
    value
        .unwrap_or("50")
        .parse::<u32>()
        .ok()
        .filter(|n| (1..=10_000).contains(n))
        .ok_or_else(|| io::Error::other("Iterations must be between 1 and 10000."))
}

fn run(args: &[String]) -> io::Result<bool> {
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    match args.as_slice() {
        [] | ["--help" | "-h"] => println!("{HELP}"),
        ["probe"] => {
            let (report, ok) = probe()?;
            print!("{report}");
            return Ok(ok);
        }
        ["generate"] => {
            for path in models::generate()? {
                println!("{}", path.display());
            }
        }
        ["gui"] => gui::serve()?,
        ["gen", kind, device] => {
            use std::io::Read;
            let mut input = Vec::new();
            io::stdin()
                .take((genai::max_input(kind) + 1) as u64)
                .read_to_end(&mut input)?;
            if input.len() > genai::max_input(kind) {
                return Err(io::Error::other("The request is too large."));
            }
            let run_id = if matches!(*kind, "image" | "reference") {
                Some(history::start(kind, device, &input)?)
            } else {
                None
            };
            let result = genai::run(kind, device, &input);
            if let Some(id) = run_id {
                history::finish(id, &result).map_err(io::Error::other)?;
            }
            println!("{}", result?);
        }
        ["gui", "--open"] => gui::serve_and_open()?,
        ["gui", port] => {
            let port = port
                .parse()
                .map_err(|_| io::Error::other("Invalid dashboard port."))?;
            gui::serve_on(port)?;
        }
        ["suite"] | ["suite", _] => {
            return suite(iterations(args.get(1).copied())?, |report| {
                print!("{report}")
            });
        }
        ["bench", model, device] | ["bench", model, device, _] => {
            let count = iterations(args.get(3).copied())?;
            let devices = match *device {
                "all" => &DEVICES[..],
                "CPU" | "GPU" | "NPU" => std::slice::from_ref(device),
                _ => return Err(io::Error::other("Choose CPU, GPU, NPU, or all.")),
            };
            return compare(Path::new(model), devices, count, &mut |report| {
                print!("{report}")
            });
        }
        _ => return Err(io::Error::other(HELP)),
    }
    Ok(true)
}

fn probe() -> io::Result<(String, bool)> {
    let output = Command::new("pnputil")
        .args(["/enum-devices", "/connected"])
        .output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut report = format!(
        "Logical processors available to this process: {}\n",
        std::thread::available_parallelism()?
    );
    for block in stdout.replace("\r\n", "\n").split("\n\n") {
        let lower = block.to_ascii_lowercase();
        if [
            "ai boost",
            "computeaccelerator",
            "class name:                 display",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
        {
            report.push_str(block.trim());
            report.push_str("\n\n");
        }
    }
    if !output.status.success() {
        report.push_str(&stdout);
        report.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    report.push_str("Device enumeration alone does not verify inference.\n");
    Ok((report, output.status.success()))
}

fn suite(count: u32, mut emit: impl FnMut(&str)) -> io::Result<bool> {
    let mut all_ok = true;
    for path in models::generate()? {
        all_ok &= compare(&path, &DEVICES, count, &mut emit)?;
    }
    Ok(all_ok)
}

fn benchmark_command() -> io::Result<Command> {
    if let Some(runner) = env::var_os("NPU_LAB_RUNNER") {
        return Ok(Command::new(runner));
    }
    let root = env::current_dir()?;
    let entry = "from openvino.tools.benchmark.main import main; main()";
    let venv = [".venv/Scripts/python.exe", ".genai-venv/Scripts/python.exe",
        ".venv/bin/python", ".genai-venv/bin/python"]
        .into_iter().map(|path| root.join(path)).find(|path| path.is_file());
    if let Some(venv) = venv {
        let mut command = Command::new(venv);
        command.args(["-c", entry]);
        return Ok(command);
    }
    let runtime = root.join(".runtime");
    let launcher = runtime.join("bin/benchmark_app.exe");
    if launcher.is_file() {
        if let Some(profile) = env::var_os("USERPROFILE") {
            let python = Path::new(&profile)
                .join(".cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe");
            if python.is_file() {
                let mut command = Command::new(python);
                command.args(["-c", entry]).env("PYTHONPATH", runtime);
                return Ok(command);
            }
        }
        let mut command = Command::new(launcher);
        command.env("PYTHONPATH", runtime);
        return Ok(command);
    }
    Ok(Command::new(if cfg!(windows) { "benchmark_app.exe" } else { "benchmark_app" }))
}

fn compare(
    model: &Path,
    devices: &[&str],
    count: u32,
    emit: &mut impl FnMut(&str),
) -> io::Result<bool> {
    let model = model.canonicalize()?;
    if !model.is_file() {
        return Err(io::Error::other("The model path must point to a file."));
    }
    let mut all_ok = true;
    for device in devices {
        emit(&format!("\n=== {} / {device} ===\n", model.display()));
        let mut command = benchmark_command()?;
        command.arg("-m").arg(&model).args([
            "-d",
            device,
            "-hint",
            if *device == "CPU" { "none" } else { "latency" },
            "-api",
            "sync",
            "-niter",
            &count.to_string(),
        ]);
        if *device == "CPU" {
            command.args(["-nthreads", "2", "-nstreams", "1"]);
        }
        let (stdout, stderr, ok) = guard::run(&mut command, None, 45, |_| Ok(()))?;
        all_ok &= ok;
        emit(&stdout);
        emit(&stderr);
        emit(&format!(
            "Result: {}\n",
            if ok {
                "completed on explicit OpenVINO target"
            } else {
                "failed; no measurement for this target"
            }
        ));
    }
    Ok(all_ok)
}
