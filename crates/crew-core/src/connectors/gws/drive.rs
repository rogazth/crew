//! Drive's tools. What trashes, restores or moves works on many files at
//! once; files of any kind come and go as base64, which Crew reads from and
//! writes to the session's folder.

use serde_json::{json, Value};

use super::super::local_files::guess_mime;
use super::{
    clip_to, decode64, each, file_answer, flag, ids, need, number, object, outcome, params, quoted, text, tool, Args, GwsError,
    Run, Tool, MAX_FILE, MAX_TEXT,
};

const FIELDS: &str = "id,name,mimeType,modifiedTime,size,webViewLink,parents,trashed,starred,owners(emailAddress)";

fn file_ids() -> Value {
    json!({
        "file_ids": { "type": "array", "items": { "type": "string" }, "maxItems": 500 },
        "file_id": { "type": "string", "description": "One file, instead of file_ids." }
    })
}

pub(super) const TOOLS: &[Tool] = &[
    tool(
        "search_files",
        "Search files",
        "Search Drive with its query syntax (name contains 'x', fullText contains 'y', mimeType = '…', modifiedTime > '2026-01-01', 'FOLDER_ID' in parents). Answers each file's id, name, type, link and when it changed; ids_only answers ids alone, up to 1000 a page.",
        true,
        false,
        || {
            object(
                json!({
                    "query": { "type": "string", "description": "A Drive query; empty lists the latest files." },
                    "max_results": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 25, "description": "Up to 100 without ids_only." },
                    "page_token": { "type": "string" },
                    "order_by": { "type": "string", "description": "Like modifiedTime desc, name." },
                    "include_trashed": { "type": "boolean", "default": false },
                    "ids_only": { "type": "boolean", "default": false }
                }),
                &[],
            )
        },
    ),
    tool("list_folder", "List folder", "List what a folder holds; without a folder, My Drive's top.", true, false, || {
        object(
            json!({
                "folder_id": { "type": "string", "default": "root" },
                "max_results": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50 },
                "page_token": { "type": "string" }
            }),
            &[],
        )
    }),
    tool("list_shared_drives", "List shared drives", "List the shared drives the account can see.", true, false, || {
        object(json!({ "max_results": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50 }, "page_token": { "type": "string" } }), &[])
    }),
    tool(
        "read_file",
        "Read file",
        "Read a file's text: a Google Doc as Markdown, a Sheet as CSV, a Slides deck as text, or a text file as it is. Other files: download_file.",
        true,
        false,
        || {
            object(
                json!({ "file_id": { "type": "string" }, "max_chars": { "type": "integer", "minimum": 100, "default": 200000 } }),
                &["file_id"],
            )
        },
    ),
    tool(
        "download_file",
        "Download file",
        "Save a file as a file in your working folder, to open it with your own tools. A Google Doc, Sheet or Slides deck is exported in the format given.",
        true,
        false,
        || {
            object(
                json!({
                    "file_id": { "type": "string" },
                    "save_to": { "type": "string", "description": "A path in your working folder; an existing file is not replaced." },
                    "format": { "type": "string", "enum": ["pdf", "docx", "xlsx", "pptx", "odt", "ods", "csv", "tsv", "md", "txt", "html", "png", "jpeg", "svg"], "description": "For Google's own files: pdf by default." }
                }),
                &["file_id", "save_to"],
            )
        },
    ),
    tool(
        "upload_file",
        "Upload file",
        "Make a file in Drive, or give an existing one (file_id) new content. From text, from a file in your working folder (path), or from base64.",
        false,
        false,
        || {
            object(
                json!({
                    "name": { "type": "string", "description": "Required for a new file; renames an existing one." },
                    "content": { "type": "string", "description": "The file's text." },
                    "path": { "type": "string", "description": "A file in your working folder; Crew reads it." },
                    "content_base64": { "type": "string", "description": "The file's bytes as base64." },
                    "mime_type": { "type": "string", "description": "Its type; guessed from the name when not given." },
                    "folder_id": { "type": "string", "description": "Where a new file goes; My Drive by default." },
                    "file_id": { "type": "string", "description": "A file to replace the content of." },
                    "convert_to": { "type": "string", "enum": ["document", "spreadsheet", "presentation"], "description": "Make it a Google Doc, Sheet or Slides deck." }
                }),
                &[],
            )
        },
    ),
    tool("create_folder", "Create folder", "Make a folder.", false, false, || {
        object(json!({ "name": { "type": "string" }, "parent_id": { "type": "string" } }), &["name"])
    }),
    tool("update_file", "Update file", "Rename a file, change its description, or star it.", false, false, || {
        object(
            json!({
                "file_id": { "type": "string" },
                "name": { "type": "string" },
                "description": { "type": "string" },
                "starred": { "type": "boolean" }
            }),
            &["file_id"],
        )
    }),
    tool("copy_file", "Copy file", "Copy a file, with a new name or into a folder.", false, false, || {
        object(json!({ "file_id": { "type": "string" }, "name": { "type": "string" }, "folder_id": { "type": "string" } }), &["file_id"])
    }),
    tool("move_files", "Move files", "Move many files or folders into a folder.", false, false, || {
        let mut props = file_ids();
        props["folder_id"] = json!({ "type": "string", "description": "Where they go; root is My Drive." });
        object(props, &["folder_id"])
    }),
    tool("trash_files", "Trash files", "Move many files or folders to the trash. restore_files brings them back.", false, true, || {
        object(file_ids(), &[])
    }),
    tool("restore_files", "Restore files", "Bring many files or folders back from the trash.", false, false, || object(file_ids(), &[])),
    tool(
        "share_file",
        "Share file",
        "Share a file with a person, a group, a domain or anyone with the link, as reader, commenter or writer.",
        false,
        true,
        || {
            object(
                json!({
                    "file_id": { "type": "string" },
                    "role": { "type": "string", "enum": ["reader", "commenter", "writer"] },
                    "type": { "type": "string", "enum": ["user", "group", "domain", "anyone"], "default": "user" },
                    "email": { "type": "string", "description": "For a user or a group." },
                    "domain": { "type": "string", "description": "For a domain." },
                    "notify": { "type": "boolean", "default": true, "description": "Email them about it." },
                    "message": { "type": "string", "description": "A note in that email." }
                }),
                &["file_id", "role"],
            )
        },
    ),
    tool("list_permissions", "List permissions", "List who a file is shared with, and how.", true, false, || {
        object(json!({ "file_id": { "type": "string" } }), &["file_id"])
    }),
    tool("remove_permission", "Remove permission", "Stop sharing a file with someone: by permission_id of list_permissions, or by email.", false, true, || {
        object(
            json!({ "file_id": { "type": "string" }, "permission_id": { "type": "string" }, "email": { "type": "string" } }),
            &["file_id"],
        )
    }),
];

pub(super) async fn run(run: &Run<'_>, name: &str, args: &Args) -> Result<Value, GwsError> {
    match name {
        "search_files" | "list_folder" => {
            let ids_only = flag(args, "ids_only", false);
            let trashed = if flag(args, "include_trashed", false) { String::new() } else { "trashed = false".into() };
            let q = match name {
                "search_files" => match text(args, "query") {
                    Some(q) if trashed.is_empty() => q.to_string(),
                    Some(q) => format!("({q}) and {trashed}"),
                    None => trashed,
                },
                _ => format!("'{}' in parents and trashed = false", quoted(text(args, "folder_id").unwrap_or("root"))),
            };
            let max = if name == "list_folder" {
                number(args, "max_results", 50, 100)
            } else {
                number(args, "max_results", 25, if ids_only { 1000 } else { 100 })
            };
            let fields = if ids_only { "nextPageToken,files(id)".to_string() } else { format!("nextPageToken,files({FIELDS})") };
            let p = params(json!({
                "q": if q.is_empty() { Value::Null } else { json!(q) },
                "pageSize": max,
                "pageToken": text(args, "page_token"),
                "orderBy": text(args, "order_by"),
                "fields": fields,
                "supportsAllDrives": true,
                "includeItemsFromAllDrives": true,
            }));
            let list = run.json(&["drive", "files", "list", "--params", &p]).await?;
            if ids_only {
                let ids: Vec<Value> = list["files"].as_array().into_iter().flatten().map(|f| f["id"].clone()).collect();
                return Ok(json!({ "ids": ids, "nextPageToken": list["nextPageToken"] }));
            }
            Ok(list)
        }
        "list_shared_drives" => {
            let p = params(json!({ "pageSize": number(args, "max_results", 50, 100), "pageToken": text(args, "page_token") }));
            run.json(&["drive", "drives", "list", "--params", &p]).await
        }
        "read_file" => {
            read_file(run, need(args, "file_id")?, number(args, "max_chars", MAX_TEXT as u64, 5_000_000) as usize).await
        }
        "download_file" => {
            let id = need(args, "file_id")?;
            let meta = metadata(run, id).await?;
            let mime = meta["mimeType"].as_str().unwrap_or_default();
            let (bytes, as_mime) = if mime.starts_with("application/vnd.google-apps.") {
                if mime == "application/vnd.google-apps.folder" {
                    return Err(GwsError::Call("A folder can't be downloaded; list_folder lists it".into()));
                }
                let format = text(args, "format").unwrap_or("pdf");
                let as_mime = export_mime(format).ok_or_else(|| GwsError::Call(format!("Can't export as {format}")))?;
                let p = params(json!({ "fileId": id, "mimeType": as_mime }));
                run.raw(&["drive", "files", "export", "--params", &p, "--output", "content"]).await?;
                (read_output(run)?, as_mime.to_string())
            } else {
                if meta["size"].as_str().and_then(|s| s.parse::<usize>().ok()).is_some_and(|s| s > MAX_FILE) {
                    return Err(GwsError::Call(format!("The file is over {} MB; open its link instead", MAX_FILE >> 20)));
                }
                let p = params(json!({ "fileId": id, "alt": "media", "supportsAllDrives": true }));
                run.raw(&["drive", "files", "get", "--params", &p, "--output", "content"]).await?;
                (read_output(run)?, mime.to_string())
            };
            Ok(file_answer(meta["name"].as_str().unwrap_or("file"), &as_mime, &bytes, need(args, "save_to")?))
        }
        "upload_file" => upload(run, args).await,
        "create_folder" => {
            let mut meta = json!({ "name": need(args, "name")?, "mimeType": "application/vnd.google-apps.folder" });
            if let Some(parent) = text(args, "parent_id") {
                meta["parents"] = json!([parent]);
            }
            let p = params(json!({ "fields": "id,name,webViewLink", "supportsAllDrives": true }));
            run.json(&["drive", "files", "create", "--params", &p, "--json", &meta.to_string()]).await
        }
        "update_file" => {
            let mut meta = serde_json::Map::new();
            for key in ["name", "description"] {
                if let Some(v) = args.get(key).and_then(Value::as_str) {
                    meta.insert(key.into(), json!(v));
                }
            }
            if let Some(starred) = args.get("starred").and_then(Value::as_bool) {
                meta.insert("starred".into(), json!(starred));
            }
            if meta.is_empty() {
                return Err(GwsError::Call("Give name, description or starred".into()));
            }
            let p = params(json!({ "fileId": need(args, "file_id")?, "fields": FIELDS, "supportsAllDrives": true }));
            run.json(&["drive", "files", "update", "--params", &p, "--json", &Value::Object(meta).to_string()]).await
        }
        "copy_file" => {
            let mut meta = json!({});
            if let Some(name) = text(args, "name") {
                meta["name"] = json!(name);
            }
            if let Some(folder) = text(args, "folder_id") {
                meta["parents"] = json!([folder]);
            }
            let p = params(
                json!({ "fileId": need(args, "file_id")?, "fields": "id,name,mimeType,webViewLink,parents", "supportsAllDrives": true }),
            );
            run.json(&["drive", "files", "copy", "--params", &p, "--json", &meta.to_string()]).await
        }
        "move_files" => {
            let folder = need(args, "folder_id")?;
            let results = each(many(args)?, |id| async move {
                let done = async {
                    let p = params(json!({ "fileId": id, "fields": "parents", "supportsAllDrives": true }));
                    let now = run.json(&["drive", "files", "get", "--params", &p]).await?;
                    let old: Vec<&str> = now["parents"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                    let p = params(json!({
                        "fileId": id, "addParents": folder, "removeParents": old.join(","), "fields": "id,parents", "supportsAllDrives": true,
                    }));
                    run.json(&["drive", "files", "update", "--params", &p, "--json", "{}"]).await.map(drop)
                }
                .await;
                (id, done)
            })
            .await;
            outcome(results)
        }
        "trash_files" | "restore_files" => {
            let body = json!({ "trashed": name == "trash_files" }).to_string();
            let body = &body;
            let results = each(many(args)?, |id| async move {
                let p = params(json!({ "fileId": id, "fields": "id", "supportsAllDrives": true }));
                let done = run.json(&["drive", "files", "update", "--params", &p, "--json", body]).await.map(drop);
                (id, done)
            })
            .await;
            outcome(results)
        }
        "share_file" => {
            let role = need(args, "role")?;
            if !["reader", "commenter", "writer"].contains(&role) {
                return Err(GwsError::Call("role is reader, commenter or writer".into()));
            }
            let kind = text(args, "type").unwrap_or("user");
            let mut body = json!({ "type": kind, "role": role });
            match kind {
                "user" | "group" => body["emailAddress"] = json!(need(args, "email")?),
                "domain" => body["domain"] = json!(need(args, "domain")?),
                "anyone" => {}
                _ => return Err(GwsError::Call("type is user, group, domain or anyone".into())),
            }
            let notify = matches!(kind, "user" | "group") && flag(args, "notify", true);
            let p = params(json!({
                "fileId": need(args, "file_id")?, "sendNotificationEmail": notify, "emailMessage": if notify { text(args, "message") } else { None },
                "supportsAllDrives": true,
            }));
            run.json(&["drive", "permissions", "create", "--params", &p, "--json", &body.to_string()]).await
        }
        "list_permissions" => permissions(run, need(args, "file_id")?).await.map(Value::Array),
        "remove_permission" => {
            let file = need(args, "file_id")?;
            let permission = match (text(args, "permission_id"), text(args, "email")) {
                (Some(id), _) => id.to_string(),
                (None, Some(email)) => permissions(run, file)
                    .await?
                    .iter()
                    .find(|p| p["emailAddress"].as_str().is_some_and(|e| e.eq_ignore_ascii_case(email)))
                    .and_then(|p| p["id"].as_str().map(str::to_string))
                    .ok_or_else(|| GwsError::Call(format!("The file isn't shared with {email}")))?,
                (None, None) => return Err(GwsError::Call("Give permission_id or email".into())),
            };
            let p = params(json!({ "fileId": file, "permissionId": permission, "supportsAllDrives": true }));
            run.json(&["drive", "permissions", "delete", "--params", &p]).await?;
            Ok(json!({ "removed": permission }))
        }
        other => Err(GwsError::Call(format!("{other} is not a tool"))),
    }
}

fn many(args: &Args) -> Result<Vec<String>, GwsError> {
    let ids = ids(args, "file_ids", "file_id");
    if ids.is_empty() {
        return Err(GwsError::Call("Give file_ids".into()));
    }
    Ok(ids)
}

async fn metadata(run: &Run<'_>, id: &str) -> Result<Value, GwsError> {
    let p = params(json!({ "fileId": id, "fields": "id,name,mimeType,size,webViewLink", "supportsAllDrives": true }));
    run.json(&["drive", "files", "get", "--params", &p]).await
}

async fn permissions(run: &Run<'_>, file: &str) -> Result<Vec<Value>, GwsError> {
    let p = params(
        json!({ "fileId": file, "fields": "permissions(id,type,role,emailAddress,domain,displayName)", "supportsAllDrives": true }),
    );
    let list = run.json(&["drive", "permissions", "list", "--params", &p]).await?;
    Ok(list["permissions"].as_array().cloned().unwrap_or_default())
}

fn read_output(run: &Run<'_>) -> Result<Vec<u8>, GwsError> {
    let bytes = std::fs::read(run.file("content")).map_err(|e| GwsError::Call(format!("The file didn't download: {e}")))?;
    if bytes.len() > MAX_FILE {
        return Err(GwsError::Call(format!("The file is over {} MB; open its link instead", MAX_FILE >> 20)));
    }
    Ok(bytes)
}

fn export_mime(format: &str) -> Option<&'static str> {
    Some(match format {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "md" => "text/markdown",
        "txt" => "text/plain",
        "html" => "text/html",
        "png" => "image/png",
        "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

async fn upload(run: &Run<'_>, args: &Args) -> Result<Value, GwsError> {
    let bytes = match (args.get("content").and_then(Value::as_str), text(args, "content_base64")) {
        (Some(content), None) => content.as_bytes().to_vec(),
        (None, Some(data)) => decode64(data).ok_or_else(|| GwsError::Call("content_base64 is not base64".into()))?,
        (Some(_), Some(_)) => return Err(GwsError::Call("Give content or content_base64, not both".into())),
        (None, None) if args.contains_key("path") => {
            return Err(GwsError::Call("path is read only in a session's folder; give content_base64".into()))
        }
        (None, None) => return Err(GwsError::Call("Give content, path or content_base64".into())),
    };
    if bytes.len() > MAX_FILE {
        return Err(GwsError::Call(format!("The file is over {} MB", MAX_FILE >> 20)));
    }
    std::fs::write(run.file("upload"), &bytes).map_err(|e| GwsError::Setup(e.to_string()))?;
    let name = text(args, "name");
    let mime = text(args, "mime_type").unwrap_or_else(|| guess_mime(name.unwrap_or_default()));
    let mime = if mime == "application/octet-stream" && text(args, "convert_to").is_some() { "text/plain" } else { mime };
    let mut meta = json!({});
    if let Some(name) = name {
        meta["name"] = json!(name);
    }
    if let Some(kind) = text(args, "convert_to") {
        meta["mimeType"] = json!(format!("application/vnd.google-apps.{kind}"));
    }
    let p = params(
        json!({ "fileId": text(args, "file_id"), "fields": "id,name,mimeType,size,webViewLink", "supportsAllDrives": true }),
    );
    let method = match text(args, "file_id") {
        Some(_) => "update",
        None => {
            need(args, "name")?;
            if let Some(folder) = text(args, "folder_id") {
                meta["parents"] = json!([folder]);
            }
            "create"
        }
    };
    run.json(&[
        "drive",
        "files",
        method,
        "--params",
        &p,
        "--json",
        &meta.to_string(),
        "--upload",
        "upload",
        "--upload-content-type",
        mime,
    ])
    .await
}

/// A file's text: Google's own formats exported, anything else read when it is text.
async fn read_file(run: &Run<'_>, id: &str, max: usize) -> Result<Value, GwsError> {
    let meta = metadata(run, id).await?;
    let mime = meta["mimeType"].as_str().unwrap_or_default();
    let export = match mime {
        "application/vnd.google-apps.document" => Some("text/markdown"),
        "application/vnd.google-apps.spreadsheet" => Some("text/csv"),
        "application/vnd.google-apps.presentation" => Some("text/plain"),
        _ => None,
    };
    let textual = mime.starts_with("text/") || ["application/json", "application/xml", "application/javascript"].contains(&mime);
    if export.is_none() && !textual {
        return Ok(
            json!({ "file": meta, "text": null, "note": "This file isn't text; download_file saves it to open it with your own tools." }),
        );
    }
    let p = match export {
        Some(as_mime) => params(json!({ "fileId": id, "mimeType": as_mime })),
        None => params(json!({ "fileId": id, "alt": "media", "supportsAllDrives": true })),
    };
    let method = if export.is_some() { "export" } else { "get" };
    run.raw(&["drive", "files", method, "--params", &p, "--output", "content"]).await?;
    let bytes = std::fs::read(run.file("content")).map_err(|e| GwsError::Call(format!("The file didn't download: {e}")))?;
    Ok(json!({ "file": meta, "text": clip_to(&String::from_utf8_lossy(&bytes), max) }))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fake, runs, scratch};
    use super::super::{call, App};
    use super::*;

    #[tokio::test]
    async fn many_files_move_each_out_of_where_they_were() {
        let dir = scratch();
        let gws = fake(&dir, r#"{"parents":["old"]}"#, 0);
        let answer =
            call(&gws, App::Drive, "move_files", &json!({ "file_ids": ["a", "b"], "folder_id": "new" }), "t").await.unwrap();
        assert!(answer["content"][0]["text"].as_str().unwrap().contains("\"done\":2"));
        let updates: Vec<Value> =
            runs(&dir).iter().filter(|r| r[2] == "update").map(|r| serde_json::from_str(&r[4]).unwrap()).collect();
        assert_eq!(updates.len(), 2);
        assert_eq!((&updates[0]["addParents"], &updates[0]["removeParents"]), (&json!("new"), &json!("old")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_upload_takes_bytes_and_a_path_left_unread_is_refused() {
        let dir = scratch();
        let gws = fake(&dir, r#"{"id":"f1"}"#, 0);
        call(
            &gws,
            App::Drive,
            "upload_file",
            &json!({ "name": "a.pdf", "content_base64": "JVBERg==", "convert_to": "document" }),
            "t",
        )
        .await
        .unwrap();
        let run = &runs(&dir)[0];
        let meta: Value = serde_json::from_str(&run[6]).unwrap();
        assert_eq!(meta, json!({ "name": "a.pdf", "mimeType": "application/vnd.google-apps.document" }));
        assert_eq!(run.last().map(String::as_str), Some("application/pdf"));
        let refused = call(&gws, App::Drive, "upload_file", &json!({ "name": "a", "path": "a.txt" }), "t").await;
        assert!(matches!(refused, Err(GwsError::Call(m)) if m.contains("path")));
        let _ = std::fs::remove_dir_all(dir);
    }
}
