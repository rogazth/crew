//! Gmail's tools. What changes labels works on many messages or threads at
//! once; what sends builds the email here (`mime.rs`) and hands Gmail its
//! bytes, so replies, drafts and attachments all go one way.

use serde_json::{json, Value};

use super::mime::{attachments_of, Attachment, Mail};
use super::{
    clip_to, each, escape_html, file_answer, flag, ids, need, number, object, outcome, params, strings, text, tool, Args,
    GwsError, Run, Tool,
};

fn ids_schema() -> Value {
    json!({
        "message_ids": { "type": "array", "items": { "type": "string" }, "maxItems": 1000, "description": "Message ids, as search_emails answers them." },
        "thread_ids": { "type": "array", "items": { "type": "string" }, "maxItems": 500, "description": "Thread ids: every message of each thread." },
        "message_id": { "type": "string", "description": "One message, instead of message_ids." },
        "thread_id": { "type": "string", "description": "One thread, instead of thread_ids." }
    })
}

fn with(mut base: Value, more: Value) -> Value {
    if let (Some(base), Some(more)) = (base.as_object_mut(), more.as_object()) {
        base.extend(more.clone());
    }
    base
}

fn attachments_schema() -> Value {
    json!({
        "type": "array",
        "maxItems": 100,
        "description": "Files to attach, up to 25 MB together. Each gives path (a file in your working folder) or content (base64).",
        "items": {
            "type": "object",
            "properties": {
                "filename": { "type": "string", "maxLength": 255, "description": "The name the recipient sees, like factura.pdf." },
                "path": { "type": "string", "description": "A file in your working folder; Crew reads it." },
                "content": { "type": "string", "description": "The whole file as base64, instead of path." },
                "mime_type": { "type": "string", "description": "Like application/pdf; application/octet-stream by default." }
            },
            "required": ["filename"],
            "additionalProperties": false
        }
    })
}

/// What an email says: the fields `send_email` and the drafts share.
fn letter() -> Value {
    json!({
        "to": { "type": "string", "description": "Comma-separated addresses. For a reply, added to who it goes to." },
        "cc": { "type": "string" },
        "bcc": { "type": "string" },
        "subject": { "type": "string", "description": "For a reply, Re: and the original's by default." },
        "body": { "type": "string", "description": "Plain text." },
        "html_body": { "type": "string", "description": "HTML; the plain text is made from it when body is not given." },
        "from": { "type": "string", "description": "A send-as address of get_profile; the account's own by default." },
        "attachments": attachments_schema()
    })
}

fn reply() -> Value {
    json!({
        "reply_to_message_id": { "type": "string", "description": "A message to reply to, in its thread." },
        "reply_all": { "type": "boolean", "default": false, "description": "With reply_to_message_id: everyone on it, not only its sender." },
        "include_quote": { "type": "boolean", "default": true, "description": "With reply_to_message_id: quote the original below." }
    })
}

pub(super) const TOOLS: &[Tool] = &[
    tool(
        "search_emails",
        "Search emails",
        "Search the mailbox with Gmail's search syntax (from:, to:, subject:, is:unread, newer_than:7d, label:, has:attachment…). Answers each message's or thread's id, sender, subject, date, labels and snippet; ids_only answers ids alone, up to 500 a page, to hand to the tools that work on many.",
        true,
        false,
        || {
            object(
                json!({
                    "query": { "type": "string", "description": "Gmail search, as in its search box. Empty lists the latest." },
                    "label_ids": { "type": "array", "items": { "type": "string" }, "description": "Only these labels, like INBOX or a list_labels id." },
                    "by": { "type": "string", "enum": ["message", "thread"], "default": "message" },
                    "max_results": { "type": "integer", "minimum": 1, "maximum": 500, "default": 20, "description": "Up to 100 without ids_only." },
                    "page_token": { "type": "string", "description": "The nextPageToken of the previous answer." },
                    "include_spam_trash": { "type": "boolean", "default": false },
                    "ids_only": { "type": "boolean", "default": false }
                }),
                &[],
            )
        },
    ),
    tool("read_email", "Read email", "Read one message: its headers, labels, text and the names of its attachments.", true, false, || {
        object(
            json!({
                "message_id": { "type": "string" },
                "max_chars": { "type": "integer", "minimum": 100, "default": 50000 },
                "format": { "type": "string", "enum": ["text", "html"], "default": "text", "description": "html answers the HTML part when there is one." }
            }),
            &["message_id"],
        )
    }),
    tool("read_thread", "Read thread", "Read a thread's messages: sender, recipients, subject, date, labels, text and attachments of each.", true, false, || {
        object(
            json!({
                "thread_id": { "type": "string" },
                "max_chars": { "type": "integer", "minimum": 100, "default": 20000, "description": "Of each message's text." }
            }),
            &["thread_id"],
        )
    }),
    tool(
        "download_attachment",
        "Download attachment",
        "Save an attachment of a message as a file in your working folder, to open it with your own tools.",
        true,
        false,
        || {
            object(
                json!({
                    "message_id": { "type": "string" },
                    "filename": { "type": "string", "description": "As read_email lists it." },
                    "save_to": { "type": "string", "description": "A path in your working folder; an existing file is not replaced." }
                }),
                &["message_id", "filename", "save_to"],
            )
        },
    ),
    tool("get_profile", "Get profile", "The account's address, how many messages and threads it holds, and the addresses it can send as.", true, false, || {
        object(json!({}), &[])
    }),
    tool("list_labels", "List labels", "List the mailbox's labels, with their ids, for modify_labels and search.", true, false, || object(json!({}), &[])),
    tool(
        "save_label",
        "Save label",
        "Make a label, or rename or restyle one with label_id. A nested label is named Parent/Child.",
        false,
        false,
        || {
            object(
                json!({
                    "label_id": { "type": "string", "description": "A label to change; without it one is made." },
                    "name": { "type": "string" },
                    "show_in_label_list": { "type": "string", "enum": ["labelShow", "labelShowIfUnread", "labelHide"] },
                    "show_in_message_list": { "type": "string", "enum": ["show", "hide"] },
                    "background_color": { "type": "string", "description": "A hex color of Gmail's palette, like #16a766." },
                    "text_color": { "type": "string", "description": "A hex color of Gmail's palette, like #ffffff." }
                }),
                &[],
            )
        },
    ),
    tool("delete_label", "Delete label", "Delete a label. Its messages stay, without it.", false, true, || {
        object(json!({ "label_id": { "type": "string" } }), &["label_id"])
    }),
    tool(
        "modify_labels",
        "Change labels",
        "Add or remove labels on many messages or threads at once: archive (remove INBOX), mark read (remove UNREAD), star (add STARRED), or labels of list_labels, by id or name.",
        false,
        false,
        || {
            object(
                with(
                    ids_schema(),
                    json!({
                        "add": { "type": "array", "items": { "type": "string" }, "description": "Label ids or names to add." },
                        "remove": { "type": "array", "items": { "type": "string" }, "description": "Label ids or names to remove." }
                    }),
                ),
                &[],
            )
        },
    ),
    tool("trash_emails", "Trash emails", "Move many messages or threads to the trash. Gmail deletes them for good after 30 days; restore_emails brings them back before.", false, true, || {
        object(ids_schema(), &[])
    }),
    tool("spam_emails", "Mark as spam", "Mark many messages or threads as spam, out of the inbox.", false, true, || object(ids_schema(), &[])),
    tool(
        "restore_emails",
        "Restore emails",
        "Bring many messages or threads back to the inbox from the trash or from spam.",
        false,
        false,
        || {
            object(
                with(ids_schema(), json!({ "from": { "type": "string", "enum": ["trash", "spam"] } })),
                &["from"],
            )
        },
    ),
    tool("send_email", "Send email", "Send an email, new or as a reply, with attachments.", false, true, || {
        object(with(letter(), reply()), &[])
    }),
    tool(
        "forward",
        "Forward",
        "Forward a message to new recipients, with a note above it and the attachments of it named.",
        false,
        true,
        || {
            object(
                json!({
                    "message_id": { "type": "string" },
                    "to": { "type": "string", "description": "Comma-separated addresses." },
                    "cc": { "type": "string" },
                    "bcc": { "type": "string" },
                    "comment": { "type": "string", "description": "A note above the forwarded message." },
                    "html_comment": { "type": "string", "description": "The note as HTML." },
                    "from": { "type": "string" },
                    "attachments": { "type": "array", "items": { "type": "string" }, "description": "Names of the original's attachments to send along, as read_email lists them. None: the text alone." }
                }),
                &["message_id", "to"],
            )
        },
    ),
    tool("list_drafts", "List drafts", "List drafts: each one's id, recipients, subject and snippet.", true, false, || {
        object(
            json!({
                "query": { "type": "string", "description": "Gmail search among the drafts." },
                "max_results": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
                "page_token": { "type": "string" }
            }),
            &[],
        )
    }),
    tool("get_draft", "Get draft", "Read a draft: its recipients, subject, text and attachments.", true, false, || {
        object(
            json!({ "draft_id": { "type": "string" }, "max_chars": { "type": "integer", "minimum": 100, "default": 50000 } }),
            &["draft_id"],
        )
    }),
    tool("create_draft", "Create draft", "Write a draft, new or as a reply, with attachments, without sending it.", false, false, || {
        object(with(letter(), reply()), &[])
    }),
    tool(
        "update_draft",
        "Update draft",
        "Change a draft: only the fields given change. A body or html_body given replaces both of the draft's; attachments given replace its files.",
        false,
        false,
        || object(with(json!({ "draft_id": { "type": "string" } }), letter()), &["draft_id"]),
    ),
    tool("send_draft", "Send draft", "Send a draft as it is.", false, true, || {
        object(json!({ "draft_id": { "type": "string" } }), &["draft_id"])
    }),
    tool("delete_draft", "Delete draft", "Delete a draft for good.", false, true, || {
        object(json!({ "draft_id": { "type": "string" } }), &["draft_id"])
    }),
    tool("list_filters", "List filters", "List the mailbox's filters: what each matches and what it does.", true, false, || object(json!({}), &[])),
    tool(
        "create_filter",
        "Create filter",
        "Make a filter for mail that comes from now on: what it matches (criteria) and what it does (action), as Gmail's API names them.",
        false,
        true,
        || {
            object(
                json!({
                    "criteria": {
                        "type": "object",
                        "properties": {
                            "from": { "type": "string" }, "to": { "type": "string" }, "subject": { "type": "string" },
                            "query": { "type": "string", "description": "Gmail search." }, "negatedQuery": { "type": "string" },
                            "hasAttachment": { "type": "boolean" }, "excludeChats": { "type": "boolean" },
                            "size": { "type": "integer", "description": "Bytes." }, "sizeComparison": { "type": "string", "enum": ["larger", "smaller"] }
                        },
                        "additionalProperties": false
                    },
                    "action": {
                        "type": "object",
                        "properties": {
                            "addLabelIds": { "type": "array", "items": { "type": "string" } },
                            "removeLabelIds": { "type": "array", "items": { "type": "string" }, "description": "INBOX to skip the inbox, UNREAD to mark read." },
                            "forward": { "type": "string", "description": "A verified forwarding address." }
                        },
                        "additionalProperties": false
                    }
                }),
                &["criteria", "action"],
            )
        },
    ),
    tool("delete_filter", "Delete filter", "Delete a filter.", false, true, || {
        object(json!({ "filter_id": { "type": "string" } }), &["filter_id"])
    }),
];

/* ── Running them ─────────────────────────────────────────────────────── */

pub(super) async fn run(run: &Run<'_>, name: &str, args: &Args) -> Result<Value, GwsError> {
    match name {
        "search_emails" => search(run, args).await,
        "read_email" => {
            let m = message(run, need(args, "message_id")?, "full").await?;
            Ok(readable(&m, number(args, "max_chars", 50_000, 5_000_000) as usize, text(args, "format") == Some("html")))
        }
        "read_thread" => {
            let p = params(json!({ "userId": "me", "id": need(args, "thread_id")?, "format": "full" }));
            let thread = run.json(&["gmail", "users", "threads", "get", "--params", &p]).await?;
            let max = number(args, "max_chars", 20_000, 1_000_000) as usize;
            let messages: Vec<Value> =
                thread["messages"].as_array().into_iter().flatten().map(|m| readable(m, max, false)).collect();
            Ok(json!({ "id": thread["id"], "messages": messages }))
        }
        "download_attachment" => {
            let id = need(args, "message_id")?;
            let m = message(run, id, "full").await?;
            let wanted = need(args, "filename")?;
            let part = the_part(&m["payload"], wanted)?;
            let data = part_data(run, id, part).await?;
            Ok(file_answer(
                wanted,
                part["mimeType"].as_str().unwrap_or("application/octet-stream"),
                &data,
                need(args, "save_to")?,
            ))
        }
        "get_profile" => {
            let profile = run.json(&["gmail", "users", "getProfile", "--params", r#"{"userId":"me"}"#]).await?;
            let send_as = send_as(run).await?;
            Ok(json!({
                "email": profile["emailAddress"], "messagesTotal": profile["messagesTotal"], "threadsTotal": profile["threadsTotal"],
                "sendAs": send_as.iter().map(|s| json!({
                    "email": s["sendAsEmail"], "name": s["displayName"], "default": s["isDefault"], "primary": s["isPrimary"],
                })).collect::<Vec<_>>(),
            }))
        }
        "list_labels" => {
            let labels = labels(run).await?;
            Ok(json!(labels
                .iter()
                .map(|l| json!({ "id": l["id"], "name": l["name"], "type": l["type"], "color": l["color"] }))
                .collect::<Vec<_>>()))
        }
        "save_label" => {
            let mut body = serde_json::Map::new();
            for (key, field) in [
                ("name", "name"),
                ("show_in_label_list", "labelListVisibility"),
                ("show_in_message_list", "messageListVisibility"),
            ] {
                if let Some(v) = text(args, key) {
                    body.insert(field.into(), json!(v));
                }
            }
            if text(args, "background_color").is_some() || text(args, "text_color").is_some() {
                body.insert(
                    "color".into(),
                    json!({ "backgroundColor": text(args, "background_color"), "textColor": text(args, "text_color") }),
                );
            }
            let body = Value::Object(body).to_string();
            let label = match text(args, "label_id") {
                Some(id) => {
                    let p = params(json!({ "userId": "me", "id": id }));
                    run.json(&["gmail", "users", "labels", "patch", "--params", &p, "--json", &body]).await?
                }
                None => {
                    need(args, "name")?;
                    run.json(&["gmail", "users", "labels", "create", "--params", r#"{"userId":"me"}"#, "--json", &body]).await?
                }
            };
            Ok(json!({ "id": label["id"], "name": label["name"], "color": label["color"] }))
        }
        "delete_label" => {
            let p = params(json!({ "userId": "me", "id": need(args, "label_id")? }));
            run.json(&["gmail", "users", "labels", "delete", "--params", &p]).await?;
            Ok(json!({ "deleted": true }))
        }
        "modify_labels" => {
            let add = label_ids(run, strings(args, "add")).await?;
            let remove = label_ids(run, strings(args, "remove")).await?;
            if add.is_empty() && remove.is_empty() {
                return Err(GwsError::Call("Give add or remove".into()));
            }
            relabel(run, target(args)?, &add, &remove, Way::Modify).await
        }
        "trash_emails" => relabel(run, target(args)?, &["TRASH".into()], &[], Way::Trash).await,
        "spam_emails" => relabel(run, target(args)?, &["SPAM".into()], &["INBOX".into()], Way::Modify).await,
        "restore_emails" => match need(args, "from")? {
            "trash" => relabel(run, target(args)?, &["INBOX".into()], &["TRASH".into()], Way::Untrash).await,
            "spam" => relabel(run, target(args)?, &["INBOX".into()], &["SPAM".into()], Way::Modify).await,
            _ => Err(GwsError::Call("from is trash or spam".into())),
        },
        "send_email" | "create_draft" => {
            let (mail, thread) = compose(run, args).await?;
            if mail.to.is_none() && mail.cc.is_none() && mail.bcc.is_none() && name == "send_email" {
                return Err(GwsError::Call("to is required".into()));
            }
            if name == "send_email" {
                send(run, &mail, thread.as_deref()).await
            } else {
                draft(run, None, &mail, thread.as_deref()).await
            }
        }
        "update_draft" => {
            let id = need(args, "draft_id")?;
            let (mail, thread) = redraft(run, id, args).await?;
            draft(run, Some(id), &mail, thread.as_deref()).await
        }
        "forward" => forward(run, args).await,
        "list_drafts" => {
            let p = params(json!({
                "userId": "me", "q": text(args, "query"), "maxResults": number(args, "max_results", 20, 100), "pageToken": text(args, "page_token"),
            }));
            let list = run.json(&["gmail", "users", "drafts", "list", "--params", &p]).await?;
            let found: Vec<String> =
                list["drafts"].as_array().into_iter().flatten().filter_map(|d| d["id"].as_str().map(str::to_string)).collect();
            let drafts = each(found, |id| async move {
                let p = params(json!({ "userId": "me", "id": id, "format": "metadata" }));
                match run.json(&["gmail", "users", "drafts", "get", "--params", &p]).await {
                    Ok(d) => Ok(json!({
                        "draft_id": d["id"], "message_id": d["message"]["id"], "thread_id": d["message"]["threadId"],
                        "to": header(&d["message"], "To"), "subject": header(&d["message"], "Subject"), "snippet": d["message"]["snippet"],
                    })),
                    Err(GwsError::Forbidden(e) | GwsError::Call(e)) => Ok(json!({ "draft_id": id, "error": e })),
                    Err(e) => Err(e),
                }
            })
            .await
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({ "drafts": drafts, "nextPageToken": list["nextPageToken"] }))
        }
        "get_draft" => {
            let p = params(json!({ "userId": "me", "id": need(args, "draft_id")?, "format": "full" }));
            let d = run.json(&["gmail", "users", "drafts", "get", "--params", &p]).await?;
            let mut read = readable(&d["message"], number(args, "max_chars", 50_000, 5_000_000) as usize, false);
            read["draft_id"] = d["id"].clone();
            Ok(read)
        }
        "send_draft" => {
            let body = json!({ "id": need(args, "draft_id")? }).to_string();
            let sent = run.json(&["gmail", "users", "drafts", "send", "--params", r#"{"userId":"me"}"#, "--json", &body]).await?;
            Ok(json!({ "sent": true, "id": sent["id"], "threadId": sent["threadId"] }))
        }
        "delete_draft" => {
            let p = params(json!({ "userId": "me", "id": need(args, "draft_id")? }));
            run.json(&["gmail", "users", "drafts", "delete", "--params", &p]).await?;
            Ok(json!({ "deleted": true }))
        }
        "list_filters" => {
            let list = run.json(&["gmail", "users", "settings", "filters", "list", "--params", r#"{"userId":"me"}"#]).await?;
            Ok(json!(list["filter"].as_array().cloned().unwrap_or_default()))
        }
        "create_filter" => {
            let body = json!({ "criteria": args.get("criteria").cloned().unwrap_or(json!({})), "action": args.get("action").cloned().unwrap_or(json!({})) });
            run.json(&[
                "gmail",
                "users",
                "settings",
                "filters",
                "create",
                "--params",
                r#"{"userId":"me"}"#,
                "--json",
                &body.to_string(),
            ])
            .await
        }
        "delete_filter" => {
            let p = params(json!({ "userId": "me", "id": need(args, "filter_id")? }));
            run.json(&["gmail", "users", "settings", "filters", "delete", "--params", &p]).await?;
            Ok(json!({ "deleted": true }))
        }
        other => Err(GwsError::Call(format!("{other} is not a tool"))),
    }
}

async fn search(run: &Run<'_>, args: &Args) -> Result<Value, GwsError> {
    let ids_only = flag(args, "ids_only", false);
    let threads = text(args, "by") == Some("thread");
    let max = number(args, "max_results", 20, if ids_only { 500 } else { 100 });
    let label_ids = strings(args, "label_ids");
    let p = params(json!({
        "userId": "me", "q": text(args, "query"), "maxResults": max, "pageToken": text(args, "page_token"),
        "includeSpamTrash": flag(args, "include_spam_trash", false),
        "labelIds": if label_ids.is_empty() { Value::Null } else { json!(label_ids) },
    }));
    let kind = if threads { "threads" } else { "messages" };
    let list = run.json(&["gmail", "users", kind, "list", "--params", &p]).await?;
    let found: Vec<Value> = list[kind].as_array().cloned().unwrap_or_default();
    let mut answer = json!({ "nextPageToken": list["nextPageToken"], "resultSizeEstimate": list["resultSizeEstimate"] });
    if ids_only {
        answer[kind] = json!(found
            .iter()
            .map(|f| if threads { f["id"].clone() } else { json!({ "id": f["id"], "threadId": f["threadId"] }) })
            .collect::<Vec<_>>());
        return Ok(answer);
    }
    let ids: Vec<String> = found.iter().filter_map(|f| f["id"].as_str().map(str::to_string)).collect();
    let summaries = each(ids, |id| async move {
        let p = params(json!({ "userId": "me", "id": id, "format": "metadata", "metadataHeaders": ["From", "To", "Subject", "Date"] }));
        let got = run.json(&["gmail", "users", kind, "get", "--params", &p]).await;
        match got {
            Ok(got) if threads => {
                let messages = got["messages"].as_array().cloned().unwrap_or_default();
                let (first, last) = (messages.first().cloned().unwrap_or_default(), messages.last().cloned().unwrap_or_default());
                let mut labels: Vec<Value> = Vec::new();
                for l in messages.iter().flat_map(|m| m["labelIds"].as_array().cloned().unwrap_or_default()) {
                    if !labels.contains(&l) {
                        labels.push(l);
                    }
                }
                Ok(json!({
                    "id": got["id"], "subject": header(&first, "Subject"), "from": header(&last, "From"), "date": header(&last, "Date"),
                    "messages": messages.len(), "labels": labels, "snippet": last["snippet"],
                }))
            }
            Ok(m) => Ok(json!({
                "id": m["id"], "threadId": m["threadId"], "from": header(&m, "From"), "to": header(&m, "To"),
                "subject": header(&m, "Subject"), "date": header(&m, "Date"), "labels": m["labelIds"], "snippet": m["snippet"],
            })),
            Err(GwsError::Forbidden(e) | GwsError::Call(e)) => Ok(json!({ "id": id, "error": e })),
            Err(e) => Err(e),
        }
    })
    .await
    .into_iter()
    .collect::<Result<Vec<_>, _>>()?;
    answer[kind] = json!(summaries);
    Ok(answer)
}

async fn message(run: &Run<'_>, id: &str, format: &str) -> Result<Value, GwsError> {
    let p = params(json!({ "userId": "me", "id": id, "format": format }));
    run.json(&["gmail", "users", "messages", "get", "--params", &p]).await
}

async fn labels(run: &Run<'_>) -> Result<Vec<Value>, GwsError> {
    let labels = run.json(&["gmail", "users", "labels", "list", "--params", r#"{"userId":"me"}"#]).await?;
    Ok(labels["labels"].as_array().cloned().unwrap_or_default())
}

async fn send_as(run: &Run<'_>) -> Result<Vec<Value>, GwsError> {
    let list = run.json(&["gmail", "users", "settings", "sendAs", "list", "--params", r#"{"userId":"me"}"#]).await?;
    Ok(list["sendAs"].as_array().cloned().unwrap_or_default())
}

/// Labels as ids: a system one (INBOX) or an id stays, a name is looked up.
async fn label_ids(run: &Run<'_>, given: Vec<String>) -> Result<Vec<String>, GwsError> {
    let plain =
        |l: &String| l.starts_with("Label_") || l.chars().all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit());
    if given.iter().all(plain) {
        return Ok(given);
    }
    let known = labels(run).await?;
    given
        .into_iter()
        .map(|l| {
            known
                .iter()
                .find(|k| k["id"].as_str() == Some(&l))
                .or_else(|| known.iter().find(|k| k["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(&l))))
                .and_then(|k| k["id"].as_str().map(str::to_string))
                .ok_or_else(|| GwsError::Call(format!("No label {l}; list_labels lists them, save_label makes one")))
        })
        .collect()
}

enum Target {
    Messages(Vec<String>),
    Threads(Vec<String>),
}

fn target(args: &Args) -> Result<Target, GwsError> {
    let messages = ids(args, "message_ids", "message_id");
    let threads = ids(args, "thread_ids", "thread_id");
    match (messages.is_empty(), threads.is_empty()) {
        (false, true) => Ok(Target::Messages(messages)),
        (true, false) => Ok(Target::Threads(threads)),
        (true, true) => Err(GwsError::Call("Give message_ids or thread_ids".into())),
        (false, false) => Err(GwsError::Call("Give message_ids or thread_ids, not both".into())),
    }
}

/// How a thread is moved: Gmail has its own calls for the trash.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Way {
    Modify,
    Trash,
    Untrash,
}

/// Labels changed on many: messages a thousand per call, threads one each.
async fn relabel(run: &Run<'_>, target: Target, add: &[String], remove: &[String], way: Way) -> Result<Value, GwsError> {
    let results = match target {
        Target::Messages(ids) => {
            let mut results = Vec::new();
            for chunk in ids.chunks(1000) {
                let body = json!({ "ids": chunk, "addLabelIds": add, "removeLabelIds": remove }).to_string();
                let done = run
                    .json(&["gmail", "users", "messages", "batchModify", "--params", r#"{"userId":"me"}"#, "--json", &body])
                    .await
                    .map(drop);
                results.extend(chunk.iter().map(|id| (id.clone(), clone_result(&done))));
            }
            results
        }
        Target::Threads(ids) => {
            each(ids, |id| async move {
                let p = params(json!({ "userId": "me", "id": id }));
                let done = match way {
                    Way::Trash => run.json(&["gmail", "users", "threads", "trash", "--params", &p]).await,
                    Way::Untrash => {
                        let untrashed = run.json(&["gmail", "users", "threads", "untrash", "--params", &p]).await;
                        let body = json!({ "addLabelIds": ["INBOX"] }).to_string();
                        match untrashed {
                            Ok(_) => run.json(&["gmail", "users", "threads", "modify", "--params", &p, "--json", &body]).await,
                            e => e,
                        }
                    }
                    Way::Modify => {
                        let body = json!({ "addLabelIds": add, "removeLabelIds": remove }).to_string();
                        run.json(&["gmail", "users", "threads", "modify", "--params", &p, "--json", &body]).await
                    }
                };
                (id, done.map(drop))
            })
            .await
        }
    };
    outcome(results)
}

fn clone_result(r: &Result<(), GwsError>) -> Result<(), GwsError> {
    match r {
        Ok(()) => Ok(()),
        Err(GwsError::Unauthorized) => Err(GwsError::Unauthorized),
        Err(GwsError::Forbidden(m)) => Err(GwsError::Forbidden(m.clone())),
        Err(GwsError::Call(m)) => Err(GwsError::Call(m.clone())),
        Err(GwsError::Setup(m)) => Err(GwsError::Setup(m.clone())),
    }
}

/* ── Reading messages ─────────────────────────────────────────────────── */

fn header(m: &Value, name: &str) -> Option<String> {
    m["payload"]["headers"]
        .as_array()?
        .iter()
        .find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .and_then(|h| h["value"].as_str())
        .map(str::to_string)
}

/// A message as a model reads it: its headers and its text.
fn readable(m: &Value, max: usize, html: bool) -> Value {
    let payload = &m["payload"];
    let plain = || part_text(payload, "text/plain");
    let from_html = || part_text(payload, "text/html");
    let body = if html { from_html().or_else(plain) } else { plain().or_else(|| from_html().map(|h| super::strip_html(&h))) };
    json!({
        "id": m["id"], "threadId": m["threadId"], "from": header(m, "From"), "to": header(m, "To"), "cc": header(m, "Cc"),
        "bcc": header(m, "Bcc"), "subject": header(m, "Subject"), "date": header(m, "Date"), "labels": m["labelIds"],
        "text": body.map(|b| clip_to(&b, max)).unwrap_or_else(|| m["snippet"].as_str().unwrap_or_default().to_string()),
        "attachments": attachments(payload),
    })
}

/// The first part of a MIME type in a message, decoded.
fn part_text(part: &Value, mime: &str) -> Option<String> {
    if part["mimeType"].as_str() == Some(mime) && part["filename"].as_str().unwrap_or_default().is_empty() {
        if let Some(data) = part["body"]["data"].as_str() {
            return super::decode64(data).map(|b| String::from_utf8_lossy(&b).into_owned());
        }
    }
    part["parts"].as_array().into_iter().flatten().find_map(|p| part_text(p, mime))
}

fn files(part: &Value) -> Vec<&Value> {
    let mut out = Vec::new();
    if part["filename"].as_str().is_some_and(|n| !n.is_empty()) {
        out.push(part);
    }
    for p in part["parts"].as_array().into_iter().flatten() {
        out.extend(files(p));
    }
    out
}

fn attachments(part: &Value) -> Vec<Value> {
    files(part).iter().map(|p| json!({ "name": p["filename"], "mimeType": p["mimeType"], "size": p["body"]["size"] })).collect()
}

/// The one attachment of that name: two of the same name can't be told apart.
fn the_part<'a>(payload: &'a Value, name: &str) -> Result<&'a Value, GwsError> {
    let all = files(payload);
    let named: Vec<&Value> = all.iter().copied().filter(|p| p["filename"].as_str() == Some(name)).collect();
    match named.len() {
        1 => Ok(named[0]),
        0 => {
            let have: Vec<&str> = all.iter().filter_map(|p| p["filename"].as_str()).collect();
            Err(GwsError::Call(if have.is_empty() {
                format!("No attachment {name}: the message has none")
            } else {
                format!("No attachment {name}; it has {}", have.join(", "))
            }))
        }
        _ => Err(GwsError::Call(format!("The message has {} attachments named {name}; they can't be told apart", named.len()))),
    }
}

async fn part_data(run: &Run<'_>, message_id: &str, part: &Value) -> Result<Vec<u8>, GwsError> {
    let data = match part["body"]["attachmentId"].as_str() {
        Some(attachment) => {
            let p = params(json!({ "userId": "me", "messageId": message_id, "id": attachment }));
            let got = run.json(&["gmail", "users", "messages", "attachments", "get", "--params", &p]).await?;
            got["data"].as_str().map(str::to_string)
        }
        None => part["body"]["data"].as_str().map(str::to_string),
    };
    data.and_then(|d| super::decode64(&d)).ok_or_else(|| GwsError::Call("Gmail sent the attachment empty".into()))
}

async fn files_of(run: &Run<'_>, message_id: &str, payload: &Value, names: &[String]) -> Result<Vec<Attachment>, GwsError> {
    let mut out = Vec::new();
    for name in names {
        let part = the_part(payload, name)?;
        out.push(Attachment {
            filename: name.clone(),
            mime_type: part["mimeType"].as_str().unwrap_or("application/octet-stream").to_string(),
            data: part_data(run, message_id, part).await?,
        });
    }
    let total: usize = out.iter().map(|a| a.data.len()).sum();
    if total > super::MAX_FILE {
        return Err(GwsError::Call(format!("The attachments are over {} MB together", super::MAX_FILE >> 20)));
    }
    Ok(out)
}

/* ── Writing them ─────────────────────────────────────────────────────── */

/// The address in `Name <a@x.dev>`, lowercased.
fn address(entry: &str) -> String {
    let entry = entry.trim();
    match (entry.rfind('<'), entry.rfind('>')) {
        (Some(open), Some(close)) if open < close => entry[open + 1..close].trim().to_lowercase(),
        _ => entry.trim_matches('"').to_lowercase(),
    }
}

/// A header's addresses, split on the commas outside quotes.
fn split_addresses(list: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in list.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            ',' | ';' if !quoted => out.push(std::mem::take(&mut current)),
            c => current.push(c),
        }
    }
    out.push(current);
    out.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

/// Lists joined, each address once, leaving out `skip`'s.
fn join_addresses(lists: &[Option<String>], skip: &[String]) -> Option<String> {
    let mut seen: Vec<String> = skip.to_vec();
    let mut out = Vec::new();
    for entry in lists.iter().flatten().flat_map(|l| split_addresses(l)) {
        let addr = address(&entry);
        if !seen.contains(&addr) {
            seen.push(addr);
            out.push(entry);
        }
    }
    (!out.is_empty()).then(|| out.join(", "))
}

fn given(args: &Args, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string)
}

/// A new email from a tool's fields, and the thread it goes in when it is a reply.
async fn compose(run: &Run<'_>, args: &Args) -> Result<(Mail, Option<String>), GwsError> {
    let mut mail = Mail {
        from: given(args, "from"),
        to: given(args, "to"),
        cc: given(args, "cc"),
        bcc: given(args, "bcc"),
        subject: given(args, "subject"),
        text: given(args, "body"),
        html: given(args, "html_body"),
        attachments: attachments_of(args.get("attachments"))?,
        ..Mail::default()
    };
    if mail.text.is_none() && mail.html.is_none() {
        return Err(GwsError::Call("body or html_body is required".into()));
    }
    let Some(reply_to) = text(args, "reply_to_message_id") else {
        return Ok((mail, None));
    };
    let original = message(run, reply_to, "full").await?;
    let reply_all = flag(args, "reply_all", false);
    let mine: Vec<String> = if reply_all {
        send_as(run).await?.iter().filter_map(|s| s["sendAsEmail"].as_str().map(str::to_lowercase)).collect()
    } else {
        Vec::new()
    };
    let sender = header(&original, "Reply-To").or_else(|| header(&original, "From"));
    // Replying to what one sent oneself goes to its recipients, as Gmail does.
    let own = sender.as_deref().is_some_and(|s| mine.contains(&address(s)))
        || original["labelIds"].as_array().is_some_and(|l| l.iter().any(|l| l == "SENT"));
    let first = if own { header(&original, "To") } else { sender };
    let mut to = vec![first, mail.to.take()];
    let mut cc = vec![mail.cc.take()];
    if reply_all {
        to.push(header(&original, "To"));
        cc.push(header(&original, "Cc"));
    }
    mail.to = join_addresses(&to, &mine);
    let taken: Vec<String> =
        mine.iter().cloned().chain(mail.to.iter().flat_map(|t| split_addresses(t)).map(|e| address(&e))).collect();
    mail.cc = join_addresses(&cc, &taken);
    let subject = header(&original, "Subject").unwrap_or_default();
    if mail.subject.is_none() {
        let re = subject.get(..3).is_some_and(|s| s.eq_ignore_ascii_case("re:"));
        mail.subject = Some(if re { subject.clone() } else { format!("Re: {subject}") });
    }
    let id = header(&original, "Message-ID").or_else(|| header(&original, "Message-Id"));
    mail.in_reply_to = id.clone();
    mail.references = match (header(&original, "References"), id) {
        (Some(refs), Some(id)) => Some(format!("{refs} {id}")),
        (None, id) => id,
        (refs, None) => refs,
    };
    if flag(args, "include_quote", true) {
        quote(&mut mail, &original);
    }
    Ok((mail, original["threadId"].as_str().map(str::to_string)))
}

/// The original below the reply, as Gmail quotes it.
fn quote(mail: &mut Mail, original: &Value) {
    let said =
        format!("On {}, {} wrote:", header(original, "Date").unwrap_or_default(), header(original, "From").unwrap_or_default());
    let orig_text = part_text(&original["payload"], "text/plain")
        .or_else(|| part_text(&original["payload"], "text/html").map(|h| super::strip_html(&h)))
        .unwrap_or_default();
    let quoted: String = orig_text.lines().map(|l| format!("> {l}\n")).collect();
    let text = mail.text.clone().or_else(|| mail.html.as_deref().map(super::strip_html)).unwrap_or_default();
    mail.text = Some(format!("{text}\n\n{said}\n{quoted}"));
    if let Some(html) = &mail.html {
        let orig_html = part_text(&original["payload"], "text/html")
            .unwrap_or_else(|| format!("<div style=\"white-space:pre-wrap\">{}</div>", escape_html(&orig_text)));
        mail.html = Some(format!(
            "{html}<br><div class=\"gmail_quote\"><div>{}</div><blockquote class=\"gmail_quote\" style=\"margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex\">{orig_html}</blockquote></div>",
            escape_html(&said)
        ));
    }
}

/// A draft with the fields given changed, the rest as it was.
async fn redraft(run: &Run<'_>, id: &str, args: &Args) -> Result<(Mail, Option<String>), GwsError> {
    let p = params(json!({ "userId": "me", "id": id, "format": "full" }));
    let d = run.json(&["gmail", "users", "drafts", "get", "--params", &p]).await?;
    let m = &d["message"];
    let payload = &m["payload"];
    let new_body = args.contains_key("body") || args.contains_key("html_body");
    let attachments = if args.contains_key("attachments") {
        attachments_of(args.get("attachments"))?
    } else {
        let mut kept = Vec::new();
        for part in files(payload) {
            kept.push(Attachment {
                filename: part["filename"].as_str().unwrap_or_default().to_string(),
                mime_type: part["mimeType"].as_str().unwrap_or("application/octet-stream").to_string(),
                data: part_data(run, m["id"].as_str().unwrap_or_default(), part).await?,
            });
        }
        kept
    };
    let field = |key: &str, name: &str| if args.contains_key(key) { given(args, key) } else { header(m, name) };
    let mail = Mail {
        from: field("from", "From"),
        to: field("to", "To"),
        cc: field("cc", "Cc"),
        bcc: field("bcc", "Bcc"),
        subject: field("subject", "Subject"),
        text: if new_body { given(args, "body") } else { part_text(payload, "text/plain") },
        html: if new_body { given(args, "html_body") } else { part_text(payload, "text/html") },
        in_reply_to: header(m, "In-Reply-To"),
        references: header(m, "References"),
        attachments,
    };
    Ok((mail, m["threadId"].as_str().map(str::to_string)))
}

async fn forward(run: &Run<'_>, args: &Args) -> Result<Value, GwsError> {
    let id = need(args, "message_id")?;
    let original = message(run, id, "full").await?;
    let payload = &original["payload"];
    let names = strings(args, "attachments");
    let attachments = files_of(run, id, payload, &names).await?;
    let block = [
        "---------- Forwarded message ---------".to_string(),
        format!("From: {}", header(&original, "From").unwrap_or_default()),
        format!("Date: {}", header(&original, "Date").unwrap_or_default()),
        format!("Subject: {}", header(&original, "Subject").unwrap_or_default()),
        format!("To: {}", header(&original, "To").unwrap_or_default()),
    ];
    let orig_text = part_text(payload, "text/plain")
        .or_else(|| part_text(payload, "text/html").map(|h| super::strip_html(&h)))
        .unwrap_or_default();
    let comment =
        given(args, "comment").or_else(|| given(args, "html_comment").map(|h| super::strip_html(&h))).unwrap_or_default();
    let text = format!("{comment}\n\n{}\n\n{orig_text}", block.join("\n"));
    let orig_html = part_text(payload, "text/html");
    let html = if orig_html.is_some() || given(args, "html_comment").is_some() {
        let note = given(args, "html_comment").unwrap_or_else(|| escape_html(&comment).replace('\n', "<br>"));
        let body = orig_html.unwrap_or_else(|| format!("<div style=\"white-space:pre-wrap\">{}</div>", escape_html(&orig_text)));
        Some(format!(
            "{note}<br><br><div class=\"gmail_quote\">{}<br><br>{body}</div>",
            block.iter().map(|l| escape_html(l)).collect::<Vec<_>>().join("<br>")
        ))
    } else {
        None
    };
    let subject = header(&original, "Subject").unwrap_or_default();
    let fwd = subject.get(..4).is_some_and(|s| s.eq_ignore_ascii_case("fwd:"));
    let mail = Mail {
        from: given(args, "from"),
        to: Some(need(args, "to")?.to_string()),
        cc: given(args, "cc"),
        bcc: given(args, "bcc"),
        subject: Some(if fwd { subject } else { format!("Fwd: {subject}") }),
        text: Some(text),
        html,
        attachments,
        ..Mail::default()
    };
    send(run, &mail, None).await
}

/// The email's bytes in the call's folder, for `gws` to upload.
fn put(run: &Run<'_>, mail: &Mail) -> Result<String, GwsError> {
    let name = format!("mail-{}.eml", uuid::Uuid::new_v4().simple());
    std::fs::write(run.file(&name), mail.render()).map_err(|e| GwsError::Setup(e.to_string()))?;
    Ok(name)
}

async fn send(run: &Run<'_>, mail: &Mail, thread: Option<&str>) -> Result<Value, GwsError> {
    let file = put(run, mail)?;
    let meta = match thread {
        Some(thread) => json!({ "threadId": thread }),
        None => json!({}),
    };
    let sent = run
        .json(&[
            "gmail",
            "users",
            "messages",
            "send",
            "--params",
            r#"{"userId":"me"}"#,
            "--json",
            &meta.to_string(),
            "--upload",
            &file,
            "--upload-content-type",
            "message/rfc822",
        ])
        .await?;
    Ok(
        json!({ "sent": true, "id": sent["id"], "threadId": sent["threadId"], "to": mail.to, "cc": mail.cc, "subject": mail.subject }),
    )
}

async fn draft(run: &Run<'_>, id: Option<&str>, mail: &Mail, thread: Option<&str>) -> Result<Value, GwsError> {
    let file = put(run, mail)?;
    let mut meta = json!({ "message": {} });
    if let Some(thread) = thread {
        meta["message"]["threadId"] = json!(thread);
    }
    let p = match id {
        Some(id) => params(json!({ "userId": "me", "id": id })),
        None => r#"{"userId":"me"}"#.to_string(),
    };
    let method = if id.is_some() { "update" } else { "create" };
    let made = run
        .json(&[
            "gmail",
            "users",
            "drafts",
            method,
            "--params",
            &p,
            "--json",
            &meta.to_string(),
            "--upload",
            &file,
            "--upload-content-type",
            "message/rfc822",
        ])
        .await?;
    Ok(json!({
        "draft_id": made["id"], "message_id": made["message"]["id"], "thread_id": made["message"]["threadId"],
        "to": mail.to, "cc": mail.cc, "subject": mail.subject, "attachments": mail.attachments.iter().map(|a| &a.filename).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fake, runs, scratch};
    use super::super::{call, App, URL_SAFE};
    use super::*;
    use base64::Engine as _;

    #[test]
    fn a_message_reads_as_text_with_its_headers_and_files() {
        let data = URL_SAFE.encode("Hello Ada,\nsee you.");
        let html = URL_SAFE.encode("<p>Hi&nbsp;there</p><br>Bye &amp; thanks");
        let m = json!({ "id": "m1", "labelIds": ["INBOX"], "payload": {
            "headers": [{ "name": "From", "value": "b@x.dev" }, { "name": "subject", "value": "Hi" }],
            "mimeType": "multipart/mixed", "parts": [
                { "mimeType": "multipart/alternative", "parts": [{ "mimeType": "text/plain", "body": { "data": data } }] },
                { "mimeType": "application/pdf", "filename": "a.pdf", "body": { "size": 10, "attachmentId": "x" } } ] } });
        let read = readable(&m, 1000, false);
        assert_eq!(
            (read["text"].as_str(), read["from"].as_str(), read["subject"].as_str()),
            (Some("Hello Ada,\nsee you."), Some("b@x.dev"), Some("Hi"))
        );
        assert_eq!(read["attachments"][0]["name"], "a.pdf");
        let only_html = json!({ "payload": { "headers": [], "mimeType": "text/html", "body": { "data": html } } });
        assert_eq!(readable(&only_html, 1000, false)["text"], "Hi there\nBye & thanks");
        assert!(the_part(&m["payload"], "b.pdf").unwrap_err() == GwsError::Call("No attachment b.pdf; it has a.pdf".into()));
    }

    #[test]
    fn addresses_join_once_without_ones_own() {
        assert_eq!(split_addresses(r#""Doe, Jane" <j@x.dev>, b@x.dev"#), [r#""Doe, Jane" <j@x.dev>"#, "b@x.dev"]);
        let joined =
            join_addresses(&[Some("Ada <ADA@x.dev>, me@x.dev".into()), Some("ada@x.dev, c@x.dev".into())], &["me@x.dev".into()]);
        assert_eq!(joined.as_deref(), Some("Ada <ADA@x.dev>, c@x.dev"));
    }

    #[tokio::test]
    async fn many_messages_change_in_one_call_and_threads_one_each() {
        let dir = scratch();
        let gws = fake(&dir, "{}", 0);
        let ids: Vec<String> = (0..1500).map(|i| format!("m{i}")).collect();
        let answer = call(&gws, App::Gmail, "trash_emails", &json!({ "message_ids": ids }), "t").await.unwrap();
        let answer: Value = serde_json::from_str(answer["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(answer["done"], 1500);
        let calls = runs(&dir);
        assert_eq!(calls.len(), 2, "a thousand a call");
        assert_eq!(calls[0][..4], ["gmail", "users", "messages", "batchModify"]);
        let body: Value = serde_json::from_str(&calls[1][7]).unwrap();
        assert_eq!((body["ids"].as_array().unwrap().len(), &body["addLabelIds"]), (500, &json!(["TRASH"])));

        std::fs::remove_file(dir.join("args")).unwrap();
        call(&gws, App::Gmail, "restore_emails", &json!({ "thread_ids": ["t1", "t2"], "from": "trash" }), "t").await.unwrap();
        let calls = runs(&dir);
        assert_eq!(calls.iter().filter(|c| c[3] == "untrash").count(), 2);
        assert!(call(&gws, App::Gmail, "spam_emails", &json!({}), "t").await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_email_is_built_here_and_uploaded_whole() {
        let dir = scratch();
        let gws = fake(&dir, r#"{"id":"m9","threadId":"t9"}"#, 0);
        let answer = call(
            &gws,
            App::Gmail,
            "send_email",
            &json!({ "to": "a@x.dev", "subject": "Hola", "body": "Hi", "attachments": [{ "filename": "a.txt", "content": "aGk=" }] }),
            "t",
        )
        .await
        .unwrap();
        assert!(answer["content"][0]["text"].as_str().unwrap().contains("\"sent\":true"));
        let run = &runs(&dir)[0];
        assert_eq!(run[..4], ["gmail", "users", "messages", "send"]);
        assert!(run.iter().any(|a| a == "message/rfc822"));
        let none = call(&gws, App::Gmail, "send_email", &json!({ "body": "Hi" }), "t").await;
        assert_eq!(none, Err(GwsError::Call("to is required".into())));
        let _ = std::fs::remove_dir_all(dir);
    }
}
