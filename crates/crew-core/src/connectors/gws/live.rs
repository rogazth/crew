//! Every Google tool against a real account, as `crewd` calls them: paths
//! read and files saved in a folder like a session's. Ignored unless asked:
//!
//! `CREW_GWS_LIVE_TOKEN=<access token> CREW_GWS=$(which gws) cargo test -p crew-core --lib gws::live -- --ignored --nocapture`
//!
//! It mails only the account itself, names what it makes `crew-test-…`, and
//! leaves all of it in the trash.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::super::local_files::{read_paths, write_saved};
use super::{call, App, Gws, GwsError};

struct Live {
    gws: Gws,
    token: String,
    folder: PathBuf,
}

impl Live {
    /// A call as `crewd` makes it for a session working in `folder`.
    async fn try_call(&self, app: App, name: &str, mut args: Value) -> Result<Value, String> {
        read_paths(&mut args, &self.folder)?;
        let mut answer = match call(&self.gws, app, name, &args, &self.token).await {
            Ok(answer) => answer,
            Err(GwsError::Forbidden(line) | GwsError::Call(line) | GwsError::Setup(line)) => return Err(line),
            Err(GwsError::Unauthorized) => return Err("unauthorized".into()),
        };
        write_saved(&mut answer, &self.folder);
        let text = answer["content"][0]["text"].as_str().unwrap_or_default().to_string();
        if answer["isError"] == true {
            return Err(text);
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    async fn call(&self, app: App, name: &str, args: Value) -> Value {
        let shown = super::clip_to(&args.to_string(), 160);
        match self.try_call(app, name, args).await {
            Ok(v) => {
                println!("ok   {name} {shown}\n     -> {}", super::clip_to(&v.to_string(), 300));
                v
            }
            Err(e) => panic!("{name} {shown} failed: {e}"),
        }
    }

    /// Gmail's search lags a send by a few seconds.
    async fn find(&self, query: &str, at_least: usize) -> Vec<String> {
        for _ in 0..30 {
            let found = self
                .call(App::Gmail, "search_emails", json!({ "query": query, "ids_only": true, "include_spam_trash": true }))
                .await;
            let ids: Vec<String> =
                found["messages"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(str::to_string)).collect();
            if ids.len() >= at_least {
                return ids;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        panic!("{query}: Gmail never listed {at_least}");
    }
}

fn labels_of(m: &Value) -> Vec<String> {
    m["labels"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(str::to_string)).collect()
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

#[tokio::test]
#[ignore = "calls Google with a real account"]
async fn every_tool_works_against_google() {
    let token = std::env::var("CREW_GWS_LIVE_TOKEN").expect("CREW_GWS_LIVE_TOKEN");
    let bin = std::env::var("CREW_GWS").unwrap_or_else(|_| "/opt/homebrew/bin/gws".into());
    let folder = std::env::temp_dir().join(format!("crew-live-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(folder.join("in")).unwrap();
    let live = Live { gws: Gws::at(PathBuf::from(bin)), token, folder: folder.clone() };
    let tag = format!("crew-test-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    println!("tag {tag}, folder {}", folder.display());

    let pdf: Vec<u8> = b"%PDF-1.4\n%crew\n".iter().copied().chain((0..=255u8).cycle().take(300_000)).collect();
    std::fs::write(folder.join("in/factura ñ.pdf"), &pdf).unwrap();
    std::fs::write(folder.join("in/notes.md"), "# Notas\n\nHola desde Crew.\n").unwrap();

    // `CREW_GWS_LIVE_APPS=drive,sheets` runs those alone.
    let apps = std::env::var("CREW_GWS_LIVE_APPS").unwrap_or_else(|_| "gmail,drive,sheets,docs".into());
    let on = |app: &str| apps.split(',').any(|a| a.trim() == app);
    if on("gmail") {
        gmail(&live, &tag, &pdf).await;
    }
    if on("drive") {
        drive(&live, &tag, &pdf).await;
    }
    let mut made = Vec::new();
    if on("sheets") {
        made.push(sheets(&live, &tag).await);
    }
    if on("docs") {
        made.push(docs(&live, &tag).await);
    }
    if !made.is_empty() {
        let done = live.call(App::Drive, "trash_files", json!({ "file_ids": made })).await;
        assert_eq!(done["done"].as_u64(), Some(made.len() as u64));
    }
    let _ = std::fs::remove_dir_all(&folder);
}

async fn gmail(live: &Live, tag: &str, pdf: &[u8]) {
    let g = App::Gmail;
    let me = s(&live.call(g, "get_profile", json!({})).await["email"]);
    assert!(me.contains('@'));

    // Labels: made, restyled, found by name.
    let label = live.call(g, "save_label", json!({ "name": format!("{tag}/a") })).await;
    let label_id = s(&label["id"]);
    live.call(
        g,
        "save_label",
        json!({ "label_id": label_id, "name": format!("{tag}/b"), "background_color": "#16a766", "text_color": "#ffffff" }),
    )
    .await;
    let all = live.call(g, "list_labels", json!({})).await;
    assert!(all.as_array().unwrap().iter().any(|l| l["name"] == format!("{tag}/b")));

    // A mail with a file from the folder, to the account itself.
    let sent = live
        .call(
            g,
            "send_email",
            json!({ "to": me, "subject": format!("{tag} factura"), "body": "Adjunto la factura.", "html_body": "<p>Adjunto la <b>factura</b>.</p>",
                    "attachments": [{ "path": "in/factura ñ.pdf", "mime_type": "application/pdf" }, { "filename": "nota.txt", "content": "aG9sYQ==" }] }),
        )
        .await;
    let first = s(&sent["id"]);
    let thread = s(&sent["threadId"]);
    let read = live.call(g, "read_email", json!({ "message_id": first })).await;
    assert_eq!(read["subject"], format!("{tag} factura"));
    let names: Vec<String> = read["attachments"].as_array().unwrap().iter().map(|a| s(&a["name"])).collect();
    assert_eq!(names, ["factura ñ.pdf", "nota.txt"]);
    assert!(s(&read["text"]).contains("Adjunto la factura"));
    let html = live.call(g, "read_email", json!({ "message_id": first, "format": "html" })).await;
    assert!(s(&html["text"]).contains("<b>factura</b>"));

    let saved = live
        .call(g, "download_attachment", json!({ "message_id": first, "filename": "factura ñ.pdf", "save_to": "out/factura.pdf" }))
        .await;
    assert_eq!(std::fs::read(Path::new(&s(&saved["saved_to"]))).unwrap(), pdf, "the file came back as it went");
    let again = live
        .try_call(
            g,
            "download_attachment",
            json!({ "message_id": first, "filename": "factura ñ.pdf", "save_to": "out/factura.pdf" }),
        )
        .await;
    assert!(again.unwrap_err().contains("already exists"));

    // A reply in the thread, quoting it.
    let reply = live.call(g, "send_email", json!({ "reply_to_message_id": first, "body": "Recibida, gracias." })).await;
    assert_eq!(s(&reply["threadId"]), thread);
    assert_eq!(s(&reply["subject"]), format!("Re: {tag} factura"));
    let quoted = live.call(g, "read_email", json!({ "message_id": reply["id"] })).await;
    assert!(s(&quoted["text"]).contains("> Adjunto la factura"), "{quoted}");
    let unquoted = live
        .call(
            g,
            "create_draft",
            json!({ "reply_to_message_id": first, "reply_all": true, "include_quote": false, "body": "Sin cita" }),
        )
        .await;
    let d = live.call(g, "get_draft", json!({ "draft_id": unquoted["draft_id"] })).await;
    assert!(!s(&d["text"]).contains("> Adjunto"), "{d}");
    assert_eq!(s(&d["threadId"]), thread);
    live.call(g, "delete_draft", json!({ "draft_id": unquoted["draft_id"] })).await;

    // A draft with a file, changed in part, listed, sent.
    let draft = live
        .call(
            g,
            "create_draft",
            json!({ "to": me, "subject": format!("{tag} draft"), "body": "v1", "attachments": [{ "path": "in/notes.md" }] }),
        )
        .await;
    let draft_id = s(&draft["draft_id"]);
    live.call(g, "update_draft", json!({ "draft_id": draft_id, "subject": format!("{tag} draft v2") })).await;
    let d = live.call(g, "get_draft", json!({ "draft_id": draft_id })).await;
    assert_eq!((s(&d["subject"]), s(&d["text"]).trim().to_string()), (format!("{tag} draft v2"), "v1".to_string()));
    assert_eq!(d["attachments"][0]["name"], "notes.md", "the file stays when attachments isn't given");
    live.call(g, "update_draft", json!({ "draft_id": draft_id, "body": "v3", "attachments": [] })).await;
    let d = live.call(g, "get_draft", json!({ "draft_id": draft_id })).await;
    assert_eq!((s(&d["text"]).trim(), d["attachments"].as_array().unwrap().len()), ("v3", 0));
    let listed = live.call(g, "list_drafts", json!({ "query": format!("subject:{tag}") })).await;
    assert!(listed["drafts"].as_array().unwrap().iter().any(|x| s(&x["draft_id"]) == draft_id), "{listed}");
    live.call(g, "send_draft", json!({ "draft_id": draft_id })).await;

    // A forward with one of the original's files.
    let fwd = live
        .call(g, "forward", json!({ "message_id": first, "to": me, "comment": "Mira esto", "attachments": ["nota.txt"] }))
        .await;
    let f = live.call(g, "read_email", json!({ "message_id": fwd["id"] })).await;
    assert_eq!(s(&f["subject"]), format!("Fwd: {tag} factura"));
    assert!(s(&f["text"]).contains("Mira esto") && s(&f["text"]).contains("Forwarded message"));
    let names: Vec<String> = f["attachments"].as_array().unwrap().iter().map(|a| s(&a["name"])).collect();
    assert_eq!(names, ["nota.txt"]);
    let missing = live.try_call(g, "forward", json!({ "message_id": first, "to": me, "attachments": ["otro.pdf"] })).await;
    assert!(missing.unwrap_err().contains("No attachment otro.pdf"));

    // Many at once: labels by name, spam and back, trash and back.
    let ids = live.find(&format!("subject:{tag}"), 4).await;
    let full = live.call(g, "search_emails", json!({ "query": format!("subject:{tag}"), "max_results": 10 })).await;
    assert!(full["messages"][0]["subject"].as_str().is_some(), "{full}");
    let threads = live.call(g, "search_emails", json!({ "query": format!("subject:{tag}"), "by": "thread" })).await;
    assert!(threads["threads"][0]["messages"].as_u64().is_some(), "{threads}");
    let changed = live
        .call(g, "modify_labels", json!({ "message_ids": ids, "add": [format!("{tag}/b"), "STARRED"], "remove": ["UNREAD"] }))
        .await;
    assert_eq!(changed["done"], ids.len());
    let m = live.call(g, "read_email", json!({ "message_id": ids[0] })).await;
    assert!(
        labels_of(&m).contains(&label_id)
            && labels_of(&m).contains(&"STARRED".into())
            && !labels_of(&m).contains(&"UNREAD".into()),
        "{m}"
    );
    live.call(g, "modify_labels", json!({ "thread_id": thread, "remove": ["STARRED"] })).await;

    live.call(g, "spam_emails", json!({ "message_ids": ids })).await;
    assert!(labels_of(&live.call(g, "read_email", json!({ "message_id": ids[0] })).await).contains(&"SPAM".into()));
    live.call(g, "restore_emails", json!({ "message_ids": ids, "from": "spam" })).await;
    let m = live.call(g, "read_email", json!({ "message_id": ids[0] })).await;
    assert!(!labels_of(&m).contains(&"SPAM".into()) && labels_of(&m).contains(&"INBOX".into()));
    live.call(g, "trash_emails", json!({ "thread_ids": [thread] })).await;
    assert!(labels_of(&live.call(g, "read_email", json!({ "message_id": first })).await).contains(&"TRASH".into()));
    live.call(g, "restore_emails", json!({ "thread_ids": [thread], "from": "trash" })).await;
    assert!(!labels_of(&live.call(g, "read_email", json!({ "message_id": first })).await).contains(&"TRASH".into()));
    let bad = live.call(g, "trash_emails", json!({ "message_ids": ["nope"] })).await;
    assert_eq!(bad["done"], 0, "{bad}");

    // Filters: listed always; made and deleted when the account allowed it.
    live.call(g, "list_filters", json!({})).await;
    match live
        .try_call(g, "create_filter", json!({ "criteria": { "from": format!("{tag}@example.com") }, "action": { "addLabelIds": [label_id], "removeLabelIds": ["INBOX"] } }))
        .await
    {
        Ok(filter) => {
            println!("ok   create_filter -> {filter}");
            live.call(g, "delete_filter", json!({ "filter_id": filter["id"] })).await;
        }
        Err(e) => println!("FILTER create_filter refused (the token lacks gmail.settings.basic?): {e}"),
    }

    let ids = live.find(&format!("subject:{tag}"), 4).await;
    live.call(g, "trash_emails", json!({ "message_ids": ids })).await;
    live.call(g, "delete_label", json!({ "label_id": label_id })).await;
}

async fn drive(live: &Live, tag: &str, pdf: &[u8]) {
    let d = App::Drive;
    let folder = live.call(d, "create_folder", json!({ "name": tag })).await;
    let folder_id = s(&folder["id"]);
    let other = live.call(d, "create_folder", json!({ "name": format!("{tag}-b"), "parent_id": folder_id })).await;
    let text =
        live.call(d, "upload_file", json!({ "name": format!("{tag}.txt"), "content": "uno", "folder_id": folder_id })).await;
    let bin = live.call(d, "upload_file", json!({ "path": "in/factura ñ.pdf", "folder_id": folder_id })).await;
    assert_eq!((s(&bin["name"]), s(&bin["mimeType"])), ("factura ñ.pdf".to_string(), "application/pdf".to_string()));
    let doc = live
        .call(
            d,
            "upload_file",
            json!({ "path": "in/notes.md", "name": format!("{tag} notas"), "convert_to": "document", "folder_id": folder_id }),
        )
        .await;
    assert_eq!(doc["mimeType"], "application/vnd.google-apps.document");
    live.call(d, "upload_file", json!({ "file_id": text["id"], "content": "dos" })).await;
    assert_eq!(live.call(d, "read_file", json!({ "file_id": text["id"] })).await["text"], "dos");
    assert!(s(&live.call(d, "read_file", json!({ "file_id": doc["id"] })).await["text"]).contains("Hola desde Crew"));

    let saved = live.call(d, "download_file", json!({ "file_id": bin["id"], "save_to": "drive/factura.pdf" })).await;
    assert_eq!(std::fs::read(s(&saved["saved_to"])).unwrap(), pdf);
    let exported =
        live.call(d, "download_file", json!({ "file_id": doc["id"], "save_to": "drive/notas.docx", "format": "docx" })).await;
    assert!(std::fs::read(s(&exported["saved_to"])).unwrap().starts_with(b"PK"), "a docx is a zip");

    let found = live.call(d, "search_files", json!({ "query": format!("'{folder_id}' in parents"), "ids_only": true })).await;
    assert_eq!(found["ids"].as_array().unwrap().len(), 4, "{found}");
    let listed = live.call(d, "list_folder", json!({ "folder_id": folder_id })).await;
    assert_eq!(listed["files"].as_array().unwrap().len(), 4);
    let renamed = live
        .call(d, "update_file", json!({ "file_id": text["id"], "name": format!("{tag}-renamed.txt"), "starred": true }))
        .await;
    assert_eq!((s(&renamed["name"]), renamed["starred"].as_bool()), (format!("{tag}-renamed.txt"), Some(true)));
    let copy = live.call(d, "copy_file", json!({ "file_id": text["id"], "name": format!("{tag}-copy.txt") })).await;
    let moved =
        live.call(d, "move_files", json!({ "file_ids": [text["id"], bin["id"], copy["id"]], "folder_id": other["id"] })).await;
    assert_eq!(moved["done"], 3);
    let inside = live.call(d, "list_folder", json!({ "folder_id": other["id"] })).await;
    assert_eq!(inside["files"].as_array().unwrap().len(), 3);
    let perms = live.call(d, "list_permissions", json!({ "file_id": folder_id })).await;
    assert!(perms.as_array().unwrap().iter().any(|p| p["role"] == "owner"));
    live.call(d, "list_shared_drives", json!({})).await;

    let trashed = live.call(d, "trash_files", json!({ "file_ids": [text["id"], bin["id"], "nope"] })).await;
    assert_eq!((trashed["done"].as_u64(), trashed["failed"].as_array().map(Vec::len)), (Some(2), Some(1)));
    let restored = live.call(d, "restore_files", json!({ "file_ids": [text["id"], bin["id"]] })).await;
    assert_eq!(restored["done"], 2);
    live.call(d, "trash_files", json!({ "file_id": folder_id })).await;
}

async fn sheets(live: &Live, tag: &str) -> String {
    let sh = App::Sheets;
    let made = live.call(sh, "create_spreadsheet", json!({ "title": tag, "sheets": ["Data"] })).await;
    let id = s(&made["spreadsheetId"]);
    live.call(
        sh,
        "write_ranges",
        json!({ "spreadsheet_id": id, "data": [
            { "range": "Data!A1:C1", "values": [["item", "qty", "total"]] },
            { "range": "Data!A2:C3", "values": [["a", 2, "=B2*10"], ["b", 3, "=B3*10"]] } ] }),
    )
    .await;
    let appended =
        live.call(sh, "append_rows", json!({ "spreadsheet_id": id, "range": "Data", "values": [["c", 4, "=B4*10"]] })).await;
    assert_eq!(appended["updatedRows"], 1);
    let read = live.call(sh, "read_ranges", json!({ "spreadsheet_id": id, "ranges": ["Data!C2:C4", "Data!A1:A1"] })).await;
    assert_eq!(read[0]["values"], json!([["20"], ["30"], ["40"]]));
    let formulas =
        live.call(sh, "read_ranges", json!({ "spreadsheet_id": id, "ranges": ["Data!C2"], "render": "formula" })).await;
    assert_eq!(formulas[0]["values"], json!([["=B2*10"]]));
    let added = live.call(sh, "add_sheet", json!({ "spreadsheet_id": id, "title": "Extra", "rows": 10, "columns": 5 })).await;
    let sheets = live.call(sh, "list_sheets", json!({ "spreadsheet_id": id })).await;
    let data_id = sheets["sheets"].as_array().unwrap().iter().find(|x| x["properties"]["title"] == "Data").unwrap()["properties"]
        ["sheetId"]
        .clone();
    live.call(sh, "update_sheet", json!({ "spreadsheet_id": id, "sheet_id": data_id, "title": "Datos", "frozen_rows": 1 })).await;
    live.call(
        sh,
        "batch_update",
        json!({ "spreadsheet_id": id, "requests": [
            { "repeatCell": { "range": { "sheetId": data_id, "startRowIndex": 0, "endRowIndex": 1 }, "cell": { "userEnteredFormat": { "textFormat": { "bold": true } } }, "fields": "userEnteredFormat.textFormat.bold" } },
            { "sortRange": { "range": { "sheetId": data_id, "startRowIndex": 1, "endRowIndex": 4 }, "sortSpecs": [{ "dimensionIndex": 1, "sortOrder": "DESCENDING" }] } } ] }),
    )
    .await;
    let sorted = live.call(sh, "read_ranges", json!({ "spreadsheet_id": id, "ranges": ["Datos!A2:A4"] })).await;
    assert_eq!(sorted[0]["values"], json!([["c"], ["b"], ["a"]]));
    live.call(sh, "clear_ranges", json!({ "spreadsheet_id": id, "ranges": ["Datos!A4:C4"] })).await;
    let cleared = live.call(sh, "read_ranges", json!({ "spreadsheet_id": id, "ranges": ["Datos!A2:A4"] })).await;
    assert_eq!(cleared[0]["values"], json!([["c"], ["b"]]));
    live.call(sh, "delete_sheet", json!({ "spreadsheet_id": id, "sheet_id": added["sheetId"] })).await;
    let sheets = live.call(sh, "list_sheets", json!({ "spreadsheet_id": id })).await;
    assert_eq!(sheets["sheets"].as_array().unwrap().len(), 1);
    id
}

async fn docs(live: &Live, tag: &str) -> String {
    let dc = App::Docs;
    let made = live.call(dc, "create_document", json!({ "title": tag, "text": "Titulo\nPrimer parrafo con FOO.\n" })).await;
    let id = s(&made["documentId"]);
    let structure = live.call(dc, "read_document", json!({ "document_id": id, "format": "structure" })).await;
    let second = structure["elements"].as_array().unwrap().iter().find(|e| s(&e["text"]).starts_with("Primer")).unwrap().clone();
    let at = second["start"].as_u64().unwrap();
    let edited = live
        .call(
            dc,
            "edit_document",
            json!({ "document_id": id, "insert": [{ "index": at, "text": "Antes del primero.\n" }], "replace": [{ "find": "FOO", "with": "BAR" }], "append": "Final." }),
        )
        .await;
    assert_eq!(edited["replaced"], json!([1]));
    live.call(
        dc,
        "batch_update",
        json!({ "document_id": id, "requests": [{ "updateParagraphStyle": { "range": { "startIndex": 1, "endIndex": 7 }, "paragraphStyle": { "namedStyleType": "HEADING_1" }, "fields": "namedStyleType" } }] }),
    )
    .await;
    let read = live.call(dc, "read_document", json!({ "document_id": id })).await;
    assert_eq!(s(&read["text"]), "Titulo\nAntes del primero.\nPrimer parrafo con BAR.\nFinal.\n");
    let structure = live.call(dc, "read_document", json!({ "document_id": id, "format": "structure" })).await;
    assert_eq!(structure["elements"][0]["style"], "HEADING_1", "{structure}");
    id
}
