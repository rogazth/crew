//! The bridge, as the commands use it: one call per request, and a tool's
//! answer split into what it said and whether it refused.

use serde_json::{json, Value};

use crate::identity::Identity;
use crate::CliError;

pub struct Client {
    pub identity: Identity,
}

/// What a tool answered: MCP content blocks, and whether it refused.
#[derive(Clone, Debug)]
pub struct Reply {
    pub raw: Value,
    pub content: Vec<Value>,
    pub is_error: bool,
}

impl Reply {
    pub fn from_raw(raw: Value) -> Self {
        let content = raw.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
        let is_error = raw.get("isError").and_then(Value::as_bool).unwrap_or(false);
        Self { raw, content, is_error }
    }

    /// Every text block, joined: what the tool said.
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The answer as data. Crew's tools answer with JSON printed into one
    /// text block, so that block is parsed; a sentence stays a string.
    pub fn value(&self) -> Value {
        let text = self.text();
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    }
}

impl Client {
    pub fn new(identity: Identity) -> Self {
        Self { identity }
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, CliError> {
        self.identity.link().call(method, params).map_err(CliError::from_bridge)
    }

    /// A tool's answer, refusals included: the caller decides what a refusal
    /// means to it.
    pub fn tool(&self, name: &str, arguments: Value) -> Result<Reply, CliError> {
        self.call("tools/call", json!({ "name": name, "arguments": arguments })).map(Reply::from_raw)
    }

    /// A tool's answer, with a refusal turned into a failure that says why.
    pub fn run(&self, name: &str, arguments: Value) -> Result<Reply, CliError> {
        let reply = self.tool(name, arguments)?;
        if reply.is_error {
            return Err(CliError::Failed(reply.text()));
        }
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_is_its_text_and_its_json() {
        let reply = Reply::from_raw(json!({ "content": [{ "type": "text", "text": "[{\"id\":\"a\"}]" }] }));
        assert!(!reply.is_error);
        assert_eq!(reply.value(), json!([{ "id": "a" }]));
        let refused = Reply::from_raw(json!({ "content": [{ "type": "text", "text": "No such process" }], "isError": true }));
        assert!(refused.is_error);
        assert_eq!(refused.value(), json!("No such process"));
    }

    #[test]
    fn images_are_not_text() {
        let reply = Reply::from_raw(json!({ "content": [
            { "type": "text", "text": "a" },
            { "type": "image", "data": "AA==", "mimeType": "image/png" },
            { "type": "text", "text": "b" }
        ] }));
        assert_eq!(reply.text(), "a\nb");
    }
}
