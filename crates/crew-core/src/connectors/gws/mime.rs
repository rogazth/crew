//! An email as RFC 5322 bytes, for Gmail to send or keep as a draft: text,
//! HTML or both, and attachments. Gmail fills in Date and Message-ID.

use serde_json::Value;

use super::{decode64, GwsError, MAX_FILE};

/// The most files one message takes.
pub(super) const MAX_ATTACHMENTS: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Attachment {
    pub filename: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct Mail {
    pub from: Option<String>,
    pub to: Option<String>,
    pub cc: Option<String>,
    pub bcc: Option<String>,
    pub subject: Option<String>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub attachments: Vec<Attachment>,
}

impl Mail {
    pub fn render(&self) -> Vec<u8> {
        let mut out = String::new();
        for (name, value) in [
            ("From", &self.from),
            ("To", &self.to),
            ("Cc", &self.cc),
            ("Bcc", &self.bcc),
            ("In-Reply-To", &self.in_reply_to),
            ("References", &self.references),
        ] {
            if let Some(value) = value.as_deref().map(one_line).filter(|v| !v.is_empty()) {
                out.push_str(&format!("{name}: {value}\r\n"));
            }
        }
        out.push_str(&format!("Subject: {}\r\n", encode_word(&one_line(self.subject.as_deref().unwrap_or_default()))));
        out.push_str("MIME-Version: 1.0\r\n");
        out.push_str(&self.body());
        out.into_bytes()
    }

    /// The body with its own Content-Type header first.
    fn body(&self) -> String {
        let text = self.text.clone().or_else(|| self.html.as_deref().map(super::strip_html)).unwrap_or_default();
        let readable = match &self.html {
            Some(html) => {
                let b = boundary();
                format!(
                    "Content-Type: multipart/alternative; boundary=\"{b}\"\r\n\r\n--{b}\r\n{}\r\n--{b}\r\n{}\r\n--{b}--\r\n",
                    text_part("text/plain", &text),
                    text_part("text/html", html)
                )
            }
            None => text_part("text/plain", &text),
        };
        if self.attachments.is_empty() {
            return readable;
        }
        let b = boundary();
        let mut out = format!("Content-Type: multipart/mixed; boundary=\"{b}\"\r\n\r\n--{b}\r\n{readable}");
        for a in &self.attachments {
            out.push_str(&format!(
                "\r\n--{b}\r\nContent-Type: {}; name={}\r\nContent-Disposition: attachment; {}\r\nContent-Transfer-Encoding: base64\r\n\r\n{}",
                one_line(&a.mime_type),
                quoted_param(&a.filename),
                filename_param(&a.filename),
                lines64(&a.data)
            ));
        }
        out.push_str(&format!("\r\n--{b}--\r\n"));
        out
    }
}

fn text_part(mime: &str, text: &str) -> String {
    format!("Content-Type: {mime}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}", lines64(text.as_bytes()))
}

fn boundary() -> String {
    format!("crew-{}", uuid::Uuid::new_v4().simple())
}

/// A header's value on one line: a CR or LF in it would start a new header.
fn one_line(value: &str) -> String {
    value.replace(['\r', '\n'], " ").trim().to_string()
}

/// Base64 in lines of 76, as MIME wants.
fn lines64(bytes: &[u8]) -> String {
    let encoded = super::encode64(bytes);
    let mut out = String::with_capacity(encoded.len() + encoded.len() / 38 + 2);
    for chunk in encoded.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push_str("\r\n");
    }
    out
}

/// A header's text as is when it is ASCII, else as RFC 2047 encoded words,
/// each short enough for a line.
fn encode_word(text: &str) -> String {
    if text.is_ascii() {
        return text.to_string();
    }
    let mut words = Vec::new();
    let mut chunk = String::new();
    for c in text.chars() {
        if chunk.len() + c.len_utf8() > 45 {
            words.push(std::mem::take(&mut chunk));
        }
        chunk.push(c);
    }
    words.push(chunk);
    words.iter().map(|w| format!("=?UTF-8?B?{}?=", super::encode64(w.as_bytes()))).collect::<Vec<_>>().join("\r\n ")
}

fn quoted_param(name: &str) -> String {
    let name = one_line(name);
    if name.is_ascii() {
        format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        format!("\"{}\"", encode_word(&name))
    }
}

/// `filename=`, or RFC 2231's `filename*=` for a name that isn't ASCII.
fn filename_param(name: &str) -> String {
    let name = one_line(name);
    if name.is_ascii() {
        return format!("filename={}", quoted_param(&name));
    }
    let encoded: String = name
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    format!("filename*=UTF-8''{encoded}")
}

/// The files a model gave under `attachments`: each its name, its type and
/// its bytes as base64. A `path` is read by Crew before the call reaches
/// here; one left means nothing read it.
pub(super) fn attachments_of(value: Option<&Value>) -> Result<Vec<Attachment>, GwsError> {
    let call = |m: String| GwsError::Call(m);
    let items = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(call("attachments is a list".into())),
    };
    if items.len() > MAX_ATTACHMENTS {
        return Err(call(format!("A message takes up to {MAX_ATTACHMENTS} attachments")));
    }
    let mut out = Vec::new();
    let mut total = 0;
    for item in items {
        let filename = item["filename"].as_str().map(str::trim).filter(|n| !n.is_empty());
        let Some(filename) = filename else {
            return Err(call("Each attachment needs a filename".into()));
        };
        if filename.chars().count() > 255 {
            return Err(call(format!("{filename}: a filename is up to 255 characters")));
        }
        if item.get("path").is_some() && item.get("content").is_none() {
            return Err(call(format!("{filename}: path is read only in a session's folder; give content as base64")));
        }
        let content = item["content"].as_str().ok_or_else(|| call(format!("{filename}: content is required")))?;
        let data = decode64(content).ok_or_else(|| call(format!("{filename}: content is not base64")))?;
        total += data.len();
        if total > MAX_FILE {
            return Err(call(format!("The attachments are over {} MB together", MAX_FILE >> 20)));
        }
        let mime_type = item["mime_type"]
            .as_str()
            .or_else(|| item["mimeType"].as_str())
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or("application/octet-stream");
        out.push(Attachment { filename: filename.to_string(), mime_type: mime_type.to_string(), data });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decoded_parts(raw: &str) -> String {
        // The base64 bodies, decoded, so a test reads what a mail client shows.
        raw.split("\r\n\r\n")
            .filter_map(|block| {
                let body: String = block.lines().take_while(|l| !l.starts_with("--")).collect();
                super::super::decode64(&body).and_then(|b| String::from_utf8(b).ok())
            })
            .collect::<Vec<_>>()
            .join("|")
    }

    #[test]
    fn a_plain_mail_is_one_text_part_and_headers_stay_on_one_line() {
        let mail = Mail {
            to: Some("a@x.dev".into()),
            subject: Some("Hi\r\nBcc: evil@x.dev".into()),
            text: Some("Hola, ¿cómo estás?".into()),
            ..Mail::default()
        };
        let raw = String::from_utf8(mail.render()).unwrap();
        assert!(raw.contains("Subject: Hi  Bcc: evil@x.dev\r\n"), "{raw}");
        assert!(!raw.contains("\r\nBcc:"));
        assert!(raw.contains("Content-Type: text/plain; charset=UTF-8"));
        assert!(decoded_parts(&raw).contains("Hola, ¿cómo estás?"));
    }

    #[test]
    fn html_and_files_nest_as_mail_clients_expect() {
        let mail = Mail {
            to: Some("a@x.dev".into()),
            subject: Some("Factura de noviembre".into()),
            html: Some("<p>Hola</p>".into()),
            attachments: vec![Attachment {
                filename: "factura ñ.pdf".into(),
                mime_type: "application/pdf".into(),
                data: b"%PDF".to_vec(),
            }],
            ..Mail::default()
        };
        let raw = String::from_utf8(mail.render()).unwrap();
        assert!(raw.contains("multipart/mixed"));
        assert!(raw.contains("multipart/alternative"));
        assert!(raw.contains("filename*=UTF-8''factura%20%C3%B1.pdf"));
        let parts = decoded_parts(&raw);
        assert!(parts.contains("Hola") && parts.contains("<p>Hola</p>") && parts.contains("%PDF"), "{parts}");
        assert_eq!(encode_word("Añadido"), "=?UTF-8?B?QcOxYWRpZG8=?=");
    }

    #[test]
    fn attachments_are_checked_before_anything_is_sent() {
        let ok = attachments_of(Some(&json!([{ "filename": "a.txt", "content": "aGk=" }]))).unwrap();
        assert_eq!(
            ok[0],
            Attachment { filename: "a.txt".into(), mime_type: "application/octet-stream".into(), data: b"hi".to_vec() }
        );
        for (bad, why) in [
            (json!([{ "content": "aGk=" }]), "filename"),
            (json!([{ "filename": "a", "content": "%%" }]), "not base64"),
            (json!([{ "filename": "a", "path": "a.txt" }]), "path"),
            (json!("a.txt"), "list"),
        ] {
            let error = attachments_of(Some(&bad)).unwrap_err();
            assert!(matches!(&error, GwsError::Call(m) if m.contains(why)), "{error:?}");
        }
    }
}
