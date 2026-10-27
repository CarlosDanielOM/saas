//! Test-only loopback HTTP recorder for the service-client foundations.
//!
//! It accepts plain HTTP/1.1 on `127.0.0.1`, records each request, answers
//! with a canned response, and closes the connection so clients reconnect for
//! the next request. It never contacts a real service.

// Each feature's tests use a different subset of this helper.
#![allow(dead_code)]

use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
    time::Duration,
};

#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    /// Header names are lowercased; repeated headers are joined with `, `.
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl RecordedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

pub struct CannedResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl CannedResponse {
    pub fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("content-type", "application/json".to_owned())],
            body: body.as_bytes().to_vec(),
        }
    }
}

pub struct Recorder {
    pub base_url: String,
    requests: mpsc::Receiver<RecordedRequest>,
}

impl Recorder {
    /// Starts a recorder whose `respond` callback builds each response.
    pub fn start<F>(respond: F) -> Self
    where
        F: Fn(&RecordedRequest) -> CannedResponse + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback recorder");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("recorder address")
        );
        let (sender, requests) = mpsc::channel();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                match read_request(&stream) {
                    Some(request) => {
                        let response = respond(&request);
                        write_response(&stream, &response);
                        if sender.send(request).is_err() {
                            return;
                        }
                    }
                    None => continue,
                }
            }
        });
        Self { base_url, requests }
    }

    /// Waits for the next recorded request.
    pub fn next(&self, timeout: Duration) -> RecordedRequest {
        self.requests
            .recv_timeout(timeout)
            .expect("expected an HTTP request at the loopback recorder")
    }
}

fn read_request(stream: &TcpStream) -> Option<RecordedRequest> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();

    let mut headers = BTreeMap::<String, String>::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':')?;
        headers
            .entry(name.trim().to_ascii_lowercase())
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(value.trim());
            })
            .or_insert_with(|| value.trim().to_owned());
    }

    let chunked = headers
        .get("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"));
    let mut body = Vec::new();
    if chunked {
        loop {
            let mut size_line = String::new();
            reader.read_line(&mut size_line).ok()?;
            let size_text = size_line.trim().split(';').next().unwrap_or("0");
            let size = usize::from_str_radix(size_text, 16).ok()?;
            if size == 0 {
                // Consume optional trailers up to the blank line.
                loop {
                    let mut trailer = String::new();
                    reader.read_line(&mut trailer).ok()?;
                    if trailer.trim().is_empty() {
                        break;
                    }
                }
                break;
            }
            let mut chunk = vec![0; size];
            reader.read_exact(&mut chunk).ok()?;
            body.extend_from_slice(&chunk);
            let mut crlf = [0; 2];
            reader.read_exact(&mut crlf).ok()?;
        }
    } else if let Some(length) = headers.get("content-length") {
        let length: usize = length.parse().ok()?;
        body.resize(length, 0);
        reader.read_exact(&mut body).ok()?;
    }

    Some(RecordedRequest {
        method,
        path,
        headers,
        body,
    })
}

fn write_response(mut stream: &TcpStream, response: &CannedResponse) {
    let mut head = format!("HTTP/1.1 {} Recorded\r\n", response.status);
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!(
        "content-length: {}\r\nconnection: close\r\n\r\n",
        response.body.len()
    ));
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&response.body);
    let _ = stream.flush();
}
