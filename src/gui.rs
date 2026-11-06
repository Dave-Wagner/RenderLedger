use std::{
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    time::Duration,
};

pub fn serve() -> io::Result<()> {
    serve_on(8765)
}

pub fn serve_on(port: u16) -> io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let host = listener.local_addr()?.to_string();
    let origin = format!("http://{host}");
    println!("Open {origin} in your browser. Press Ctrl+C to stop.");
    for stream in listener.incoming() {
        let host = host.clone();
        let origin = origin.clone();
        std::thread::spawn(move || {
            match stream.and_then(|stream| handle(stream, &host, &origin)) {
                Ok(()) => {}
                Err(error) => eprintln!("Dashboard connection: {error}"),
            }
        });
    }
    Ok(())
}

fn handle(mut stream: TcpStream, expected_host: &str, expected_origin: &str) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut header = Vec::new();
    let mut reader = BufReader::new(&stream);
    while header.len() < 8192 && !header.ends_with(b"\r\n\r\n") {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return Ok(());
        }
        let end = bytes
            .iter()
            .position(|&byte| byte == b'\n')
            .map_or(bytes.len(), |n| n + 1);
        let count = end.min(8192 - header.len());
        header.extend_from_slice(&bytes[..count]);
        reader.consume(count);
    }
    if !header.ends_with(b"\r\n\r\n") {
        return respond(
            &mut stream,
            "400 Bad Request",
            "text/plain",
            "Invalid request headers",
        );
    }
    let header = String::from_utf8_lossy(&header);
    let mut lines = header.lines();
    let request = lines.next().unwrap_or_default();
    let mut host = "";
    let mut origin = "";
    let mut length = None;
    for (name, value) in lines.filter_map(|line| line.split_once(':')) {
        if name.eq_ignore_ascii_case("host") {
            host = value.trim();
        }
        if name.eq_ignore_ascii_case("origin") {
            origin = value.trim();
        }
        if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    if host != expected_host || (method == "POST" && origin != expected_origin) {
        return respond(
            &mut stream,
            "403 Forbidden",
            "text/plain",
            "Local dashboard only",
        );
    }
    if (method, target) == ("POST", "/stop") {
        crate::guard::stop();
        crate::runpod::stop();
        return match crate::runpod::stop_job() {
            Ok(()) => respond(&mut stream, "200 OK", "text/plain",
                "Stop requested. Check Runpod for Pod deletion confirmation."),
            Err(error) => respond(&mut stream, "500 Internal Server Error", "text/plain",
                &format!("Local stop requested. Runpod cleanup needs attention: {error}")),
        };
    }
    match (method, target) {
        ("GET", "/chat/models") => return history_response(&mut stream, Ok(crate::genai::chat_models())),
        ("GET", "/image/availability") => {
            let available = serde_json::json!({
                "local": std::path::Path::new("models/image/unet/openvino_model.bin").is_file(),
                "reference": std::path::Path::new("models/image/vae_encoder/openvino_model.bin").is_file(),
                "runpod": crate::runpod::paid_job_configured(),
            });
            return history_response(&mut stream, Ok(available));
        }
        ("GET" | "POST", "/media/quota") => {
            return history_response(&mut stream, Ok(crate::media::quota()));
        }
        ("GET", "/runpod/balance") => {
            let mut balance = crate::runpod::balance();
            balance["jobRunning"] = serde_json::json!(crate::runpod::job_running());
            return respond(&mut stream, "200 OK", "application/json", &balance.to_string());
        }
        ("GET", "/runpod/billing") => {
            return match crate::runpod::billing() {
                Ok(billing) => respond(&mut stream, "200 OK", "application/json", &billing.to_string()),
                Err(error) => respond(&mut stream, "502 Bad Gateway", "text/plain", &error.to_string()),
            };
        }
        ("GET", "/runpod/job") => {
            let mut status = crate::runpod::job_status();
            status["localBusy"] = serde_json::json!(crate::guard::busy());
            return respond(
                &mut stream,
                "200 OK",
                "application/json",
                &status.to_string(),
            );
        }
        ("POST", "/runpod/job/start" | "/runpod/job/train" | "/runpod/job/train-dayton" | "/runpod/job/train-dayton-extended" | "/runpod/job/train-dayton-context" | "/runpod/job/eval" | "/runpod/job/music" | "/runpod/job/chat" | "/runpod/job/cleanup" | "/runpod/job/stop") => {
            let result = if target.ends_with("/stop") {
                crate::runpod::stop_job()
            } else {
                let mut options = None;
                if target.ends_with("/eval") || target.ends_with("/music") || target.ends_with("/chat") || (target.ends_with("/start") && length.unwrap_or(0) > 0) {
                    let Some(size) = length.filter(|size| (1..=8192).contains(size)) else {
                        return respond(&mut stream, "400 Bad Request", "text/plain", "Invalid comparison request length.");
                    };
                    let mut input = vec![0; size];
                    reader.read_exact(&mut input)?;
                    options = Some(String::from_utf8(input).map_err(io::Error::other)?);
                }
                let mode = match target {
                    "/runpod/job/train" => "train",
                    "/runpod/job/train-dayton" => "train-dayton",
                    "/runpod/job/train-dayton-extended" => "train-dayton-extended",
                    "/runpod/job/train-dayton-context" => "train-dayton-context",
                    "/runpod/job/eval" => "eval",
                    "/runpod/job/music" => "music",
                    "/runpod/job/chat" => "chat",
                    "/runpod/job/cleanup" => "cleanup",
                    _ => "run",
                };
                crate::runpod::start_job(mode, options.as_deref())
            };
            return match result {
                Ok(()) => respond(&mut stream, "200 OK", "text/plain", "Request accepted."),
                Err(error) => respond(
                    &mut stream,
                    "409 Conflict",
                    "text/plain",
                    &error.to_string(),
                ),
            };
        }
        ("GET", "/runpod/status") => {
            return respond(
                &mut stream,
                "200 OK",
                "application/json",
                &crate::runpod::status().to_string(),
            );
        }
        ("POST", "/runpod/start") => {
            return match crate::runpod::start() {
                Ok(()) => respond(
                    &mut stream,
                    "200 OK",
                    "text/plain",
                    "Watching Runpod capacity.",
                ),
                Err(error) => respond(
                    &mut stream,
                    "409 Conflict",
                    "text/plain",
                    &error.to_string(),
                ),
            };
        }
        ("POST", "/runpod/stop") => {
            crate::runpod::stop();
            return respond(
                &mut stream,
                "200 OK",
                "text/plain",
                "Stopping the capacity watch.",
            );
        }
        _ => {}
    }
    let _job = if method == "POST" {
        match crate::guard::begin() {
            Ok(job) => Some(job),
            Err(error) => {
                return respond(
                    &mut stream,
                    "409 Conflict",
                    "text/plain",
                    &error.to_string(),
                );
            }
        }
    } else {
        None
    };
    match (method, target) {
        ("GET", "/media/config") => history_response(&mut stream, Ok(serde_json::json!({
            "elevenlabs": crate::media::configured_key().is_ok(),
            "runpod": crate::runpod::paid_job_configured(),
            "musicSetup": crate::media::music_checkpoint().err().map(|error| error.to_string()),
            "videoSetup": crate::media::video_checkpoint().err().map(|error| error.to_string()),
            "windows": cfg!(windows),
        }))),
        ("GET", "/media/history") => history_response(&mut stream, crate::history::media_list()),
        ("GET", "/media/history?type=speech" | "/media/history?type=music" | "/media/history?type=video") =>
            history_response(&mut stream, crate::history::media_list_for(target.trim_start_matches("/media/history?type="))),
        ("GET", target) if target.starts_with("/media/history/") => {
            match target[15..].parse() {
                Ok(id) => history_response(&mut stream, crate::history::media_get(id)),
                Err(_) => respond(&mut stream, "400 Bad Request", "text/plain", "Invalid run ID."),
            }
        }
        ("POST", "/media/generate") => {
            let Some(length) = length.filter(|length| (1..=8192).contains(length)) else {
                return respond(&mut stream, "400 Bad Request", "text/plain", "Invalid media request size.");
            };
            let mut input = vec![0; length];
            reader.read_exact(&mut input)?;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n")?;
            let result = crate::media::run(&input, |line| {
                if let Some(stage) = line.strip_prefix("progress:") {
                    writeln!(stream, "{}", serde_json::json!({"stage": stage}))
                } else if line.is_empty() {
                    writeln!(stream, "{{\"heartbeat\":true}}")
                } else {
                    Ok(())
                }
            });
            let event = match result {
                Ok(result) => serde_json::json!({"result": result}),
                Err(error) => serde_json::json!({"error": error.to_string()}),
            };
            writeln!(stream, "{event}")
        }
        ("GET", "/history") => history_response(&mut stream, crate::history::list()),
        ("GET", target) if target.starts_with("/history/") => {
            let result = target[9..].parse().map(crate::history::get);
            match result {
                Ok(result) => history_response(&mut stream, result),
                Err(_) => respond(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain",
                    "Invalid run ID.",
                ),
            }
        }
        ("POST", target) if target.starts_with("/generate/") => {
            let Some(length) = length.filter(|length| {
                (1..=crate::genai::max_input(target.split('/').nth(2).unwrap_or_default()))
                    .contains(length)
            }) else {
                return respond(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain",
                    "Invalid request length.",
                );
            };
            let mut input = vec![0; length];
            reader.read_exact(&mut input)?;
            let result = target
                .strip_prefix("/generate/")
                .and_then(|route| route.split_once('/'));
            let Some((kind, device)) = result else {
                return respond(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain",
                    "Choose a generation task and device.",
                );
            };
            let run_id = if matches!(kind, "image" | "reference") {
                match crate::history::start(kind, device, &input) {
                    Ok(id) => Some(id),
                    Err(error) => {
                        return respond(
                            &mut stream,
                            "500 Internal Server Error",
                            "text/plain",
                            &format!("Could not save run: {error}"),
                        );
                    }
                }
            } else {
                None
            };
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"
            )?;
            let result = crate::genai::run_stream(kind, device, &input, |line| {
                if line.is_empty() {
                    writeln!(stream, "H")
                } else if line.starts_with("{\"delta\":") {
                    writeln!(stream, "D{line}")
                } else {
                    Ok(())
                }
            });
            if let Some(id) = run_id
                && let Err(error) = crate::history::finish(id, &result)
            {
                return writeln!(stream, "ECould not save result: {error}");
            }
            if kind == "chat"
                && let Ok(output) = &result
                && let Err(error) = crate::history::record_chat_usage(device, output)
            {
                eprintln!("Could not save chat token usage: {error}");
            }
            match result {
                Ok(json) => writeln!(stream, "D{json}"),
                Err(error) => writeln!(stream, "E{}", error.to_string().replace(['\r', '\n'], " ")),
            }
        }
        ("GET", "/") => respond(
            &mut stream,
            "200 OK",
            "text/html",
            include_str!("dashboard.html"),
        ),
        ("GET", "/renderledger.svg") => respond(
            &mut stream,
            "200 OK",
            "image/svg+xml",
            include_str!("renderledger.svg"),
        ),
        ("GET", "/dashboard.css") => respond(
            &mut stream,
            "200 OK",
            "text/css",
            include_str!("dashboard.css"),
        ),
        ("GET", "/dashboard.js") => respond(
            &mut stream,
            "200 OK",
            "text/javascript",
            include_str!("dashboard.js"),
        ),
        ("POST", target) if target.starts_with("/task/") => {
            let path = target.trim_start_matches("/task/");
            let result = path.split_once("?pixels=").and_then(|(selection, pixels)| {
                selection
                    .split_once('/')
                    .map(|(model, device)| crate::tasks::run(model, device, pixels))
            });
            match result {
                Some(Ok(json)) => respond(&mut stream, "200 OK", "application/json", &json),
                Some(Err(error)) => respond(
                    &mut stream,
                    "422 Unprocessable Content",
                    "text/plain",
                    &error.to_string(),
                ),
                None => respond(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain",
                    "Choose a model, device, and drawing.",
                ),
            }
        }
        ("GET", "/probe") => match crate::probe() {
            Ok((report, true)) => respond(&mut stream, "200 OK", "text/plain", &report),
            Ok((report, false)) => respond(
                &mut stream,
                "500 Internal Server Error",
                "text/plain",
                &report,
            ),
            Err(error) => respond(
                &mut stream,
                "500 Internal Server Error",
                "text/plain",
                &error.to_string(),
            ),
        },
        ("POST", target)
            if target.starts_with("/suite?iterations=")
                || target.starts_with("/bench/mnist?iterations=") =>
        {
            let (route, value) = target.split_once("?iterations=").expect("matched route");
            let count = match crate::iterations(Some(value)) {
                Ok(count) => count,
                Err(error) => {
                    return respond(
                        &mut stream,
                        "400 Bad Request",
                        "text/plain",
                        &error.to_string(),
                    );
                }
            };
            let mut report = String::new();
            let mut emit = |text: &str| report.push_str(text);
            let result = if route == "/suite" {
                crate::suite(count, emit)
            } else {
                crate::compare(
                    std::path::Path::new("models/mnist-8.onnx"),
                    &crate::DEVICES,
                    count,
                    &mut emit,
                )
            };
            let status = match result {
                Ok(true) => "200 OK",
                Ok(false) => "500 Internal Server Error",
                Err(error) => {
                    report.push_str(&format!("\n{error}\n"));
                    "500 Internal Server Error"
                }
            };
            respond(&mut stream, status, "text/plain", &report)
        }
        _ => respond(
            &mut stream,
            "404 Not Found",
            "text/plain",
            "Unknown dashboard route",
        ),
    }
}

fn history_response(
    stream: &mut TcpStream,
    result: rusqlite::Result<serde_json::Value>,
) -> io::Result<()> {
    match result {
        Ok(value) => respond(stream, "200 OK", "application/json", &value.to_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            respond(stream, "404 Not Found", "text/plain", "Run not found.")
        }
        Err(error) => respond(
            stream,
            "500 Internal Server Error",
            "text/plain",
            &error.to_string(),
        ),
    }
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &str) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {kind}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n\r\n{body}",
        body.len()
    )
}
