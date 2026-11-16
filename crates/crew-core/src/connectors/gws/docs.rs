//! Docs' tools: a document read as text or as its structure (where each
//! paragraph starts, its style), edited by text or by position, and the
//! API's own requests for anything else (styles, tables, lists).

use serde_json::{json, Value};

use super::{clip_to, need, number, object, params, text, tool, Args, GwsError, Run, Tool, MAX_TEXT};

pub(super) const TOOLS: &[Tool] = &[
    tool(
        "read_document",
        "Read document",
        "Read a document's title and text, or its structure: each paragraph's start and end index, style (HEADING_1, NORMAL_TEXT…) and text, and its tables, for edits by position.",
        true,
        false,
        || {
            object(
                json!({
                    "document_id": { "type": "string" },
                    "format": { "type": "string", "enum": ["text", "structure"], "default": "text" },
                    "max_chars": { "type": "integer", "minimum": 100, "default": 200000 }
                }),
                &["document_id"],
            )
        },
    ),
    tool("create_document", "Create document", "Make a document, with text when given.", false, false, || {
        object(json!({ "title": { "type": "string" }, "text": { "type": "string" } }), &["title"])
    }),
    tool(
        "edit_document",
        "Edit document",
        "Insert text at positions of read_document's structure, replace text throughout, and add text at the end, in that order and as one change.",
        false,
        false,
        || {
            object(
                json!({
                    "document_id": { "type": "string" },
                    "insert": {
                        "type": "array",
                        "items": object(json!({ "index": { "type": "integer", "minimum": 1 }, "text": { "type": "string" } }), &["index", "text"]),
                        "description": "Text to put at an index, as the document is now; later ones first, so the indexes hold."
                    },
                    "replace": {
                        "type": "array",
                        "items": object(json!({ "find": { "type": "string" }, "with": { "type": "string" }, "match_case": { "type": "boolean", "default": true } }), &["find", "with"]),
                    },
                    "append": { "type": "string", "description": "Text to add at the end." }
                }),
                &["document_id"],
            )
        },
    ),
    tool(
        "batch_update",
        "Batch update",
        "Send Docs API requests (documents.batchUpdate) as they are, all or none applied: updateParagraphStyle for headings, updateTextStyle for bold or links, createParagraphBullets, insertTable, insertPageBreak, deleteContentRange… Indexes are read_document's structure's.",
        false,
        true,
        || {
            object(
                json!({
                    "document_id": { "type": "string" },
                    "requests": { "type": "array", "items": { "type": "object" }, "minItems": 1 }
                }),
                &["document_id", "requests"],
            )
        },
    ),
];

pub(super) async fn run(run: &Run<'_>, name: &str, args: &Args) -> Result<Value, GwsError> {
    match name {
        "read_document" => {
            let p = params(json!({ "documentId": need(args, "document_id")? }));
            let doc = run.json(&["docs", "documents", "get", "--params", &p]).await?;
            let max = number(args, "max_chars", MAX_TEXT as u64, 5_000_000) as usize;
            let content = &doc["body"]["content"];
            if text(args, "format") == Some("structure") {
                return Ok(
                    json!({ "title": doc["title"], "documentId": doc["documentId"], "elements": structure(content, max) }),
                );
            }
            Ok(json!({ "title": doc["title"], "text": clip_to(&document_text(content), max) }))
        }
        "create_document" => {
            let doc = run
                .json(&["docs", "documents", "create", "--json", &json!({ "title": need(args, "title")? }).to_string()])
                .await?;
            let id = doc["documentId"].as_str().unwrap_or_default().to_string();
            if let Some(body) = args.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                batch(run, &id, vec![json!({ "insertText": { "location": { "index": 1 }, "text": body } })]).await?;
            }
            Ok(
                json!({ "documentId": id, "title": doc["title"], "link": format!("https://docs.google.com/document/d/{id}/edit") }),
            )
        }
        "edit_document" => {
            let id = need(args, "document_id")?;
            let mut inserts: Vec<(u64, String)> = args
                .get("insert")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|i| Some((i["index"].as_u64()?, i["text"].as_str().filter(|t| !t.is_empty())?.to_string())))
                .collect();
            // From the end back, so one insert doesn't move where the next goes.
            inserts.sort_by(|a, b| b.0.cmp(&a.0));
            let mut requests: Vec<Value> = inserts
                .into_iter()
                .map(|(index, text)| json!({ "insertText": { "location": { "index": index }, "text": text } }))
                .collect();
            requests.extend(args.get("replace").and_then(Value::as_array).into_iter().flatten().filter_map(|r| {
                let find = r["find"].as_str().filter(|f| !f.is_empty())?;
                Some(json!({ "replaceAllText": {
                    "containsText": { "text": find, "matchCase": r["match_case"].as_bool().unwrap_or(true) },
                    "replaceText": r["with"].as_str().unwrap_or_default(),
                }}))
            }));
            if let Some(append) = args.get("append").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                requests.push(json!({ "insertText": { "endOfSegmentLocation": {}, "text": append } }));
            }
            if requests.is_empty() {
                return Err(GwsError::Call("Give insert, replace or append".into()));
            }
            let replies = batch(run, id, requests).await?;
            let replaced: Vec<Value> =
                replies.iter().filter_map(|r| r["replaceAllText"]["occurrencesChanged"].as_u64().map(|n| json!(n))).collect();
            Ok(json!({ "documentId": id, "replaced": replaced, "appended": args.contains_key("append") }))
        }
        "batch_update" => {
            let requests = args.get("requests").and_then(Value::as_array).cloned().unwrap_or_default();
            if requests.is_empty() {
                return Err(GwsError::Call("requests is required".into()));
            }
            let id = need(args, "document_id")?;
            let replies = batch(run, id, requests).await?;
            Ok(json!({ "documentId": id, "replies": replies }))
        }
        other => Err(GwsError::Call(format!("{other} is not a tool"))),
    }
}

async fn batch(run: &Run<'_>, id: &str, requests: Vec<Value>) -> Result<Vec<Value>, GwsError> {
    let p = params(json!({ "documentId": id }));
    let body = json!({ "requests": requests }).to_string();
    let done = run.json(&["docs", "documents", "batchUpdate", "--params", &p, "--json", &body]).await?;
    Ok(done["replies"].as_array().cloned().unwrap_or_default())
}

fn paragraph_text(paragraph: &Value) -> String {
    paragraph["elements"].as_array().into_iter().flatten().filter_map(|r| r["textRun"]["content"].as_str()).collect()
}

/// A document's text, from its structure: paragraphs' runs and tables' cells.
fn document_text(content: &Value) -> String {
    let mut out = String::new();
    for element in content.as_array().into_iter().flatten() {
        out.push_str(&paragraph_text(&element["paragraph"]));
        for row in element["table"]["tableRows"].as_array().into_iter().flatten() {
            let cells: Vec<String> = row["tableCells"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| document_text(&c["content"]).trim().replace('\n', " "))
                .collect();
            out.push_str(&format!("| {} |\n", cells.join(" | ")));
        }
    }
    out
}

/// Each paragraph and table with where it is, up to `max` bytes of text.
fn structure(content: &Value, max: usize) -> Vec<Value> {
    let mut out = Vec::new();
    let mut used = 0;
    for element in content.as_array().into_iter().flatten() {
        let (start, end) = (element["startIndex"].clone(), element["endIndex"].clone());
        let item = if element["paragraph"].is_object() {
            let p = &element["paragraph"];
            let text = paragraph_text(p);
            used += text.len();
            let mut item = json!({ "start": start, "end": end, "style": p["paragraphStyle"]["namedStyleType"], "text": text });
            if p["bullet"].is_object() {
                item["bullet"] = json!(true);
            }
            item
        } else if element["table"].is_object() {
            let rows: Vec<Vec<String>> = element["table"]["tableRows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|row| {
                    row["tableCells"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|c| document_text(&c["content"]).trim().to_string())
                        .collect()
                })
                .collect();
            used += rows.iter().flatten().map(String::len).sum::<usize>();
            json!({ "start": start, "end": end, "table": rows })
        } else {
            continue;
        };
        out.push(item);
        if used > max {
            out.push(json!({ "note": format!("cut at {max} bytes of text") }));
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fake, runs, scratch};
    use super::super::{call, App};
    use super::*;

    #[test]
    fn a_document_reads_as_text_or_as_where_each_part_is() {
        let content = json!([
            { "startIndex": 1, "endIndex": 7, "paragraph": { "paragraphStyle": { "namedStyleType": "HEADING_1" }, "elements": [{ "textRun": { "content": "Title\n" } }] } },
            { "startIndex": 7, "endIndex": 20, "table": { "tableRows": [{ "tableCells": [
                { "content": [{ "paragraph": { "elements": [{ "textRun": { "content": "a\n" } }] } }] },
                { "content": [{ "paragraph": { "elements": [{ "textRun": { "content": "b\n" } }] } }] } ] }] } },
        ]);
        assert_eq!(document_text(&content), "Title\n| a | b |\n");
        let parts = structure(&content, 1000);
        assert_eq!(parts[0], json!({ "start": 1, "end": 7, "style": "HEADING_1", "text": "Title\n" }));
        assert_eq!(parts[1]["table"], json!([["a", "b"]]));
    }

    #[tokio::test]
    async fn inserts_go_last_first_then_replaces_then_the_end() {
        let dir = scratch();
        let gws = fake(&dir, r#"{"replies":[]}"#, 0);
        call(
            &gws,
            App::Docs,
            "edit_document",
            &json!({ "document_id": "d", "insert": [{ "index": 5, "text": "a" }, { "index": 40, "text": "b" }], "replace": [{ "find": "x", "with": "y" }], "append": "z" }),
            "t",
        )
        .await
        .unwrap();
        let body: Value = serde_json::from_str(&runs(&dir)[0][6]).unwrap();
        let r = &body["requests"];
        assert_eq!((&r[0]["insertText"]["location"]["index"], &r[1]["insertText"]["location"]["index"]), (&json!(40), &json!(5)));
        assert!(r[2]["replaceAllText"].is_object() && r[3]["insertText"]["endOfSegmentLocation"].is_object());
        let _ = std::fs::remove_dir_all(dir);
    }
}
