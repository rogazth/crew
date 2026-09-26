//! `crew agents`, `crew send` and `crew tabs`: the roster and the browser, as
//! `list_agents`, `message_agent` and `list_tabs` answer them.

use std::process::ExitCode;

use serde_json::{json, Value};

use crate::output::{self, Column};
use crate::{read_stdin, CliError, Ctx};

const AGENT_COLUMNS: &[Column] = &[
    Column::new("NAME", &["name"]),
    Column::new("ID", &["id"]),
    Column::new("PROVIDER", &["provider"]),
    Column::new("MODEL", &["model"]),
    Column::new("STATUS", &["status"]),
    Column::with("", &["self"], you),
];

fn you(value: &Value) -> String {
    if value.as_bool() == Some(true) { "(you)".into() } else { String::new() }
}

pub fn list(ctx: &Ctx) -> Result<ExitCode, CliError> {
    let reply = ctx.client()?.run("list_agents", json!({}))?;
    ctx.show(&reply, |value| {
        let rows = output::rows(value, &["agents"])?;
        if rows.is_empty() {
            return Some("No agents in this workspace.".into());
        }
        Some(output::table(rows, AGENT_COLUMNS).render(output::styled()))
    });
    Ok(ExitCode::SUCCESS)
}

/// `message_agent` takes an id and only an id, because a name the user
/// changes goes stale in an agent's memory. A person typing at a shell has no
/// such memory, so a name is looked up here, once, and the id is what is sent.
pub fn send(ctx: &Ctx, agent: &str, words: &[String]) -> Result<ExitCode, CliError> {
    let text = if words.len() == 1 && words[0] == "-" { read_stdin()? } else { words.join(" ") };
    if text.trim().is_empty() {
        return Err(CliError::Usage("Nothing to send.".into()));
    }
    let client = ctx.client()?;
    let roster = client.run("list_agents", json!({}))?.value();
    let to = pick_agent(output::rows(&roster, &["agents"]).map(Vec::as_slice).unwrap_or(&[]), agent)?;
    let reply = client.run("message_agent", json!({ "to": to, "text": text }))?;
    ctx.show(&reply, |value| value.get("note").and_then(Value::as_str).map(str::to_string));
    Ok(ExitCode::SUCCESS)
}

/// The id `who` means: an id as it is, else the one agent by that name. Two
/// by one name is a question only the person can answer.
fn pick_agent(rows: &[Value], who: &str) -> Result<String, CliError> {
    let who = who.trim();
    let field = |row: &Value, key: &str| row.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    if rows.iter().any(|row| field(row, "id") == who) {
        return Ok(who.to_string());
    }
    let named: Vec<&Value> = rows.iter().filter(|row| field(row, "name").eq_ignore_ascii_case(who)).collect();
    match named.as_slice() {
        [one] => Ok(field(one, "id")),
        [] => Err(CliError::Failed(format!(
            "No agent {who} in this workspace. `crew agents` lists them{}",
            if rows.is_empty() { "; there are none.".to_string() } else { ".".to_string() }
        ))),
        many => Err(CliError::Failed(format!(
            "{} agents are called {who}; name one by id: {}",
            many.len(),
            many.iter().map(|row| field(row, "id")).collect::<Vec<_>>().join(", ")
        ))),
    }
}

/// `list_tabs` answers in lines already written for a reader, one per tab,
/// and those are printed as they come; an answer in JSON gets a table.
pub fn tabs(ctx: &Ctx) -> Result<ExitCode, CliError> {
    let reply = ctx.client()?.run("list_tabs", json!({}))?;
    ctx.show(&reply, |value| {
        let rows = output::rows(value, &["tabs"])?;
        let columns = [
            Column::new("ID", &["id", "pageId", "tab"]),
            Column::new("TITLE", &["title"]),
            Column::new("URL", &["url"]),
            Column::new("HOLDER", &["holder", "lease", "usedBy"]),
        ];
        Some(output::table(rows, &columns).render(output::styled()))
    });
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roster() -> Vec<Value> {
        vec![
            json!({ "id": "a1", "name": "Reviewer" }),
            json!({ "id": "b2", "name": "Coder" }),
            json!({ "id": "c3", "name": "coder" }),
        ]
    }

    #[test]
    fn an_agent_is_named_by_id_or_by_its_one_name() {
        assert_eq!(pick_agent(&roster(), "b2").expect("id"), "b2");
        assert_eq!(pick_agent(&roster(), " reviewer ").expect("name"), "a1");
    }

    #[test]
    fn a_shared_name_or_a_stranger_is_refused_with_what_to_do() {
        let CliError::Failed(twice) = pick_agent(&roster(), "Coder").unwrap_err() else { panic!() };
        assert!(twice.contains("b2") && twice.contains("c3"), "{twice}");
        let CliError::Failed(nobody) = pick_agent(&roster(), "Tester").unwrap_err() else { panic!() };
        assert!(nobody.contains("crew agents"), "{nobody}");
    }

    #[test]
    fn the_agents_table_marks_you() {
        let rows = vec![json!({ "id": "a1", "name": "Me", "provider": "claude", "self": true })];
        let table = output::table(&rows, AGENT_COLUMNS);
        assert_eq!(table.headers, ["NAME", "ID", "PROVIDER", ""]);
        assert_eq!(table.rows[0], ["Me", "a1", "claude", "(you)"]);
    }
}
