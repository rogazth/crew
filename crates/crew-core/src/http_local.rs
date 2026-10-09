//! Blocking HTTP/1.1 client for the `opencode serve` process Crew runs on
//! 127.0.0.1.
//!
//! Written by hand over `TcpStream` rather than with `ureq`. The only peer is a
//! loopback server Crew starts itself, so TLS, redirects and pooling are not
//! needed. The event stream needs an idle timeout on every read, so a silent
//! server is noticed between heartbeats; a body-wide timeout cannot express
//! that. Each request opens its own connection with `Connection: close`, so no
//! pool is left holding a socket to a server that has since restarted.

use std::fmt;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use base64::Engine as _;
use serde_json::Value;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest header or chunk-size line accepted. A longer line means the peer is
/// not speaking HTTP, so reading stops rather than growing a buffer without end.
const MAX_LINE: u64 = 16 * 1024;

#[derive(Debug)]
pub enum HttpError {
    /// opencode answered 401, so the password is not the one it was started with.
    Refused,
    /// Nothing accepted the connection on the port.
    Unreachable(io::Error),
    /// No bytes arrived within the client's timeout.
    TimedOut,
    /// The connection ended before the reply or the event stream was complete.
    /// For a stream the caller reconnects, choosing the resume point itself.
    Dropped,
    /// The reply was not the HTTP or JSON the client expects.
    Protocol(String),
    Io(io::Error),
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused => write!(f, "opencode refused the password"),
            Self::Unreachable(error) => write!(f, "could not reach opencode on 127.0.0.1: {error}"),
            Self::TimedOut => write!(f, "opencode did not answer in time"),
            Self::Dropped => write!(f, "opencode closed the connection before the reply ended"),
            Self::Protocol(message) => write!(f, "opencode sent an unexpected reply: {message}"),
            Self::Io(error) => write!(f, "connection to opencode failed: {error}"),
        }
    }
}

impl std::error::Error for HttpError {}

/// A finished JSON exchange. `body` is `Value::Null` when the reply has no body,
/// such as the 204 to a DELETE. Any status other than 401 comes back here, so a
/// caller can read a 404 body such as `CommandNotFoundError`.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

/// Talks to one `opencode serve` on 127.0.0.1. Each call opens its own
/// connection, so the client holds only the port, the credential and a timeout.
pub struct LocalClient {
    port: u16,
    authorization: String,
    timeout: Duration,
}

impl fmt::Debug for LocalClient {
    // Written by hand so the password never reaches a log line.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LocalClient").field("port", &self.port).field("timeout", &self.timeout).finish()
    }
}

impl LocalClient {
    /// Sends the password as Basic auth for the user `opencode`, the same login
    /// the opencode TUI uses.
    pub fn new(port: u16, password: &str) -> Self {
        let credentials = base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"));
        Self { port, authorization: format!("Basic {credentials}"), timeout: DEFAULT_TIMEOUT }
    }

    /// Bounds the connect and each read or write. On an event stream it is the
    /// longest silence allowed, so it must be longer than the server's heartbeat.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn get_json(&self, path: &str) -> Result<Reply, HttpError> {
        self.request_json("GET", path, None)
    }

    pub fn post_json(&self, path: &str, body: &Value) -> Result<Reply, HttpError> {
        self.request_json("POST", path, Some(body))
    }

    pub fn patch_json(&self, path: &str, body: &Value) -> Result<Reply, HttpError> {
        self.request_json("PATCH", path, Some(body))
    }

    pub fn put_json(&self, path: &str, body: &Value) -> Result<Reply, HttpError> {
        self.request_json("PUT", path, Some(body))
    }

    pub fn delete(&self, path: &str) -> Result<Reply, HttpError> {
        self.request_json("DELETE", path, None)
    }

    /// `GET path` for one folder. opencode answers a request that names no
    /// folder for the folder it was started in, and ignores `?directory=`; the
    /// folder goes in `x-opencode-directory`, URI-encoded as its own clients
    /// send it, so a path with spaces or accents arrives whole.
    pub fn get_json_in(&self, path: &str, directory: &str) -> Result<Reply, HttpError> {
        self.request_in("GET", path, None, Some(directory))
    }

    /// `POST path` for one folder, as [`LocalClient::get_json_in`] names it.
    pub fn post_json_in(&self, path: &str, body: Option<&Value>, directory: &str) -> Result<Reply, HttpError> {
        self.request_in("POST", path, body, Some(directory))
    }

    /// Opens `GET path` as a `text/event-stream`. This is also the reconnect: after
    /// `Err(Dropped)`, call it again with the resume point in the query, such as
    /// `session.log?after=<seq>&follow=true`. The client never picks that path.
    pub fn open_events(&self, path: &str) -> Result<EventStream, HttpError> {
        let mut reader = self.start("GET", path, "text/event-stream", None, None)?;
        let head = read_head(&mut reader)?;
        if head.status == 401 {
            return Err(HttpError::Refused);
        }
        if !(200..300).contains(&head.status) {
            return Err(HttpError::Protocol(format!("event stream answered status {}", head.status)));
        }
        Ok(EventStream { lines: BufReader::new(Body::new(reader, &head)?), finished: false })
    }

    fn request_json(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Reply, HttpError> {
        self.request_in(method, path, body, None)
    }

    fn request_in(&self, method: &str, path: &str, body: Option<&Value>, directory: Option<&str>) -> Result<Reply, HttpError> {
        let payload = body
            .map(|value| serde_json::to_vec(value).map_err(|error| HttpError::Protocol(error.to_string())))
            .transpose()?;
        let directory = directory.map(encode_uri_component);
        let mut reader = self.start(method, path, "application/json", payload.as_deref(), directory.as_deref())?;
        let head = read_head(&mut reader)?;
        if head.status == 401 {
            return Err(HttpError::Refused);
        }
        let mut bytes = Vec::new();
        Body::new(reader, &head)?.read_to_end(&mut bytes).map_err(io_error)?;
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .map_err(|error| HttpError::Protocol(format!("status {} body is not JSON: {error}", head.status)))?
        };
        Ok(Reply { status: head.status, body })
    }

    /// Connects and writes the request. The returned reader is positioned at the
    /// start of the reply.
    fn start(
        &self,
        method: &str,
        path: &str,
        accept: &str,
        body: Option<&[u8]>,
        directory: Option<&str>,
    ) -> Result<BufReader<TcpStream>, HttpError> {
        if !path.starts_with('/') || path.bytes().any(|byte| byte <= b' ' || byte == 0x7f) {
            let message = format!("request path {path:?} is not a plain origin-form path");
            return Err(HttpError::Io(io::Error::new(io::ErrorKind::InvalidInput, message)));
        }
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        let mut stream = TcpStream::connect_timeout(&address, self.timeout).map_err(|error| match error.kind() {
            io::ErrorKind::TimedOut => HttpError::TimedOut,
            _ => HttpError::Unreachable(error),
        })?;
        stream.set_read_timeout(Some(self.timeout)).map_err(io_error)?;
        stream.set_write_timeout(Some(self.timeout)).map_err(io_error)?;

        let mut head = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: {}\r\nAccept: {accept}\r\nConnection: close\r\n",
            self.port, self.authorization
        );
        if let Some(directory) = directory {
            head.push_str(&format!("x-opencode-directory: {directory}\r\n"));
        }
        if let Some(body) = body {
            head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).map_err(io_error)?;
        if let Some(body) = body {
            stream.write_all(body).map_err(io_error)?;
        }
        Ok(BufReader::new(stream))
    }
}

/// Parsed events from a `text/event-stream` reply. Heartbeats and comments are
/// skipped.
///
/// A transport error or a closed connection ends the iterator with one `Err`,
/// after which the caller reconnects with `open_events`. A clean end of the
/// chunked body and a closed socket are reported alike, because opencode never
/// ends the stream on purpose. A frame that is not JSON is reported as its own
/// `Err`, and the stream carries on: the frame was complete, so the next one
/// starts clean.
pub struct EventStream {
    lines: BufReader<Body<BufReader<TcpStream>>>,
    finished: bool,
}

impl Iterator for EventStream {
    type Item = Result<Value, HttpError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        match self.next_frame() {
            Ok(data) => Some(
                serde_json::from_str(&data)
                    .map_err(|error| HttpError::Protocol(format!("event data is not JSON: {error}"))),
            ),
            Err(error) => {
                self.finished = true;
                Some(Err(error))
            }
        }
    }
}

impl EventStream {
    /// Joins the `data:` lines of one event. A blank line ends an event, and an
    /// event without data lines is not dispatched, as the SSE format requires.
    fn next_frame(&mut self) -> Result<String, HttpError> {
        let mut data: Option<String> = None;
        loop {
            let line = read_line(&mut self.lines).map_err(io_error)?;
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if let Some(event) = data.take() {
                    return Ok(event);
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = line
                .split_once(':')
                .map_or((line, ""), |(field, value)| (field, value.strip_prefix(' ').unwrap_or(value)));
            if field == "data" {
                match &mut data {
                    Some(buffer) => {
                        buffer.push('\n');
                        buffer.push_str(value);
                    }
                    None => data = Some(value.to_string()),
                }
            }
        }
    }
}

/// `encodeURIComponent`, which is how opencode's own clients put a folder in
/// its header and how its server reads it back: everything but the unreserved
/// characters is percent-encoded, so no byte of the path can end the header.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Turns the io errors a socket raises into the cases callers act on.
fn io_error(error: io::Error) -> HttpError {
    match error.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => HttpError::TimedOut,
        io::ErrorKind::UnexpectedEof
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::BrokenPipe => HttpError::Dropped,
        io::ErrorKind::InvalidData => HttpError::Protocol(error.to_string()),
        _ => HttpError::Io(error),
    }
}

struct Head {
    status: u16,
    /// Names are lowercased, so lookups use lowercase names.
    headers: Vec<(String, String)>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }
}

fn read_head<R: BufRead>(reader: &mut R) -> Result<Head, HttpError> {
    let status_line = read_line(reader).map_err(io_error)?;
    let mut parts = status_line.split_whitespace();
    let status = match (parts.next(), parts.next().and_then(|code| code.parse::<u16>().ok())) {
        (Some(version), Some(status)) if version.starts_with("HTTP/1.") => status,
        _ => return Err(HttpError::Protocol(format!("status line {:?} is not HTTP/1", status_line.trim_end()))),
    };
    let mut headers = Vec::new();
    loop {
        let line = read_line(reader).map_err(io_error)?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    Ok(Head { status, headers })
}

/// Reads one line, its terminator included, without letting a peer grow it forever.
fn read_line<R: BufRead>(reader: &mut R) -> io::Result<String> {
    let mut line = String::new();
    let read = reader.by_ref().take(MAX_LINE).read_line(&mut line)?;
    if line.ends_with('\n') {
        return Ok(line);
    }
    if read as u64 >= MAX_LINE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "line too long"));
    }
    Err(io::ErrorKind::UnexpectedEof.into())
}

/// The body of a reply, decoded from its framing: a fixed length, chunked, or
/// read until the server closes the connection.
enum Body<R> {
    Fixed { inner: R, remaining: u64 },
    Chunked { inner: R, state: ChunkState },
    UntilClose(R),
}

#[derive(Clone, Copy)]
enum ChunkState {
    Size,
    Data(u64),
    LineEnd,
    Done,
}

impl<R: BufRead> Body<R> {
    fn new(inner: R, head: &Head) -> Result<Self, HttpError> {
        if head.status == 204 {
            return Ok(Self::Fixed { inner, remaining: 0 });
        }
        if head.header("transfer-encoding").is_some_and(|value| value.to_ascii_lowercase().contains("chunked")) {
            return Ok(Self::Chunked { inner, state: ChunkState::Size });
        }
        match head.header("content-length") {
            Some(length) => {
                let remaining = length
                    .parse::<u64>()
                    .map_err(|_| HttpError::Protocol(format!("content-length {length:?} is not a number")))?;
                Ok(Self::Fixed { inner, remaining })
            }
            None => Ok(Self::UntilClose(inner)),
        }
    }
}

impl<R: BufRead> Read for Body<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        match self {
            Self::UntilClose(inner) => inner.read(buf),
            Self::Fixed { inner, remaining } => {
                if *remaining == 0 {
                    return Ok(0);
                }
                let want = buf.len().min(usize::try_from(*remaining).unwrap_or(usize::MAX));
                let read = inner.read(&mut buf[..want])?;
                if read == 0 {
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
                *remaining -= read as u64;
                Ok(read)
            }
            Self::Chunked { inner, state } => loop {
                match *state {
                    ChunkState::Done => return Ok(0),
                    ChunkState::Size => {
                        let size = read_chunk_size(inner)?;
                        *state = if size == 0 {
                            read_trailers(inner)?;
                            ChunkState::Done
                        } else {
                            ChunkState::Data(size)
                        };
                    }
                    ChunkState::Data(left) => {
                        let want = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
                        let read = inner.read(&mut buf[..want])?;
                        if read == 0 {
                            return Err(io::ErrorKind::UnexpectedEof.into());
                        }
                        let left = left - read as u64;
                        *state = if left == 0 { ChunkState::LineEnd } else { ChunkState::Data(left) };
                        return Ok(read);
                    }
                    ChunkState::LineEnd => {
                        if !read_line(inner)?.trim_end().is_empty() {
                            return Err(io::Error::new(io::ErrorKind::InvalidData, "chunk data not followed by CRLF"));
                        }
                        *state = ChunkState::Size;
                    }
                }
            },
        }
    }
}

fn read_chunk_size<R: BufRead>(reader: &mut R) -> io::Result<u64> {
    let line = read_line(reader)?;
    let digits = line.trim_end().split(';').next().unwrap_or("").trim();
    u64::from_str_radix(digits, 16)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, format!("chunk size {digits:?} is not hex")))
}

/// Skips the optional trailer section after the last chunk, up to its blank line.
fn read_trailers<R: BufRead>(reader: &mut R) -> io::Result<()> {
    while !read_line(reader)?.trim_end().is_empty() {}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Instant;

    struct Request {
        head: String,
        body: Vec<u8>,
    }

    impl Request {
        fn request_line(&self) -> &str {
            self.head.lines().next().unwrap_or("")
        }

        fn method(&self) -> &str {
            self.request_line().split(' ').next().unwrap_or("")
        }

        fn path(&self) -> &str {
            self.request_line().split(' ').nth(1).unwrap_or("")
        }
    }

    /// Accepts `connections` connections in order on an ephemeral port. Each
    /// request is read in full, `respond` writes that connection's reply, and the
    /// request is then sent down the returned channel.
    fn serve(
        connections: usize,
        respond: impl Fn(usize, &Request, &mut TcpStream) + Send + 'static,
    ) -> (u16, mpsc::Receiver<Request>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sender, requests) = mpsc::channel();
        thread::spawn(move || {
            for index in 0..connections {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                respond(index, &request, &mut stream);
                let _ = sender.send(request);
            }
        });
        (port, requests)
    }

    fn read_request(stream: &mut TcpStream) -> Request {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut head = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            head.push_str(&line);
        }
        let length = head
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .map_or(0, |value| value.trim().parse::<usize>().unwrap());
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        Request { head, body }
    }

    // The helpers ignore write errors: a test whose client gave up early should
    // fail on the client's side, not panic inside the server thread.
    fn reply(stream: &mut TcpStream, status: u16, body: &str) {
        let head = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body.as_bytes());
    }

    fn chunked_head(stream: &mut TcpStream) {
        let _ = stream.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
        );
    }

    fn chunk(stream: &mut TcpStream, data: &str) {
        let _ = stream.write_all(format!("{:x}\r\n{data}\r\n", data.len()).as_bytes());
    }

    fn client(port: u16, timeout: Duration) -> LocalClient {
        LocalClient::new(port, "secret").with_timeout(timeout)
    }

    #[test]
    fn json_round_trip_sends_basic_auth_on_every_verb() {
        let (port, requests) = serve(5, |_, request, stream| {
            if request.method() == "DELETE" {
                let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                return;
            }
            let body: Value = if request.body.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&request.body).unwrap()
            };
            reply(stream, 200, &json!({ "method": request.method(), "path": request.path(), "body": body }).to_string());
        });
        let client = client(port, Duration::from_secs(5));
        let sent = json!({ "text": "hello" });

        let got = client.get_json("/api/info").unwrap();
        assert_eq!(got, Reply { status: 200, body: json!({ "method": "GET", "path": "/api/info", "body": null }) });
        let posted = client.post_json("/session", &sent).unwrap();
        assert_eq!(posted.body, json!({ "method": "POST", "path": "/session", "body": { "text": "hello" } }));
        let patched = client.patch_json("/inbox/inb_1", &sent).unwrap();
        assert_eq!(patched.body["method"], "PATCH");
        let put = client.put_json("/session/ses_1/environment", &sent).unwrap();
        assert_eq!(put.body["method"], "PUT");
        let deleted = client.delete("/inbox/inb_1").unwrap();
        assert_eq!(deleted, Reply { status: 204, body: Value::Null });

        let expected = format!("Authorization: Basic {}", base64::engine::general_purpose::STANDARD.encode("opencode:secret"));
        for _ in 0..5 {
            let request = requests.recv().unwrap();
            assert!(request.head.contains(&expected), "{}", request.head);
        }
    }

    #[test]
    fn wrong_password_is_reported_as_refused() {
        let (port, _requests) = serve(1, |_, _, stream| reply(stream, 401, "{\"error\":\"unauthorized\"}"));
        let error = client(port, Duration::from_secs(5)).get_json("/api/info").unwrap_err();
        assert!(matches!(error, HttpError::Refused), "{error}");
        assert_eq!(error.to_string(), "opencode refused the password");
    }

    #[test]
    fn other_error_statuses_come_back_with_their_body() {
        let (port, _requests) = serve(1, |_, _, stream| reply(stream, 404, "{\"name\":\"CommandNotFoundError\"}"));
        let reply = client(port, Duration::from_secs(5)).post_json("/command", &json!({ "name": "nope" })).unwrap();
        assert_eq!(reply.status, 404);
        assert_eq!(reply.body["name"], "CommandNotFoundError");
    }

    #[test]
    fn event_stream_skips_heartbeats_and_joins_multi_line_data() {
        let (port, _requests) = serve(1, |_, _, stream| {
            chunked_head(stream);
            chunk(stream, ": heartbeat\n\n");
            // One event split across two chunks in the middle of a line.
            chunk(stream, "data: {\"type\":\"server.con");
            chunk(stream, "nected\"}\n\n");
            chunk(stream, ": heartbeat\n\n");
            // A multi-line data field: the lines are joined with newlines.
            chunk(stream, "event: session.step.ended\ndata: {\"id\":\"a\",\n");
            chunk(stream, "data: \"tokens\":1}\n\n");
            chunk(stream, ": heartbeat\n\n");
            let _ = stream.write_all(b"0\r\n\r\n");
        });
        let mut events = client(port, Duration::from_secs(5)).open_events("/event").unwrap();
        assert_eq!(events.next().unwrap().unwrap(), json!({ "type": "server.connected" }));
        assert_eq!(events.next().unwrap().unwrap(), json!({ "id": "a", "tokens": 1 }));
        assert!(matches!(events.next(), Some(Err(HttpError::Dropped))));
        assert!(events.next().is_none());
    }

    #[test]
    fn dropped_stream_is_reported_and_reconnects_on_the_callers_path() {
        let (port, requests) = serve(2, |index, _, stream| {
            chunked_head(stream);
            if index == 0 {
                chunk(stream, "data: {\"seq\":1}\n\n");
                // The event is cut off and the socket closes with no terminator.
                chunk(stream, "data: {\"seq\":2");
            } else {
                chunk(stream, "data: {\"seq\":3}\n\n");
                let _ = stream.write_all(b"0\r\n\r\n");
            }
        });
        let client = client(port, Duration::from_secs(5));
        let mut events = client.open_events("/event").unwrap();
        assert_eq!(events.next().unwrap().unwrap(), json!({ "seq": 1 }));
        assert!(matches!(events.next(), Some(Err(HttpError::Dropped))));
        assert!(events.next().is_none());

        let mut resumed = client.open_events("/session/ses_1/log?after=1&follow=true").unwrap();
        assert_eq!(resumed.next().unwrap().unwrap(), json!({ "seq": 3 }));
        let paths: Vec<String> = requests.iter().take(2).map(|request| request.path().to_string()).collect();
        assert_eq!(paths, ["/event", "/session/ses_1/log?after=1&follow=true"]);
    }

    #[test]
    fn slow_reply_hits_the_timeout() {
        let (port, _requests) = serve(1, |_, _, stream| {
            thread::sleep(Duration::from_millis(1500));
            reply(stream, 200, "{}");
        });
        let started = Instant::now();
        let error = client(port, Duration::from_millis(200)).get_json("/api/info").unwrap_err();
        assert!(matches!(error, HttpError::TimedOut), "{error}");
        assert!(started.elapsed() < Duration::from_millis(1000));
    }

    #[test]
    fn silent_event_stream_hits_the_idle_timeout() {
        let (port, _requests) = serve(1, |_, _, stream| {
            chunked_head(stream);
            thread::sleep(Duration::from_millis(1500));
        });
        let mut events = client(port, Duration::from_millis(200)).open_events("/event").unwrap();
        let started = Instant::now();
        assert!(matches!(events.next(), Some(Err(HttpError::TimedOut))));
        assert!(started.elapsed() < Duration::from_millis(1000));
    }

    /// The folder travels URI-encoded, so a path with a space, an accent or a
    /// line break cannot break the header it rides in.
    #[test]
    fn a_folder_goes_in_its_header_encoded_as_opencodes_clients_send_it() {
        let (port, requests) = serve(2, |_, _, stream| reply(stream, 200, "{\"data\":[]}"));
        let client = client(port, Duration::from_secs(5));
        client.get_json_in("/api/command", "/Users/me/Mis Documentos/café").unwrap();
        client.post_json_in("/api/location/reload", None, "/tmp/a\r\nX-Injected: 1").unwrap();
        let first = requests.recv().unwrap();
        assert!(first.head.contains("x-opencode-directory: %2FUsers%2Fme%2FMis%20Documentos%2Fcaf%C3%A9\r\n"), "{}", first.head);
        let second = requests.recv().unwrap();
        assert!(second.head.contains("x-opencode-directory: %2Ftmp%2Fa%0D%0AX-Injected%3A%201\r\n"), "{}", second.head);
        assert!(!second.head.contains("\r\nX-Injected"), "{}", second.head);
    }

    #[test]
    fn path_with_a_line_break_is_refused_before_connecting() {
        // Nothing listens on this port; the path check must fail first.
        let error = LocalClient::new(9, "secret").get_json("/api/info\r\nX-Injected: 1").unwrap_err();
        assert!(matches!(error, HttpError::Io(_)), "{error}");
    }
}
