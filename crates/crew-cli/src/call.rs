//! `crew call`: any tool by name, answered the way an MCP client would see it.
//!
//! A refusal is printed on stdout, not stderr, like any other answer: Cursor
//! runs `crewd call … 2>/dev/null` from its shell, and a model that cannot
//! read why a call failed will only make it again.

use std::process::ExitCode;

use serde_json::{json, Value};

use crate::args::CallArgs;
use crate::client::Client;
use crate::output::{self, Table};
use crate::{read_stdin, CliError, Ctx};

const USAGE: &str = "usage: crew call <tool> ['{\"json\": \"arguments\"}' | -]\n       crew call <tool> --help";

pub fn run(ctx: &Ctx, args: &CallArgs) -> Result<ExitCode, CliError> {
    let Some(tool) = args.tool.as_deref() else {
        return catalog(ctx);
    };
    if args.help {
        return describe(ctx, tool);
    }
    let arguments = parse_arguments(args.arguments.as_deref())?;
    let client = ctx.client()?;
    let reply = client.tool(tool, arguments)?;
    if ctx.global.json {
        output::say_json(&reply.raw);
    } else {
        for line in output::content(&reply.content, &output::image_dir(), &output::image_stem(tool)) {
            output::say(&line);
        }
    }
    Ok(if reply.is_error { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

/// The arguments a call is given: a JSON object, `-` for one on stdin, or
/// none at all.
fn parse_arguments(raw: Option<&str>) -> Result<Value, CliError> {
    let text = match raw {
        None => return Ok(json!({})),
        Some("-") => read_stdin()?,
        Some(text) => text.to_string(),
    };
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(value) if value.is_object() => Ok(value),
        Ok(_) => Err(CliError::Usage("Arguments must be a JSON object, like '{\"process\": \"web\"}'".into())),
        Err(e) => Err(CliError::Usage(format!("Arguments must be a JSON object: {e}"))),
    }
}

/// Every tool this caller may run, listed or behind the gateway. A daemon
/// from before `tools/catalog` answers with what it lists.
fn fetch_catalog(client: &Client) -> Result<Vec<Value>, CliError> {
    let listed = match client.call("tools/catalog", json!({})) {
        Ok(found) => found,
        Err(CliError::Failed(message)) if message.starts_with("Unknown method") => client.call("tools/list", json!({}))?,
        Err(error) => return Err(error),
    };
    let mut tools: Vec<Value> = listed
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        // The gateway is how a model reaches the rest; here the rest is listed.
        .filter(|tool| !matches!(tool.get("name").and_then(Value::as_str), Some("find_tool" | "call_tool")))
        .collect();
    tools.sort_by(|a, b| name_of(a).cmp(name_of(b)));
    Ok(tools)
}

fn name_of(tool: &Value) -> &str {
    tool.get("name").and_then(Value::as_str).unwrap_or("")
}

fn catalog(ctx: &Ctx) -> Result<ExitCode, CliError> {
    let client = match ctx.client() {
        Ok(client) => client,
        Err(error) => {
            output::say(USAGE);
            return Err(error);
        }
    };
    let tools = fetch_catalog(&client)?;
    if ctx.global.json {
        output::say_json(&Value::Array(tools));
        return Ok(ExitCode::SUCCESS);
    }
    output::say(&catalog_text(&tools));
    Ok(ExitCode::SUCCESS)
}

fn catalog_text(tools: &[Value]) -> String {
    let table = Table {
        headers: vec!["TOOL".into(), "WHAT IT DOES".into()],
        rows: tools
            .iter()
            .map(|tool| {
                let about = tool.get("description").and_then(Value::as_str).unwrap_or("");
                vec![name_of(tool).to_string(), first_sentence(about)]
            })
            .collect(),
    };
    format!("{USAGE}\n\n{}", table.render(output::styled()))
}

/// Up to the first full stop, so the catalog stays one line per tool.
fn first_sentence(text: &str) -> String {
    let line = text.lines().next().unwrap_or("");
    match line.find(". ") {
        Some(end) => line[..=end].to_string(),
        None => line.to_string(),
    }
}

fn describe(ctx: &Ctx, name: &str) -> Result<ExitCode, CliError> {
    let tools = fetch_catalog(&ctx.client()?)?;
    let Some(tool) = tools.iter().find(|tool| name_of(tool) == name) else {
        return Err(CliError::Failed(format!("No tool {name} for you here. `crew call --help` lists them.")));
    };
    if ctx.global.json {
        output::say_json(tool);
    } else {
        output::say(&describe_text(tool));
    }
    Ok(ExitCode::SUCCESS)
}

/// A tool as a person reads it: what it does, each argument with its type and
/// whether it is required, and a call to copy.
fn describe_text(tool: &Value) -> String {
    let name = name_of(tool);
    let about = tool.get("description").and_then(Value::as_str).unwrap_or("");
    let schema = tool.get("inputSchema").cloned().unwrap_or(Value::Null);
    let arguments = arguments(&schema);
    let mut out = format!("{name}\n\n{about}\n");
    if arguments.is_empty() {
        out.push_str("\nNo arguments.\n");
    } else {
        out.push_str("\nArguments:\n");
        let wide_name = arguments.iter().map(|arg| arg.name.chars().count()).max().unwrap_or(0);
        let wide_kind = arguments.iter().map(|arg| arg.kind.chars().count()).max().unwrap_or(0);
        let indent = 2 + wide_name + 2 + wide_kind + 2 + "required".len() + 2;
        for arg in &arguments {
            let mut lines = arg.description.lines();
            let row = format!(
                "  {:wide_name$}  {:wide_kind$}  {:8}  {}",
                arg.name,
                arg.kind,
                if arg.required { "required" } else { "" },
                lines.next().unwrap_or(""),
            );
            out.push_str(row.trim_end());
            out.push('\n');
            for more in lines {
                out.push_str(format!("{}{more}", " ".repeat(indent)).trim_end());
                out.push('\n');
            }
        }
    }
    out.push_str(&format!("\nExample:\n  crew call {name}{}", example(&arguments)));
    out
}

struct Argument {
    name: String,
    kind: String,
    required: bool,
    description: String,
}

/// Required first, in the order the schema names them, then the rest in
/// its order.
fn arguments(schema: &Value) -> Vec<Argument> {
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out: Vec<Argument> = properties
        .iter()
        .map(|(name, spec)| Argument {
            name: name.clone(),
            kind: kind(spec),
            required: required.contains(&name.as_str()),
            description: spec.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
        })
        .collect();
    out.sort_by_key(|arg| {
        (!arg.required, required.iter().position(|name| *name == arg.name).unwrap_or(usize::MAX))
    });
    out
}

/// `string`, `integer 1–20`, `one of: a, b`, `list of integer`.
fn kind(spec: &Value) -> String {
    if let Some(options) = spec.get("enum").and_then(Value::as_array) {
        return format!("one of: {}", options.iter().map(output::cell).collect::<Vec<_>>().join(", "));
    }
    let base = match spec.get("type") {
        Some(Value::String(kind)) => kind.clone(),
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" or "),
        _ => "any".to_string(),
    };
    if base == "array" {
        let items = spec.get("items").map(kind).unwrap_or_else(|| "any".into());
        return format!("list of {items}");
    }
    match (spec.get("minimum").and_then(Value::as_i64), spec.get("maximum").and_then(Value::as_i64)) {
        (Some(low), Some(high)) => format!("{base} {low}–{high}"),
        (Some(low), None) => format!("{base} ≥{low}"),
        (None, Some(high)) => format!("{base} ≤{high}"),
        (None, None) => base,
    }
}

/// A call with the required arguments filled with placeholders of their type.
fn example(arguments: &[Argument]) -> String {
    let required: serde_json::Map<String, Value> = arguments
        .iter()
        .filter(|arg| arg.required)
        .map(|arg| {
            let placeholder = if arg.kind.starts_with("integer") || arg.kind.starts_with("number") {
                json!(1)
            } else if arg.kind.starts_with("boolean") {
                json!(true)
            } else if arg.kind.starts_with("list") {
                json!([])
            } else if arg.kind.starts_with("object") {
                json!({})
            } else {
                json!("…")
            };
            (arg.name.clone(), placeholder)
        })
        .collect();
    if required.is_empty() {
        String::new()
    } else {
        format!(" '{}'", Value::Object(required))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_logs() -> Value {
        json!({
            "name": "read_logs",
            "description": "Read a process's output. Without since, the last lines.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tail": { "type": "integer", "minimum": 1, "maximum": 2000, "description": "Lines from the end." },
                    "process": { "type": "string", "description": "The process, by name or id.\nIts id is steadier." },
                    "kind": { "type": "string", "enum": ["a", "b"] },
                    "days": { "type": "array", "items": { "type": "integer" } }
                },
                "required": ["process"]
            }
        })
    }

    #[test]
    fn arguments_are_given_as_json_or_not_at_all() {
        assert_eq!(parse_arguments(None).expect("none"), json!({}));
        assert_eq!(parse_arguments(Some("  ")).expect("blank"), json!({}));
        assert_eq!(parse_arguments(Some(r#"{"a":1}"#)).expect("object"), json!({ "a": 1 }));
        assert!(matches!(parse_arguments(Some("[1]")), Err(CliError::Usage(_))));
        assert!(matches!(parse_arguments(Some("{")), Err(CliError::Usage(_))));
    }

    #[test]
    fn a_tool_is_described_for_a_person() {
        let text = describe_text(&read_logs());
        assert!(text.starts_with("read_logs\n\nRead a process's output."), "{text}");
        let lines: Vec<&str> = text.lines().collect();
        let args = lines.iter().position(|line| *line == "Arguments:").expect("arguments");
        // Required first, then the schema's order.
        assert!(lines[args + 1].starts_with("  process  string") && lines[args + 1].contains("required"), "{text}");
        assert!(lines[args + 1].ends_with("The process, by name or id."), "{text}");
        assert!(lines[args + 2].trim_start() == "Its id is steadier.", "{text}");
        assert!(text.contains("integer 1–2000"), "{text}");
        assert!(text.contains("one of: a, b"), "{text}");
        assert!(text.contains("list of integer"), "{text}");
        assert!(text.ends_with(r#"crew call read_logs '{"process":"…"}'"#), "{text}");
    }

    #[test]
    fn a_tool_without_arguments_says_so() {
        let text = describe_text(&json!({ "name": "list_agents", "description": "List them.", "inputSchema": { "type": "object", "properties": {} } }));
        assert!(text.contains("No arguments."), "{text}");
        assert!(text.ends_with("crew call list_agents"), "{text}");
    }

    #[test]
    fn the_catalog_is_one_line_per_tool() {
        let tools = vec![
            json!({ "name": "list_agents", "description": "List the agents. Including you." }),
            read_logs(),
        ];
        let text = catalog_text(&tools);
        assert!(text.starts_with("usage: crew call"), "{text}");
        assert!(text.contains("list_agents  List the agents.\n"), "{text}");
        assert!(text.contains("read_logs    Read a process's output."), "{text}");
        assert!(!text.contains("Including you"), "{text}");
    }
}
