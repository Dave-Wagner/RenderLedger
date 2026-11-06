use std::{
    io::{self, BufRead, BufReader, Read, Write},
    process::{Command, Stdio},
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

static JOB: Mutex<()> = Mutex::new(());
static STOP: AtomicBool = AtomicBool::new(false);

pub fn begin() -> io::Result<MutexGuard<'static, ()>> {
    let job = JOB
        .try_lock()
        .map_err(|_| io::Error::other("A workload is already running."))?;
    STOP.store(false, Ordering::Relaxed);
    Ok(job)
}

pub fn stop() {
    STOP.store(true, Ordering::Relaxed);
}

pub fn busy() -> bool {
    JOB.try_lock().is_err()
}

pub fn run(
    command: &mut Command,
    input: Option<&[u8]>,
    seconds: u64,
    mut emit: impl FnMut(&str) -> io::Result<()>,
) -> io::Result<(String, String, bool)> {
    if STOP.load(Ordering::Relaxed) {
        return Err(io::Error::other("Stopped by user."));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Below-normal priority leaves foreground input and desktop work ahead of inference.
        command.creation_flags(0x08004000);
    }
    let mut child = command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (output_tx, output_rx) = mpsc::channel();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let output_thread = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if output_tx.send(line).is_err() {
                break;
            }
        }
    });
    let error_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let input_thread = input.map(|input| {
        let mut stdin = child.stdin.take().expect("piped stdin");
        let input = input.to_vec();
        thread::spawn(move || stdin.write_all(&input))
    });
    let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let mut output = String::new();
        let mut last_signal = Instant::now();
        loop {
            if STOP.load(Ordering::Relaxed) {
                return Err(io::Error::other("Stopped by user."));
            }
            if Instant::now() >= deadline {
                return Err(io::Error::other(format!(
                    "Stopped after the {seconds}-second run limit."
                )));
            }
            if last_signal.elapsed() >= Duration::from_secs(2) {
                emit("")?;
                last_signal = Instant::now();
            }
            if let Ok(line) = output_rx.recv_timeout(Duration::from_millis(100)) {
                emit(&line)?;
                output.push_str(&line);
                output.push('\n');
            }
            if let Some(status) = child.try_wait()? {
                for line in &output_rx {
                    emit(&line)?;
                    output.push_str(&line);
                    output.push('\n');
                }
                return Ok((output, status.success()));
            }
        }
    })();
    if result.is_err() {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill.exe")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = child.kill();
    }
    let _ = child.wait();
    if let Some(input_thread) = input_thread {
        let _ = input_thread.join();
    }
    let _ = output_thread.join();
    let errors = error_thread.join().unwrap_or_default();
    result.map(|(output, ok)| (output, errors, ok))
}
