//! Sheets' tools: values read and written many ranges at a time, rows
//! appended, sheets made and changed, and the API's own requests for
//! anything else (formats, sorts, charts).

use serde_json::{json, Value};

use super::{flag, need, number, object, params, strings, text, tool, Args, GwsError, Run, Tool};

/// A range in A1 notation.
fn range() -> Value {
    json!({ "type": "string", "description": "A1 notation, like Sheet1!A1:D20, or a sheet's name for all of it." })
}

fn rows() -> Value {
    json!({ "type": "array", "items": { "type": "array", "items": {} }, "description": "Rows, each a list of cells." })
}

pub(super) const TOOLS: &[Tool] = &[
    tool(
        "list_sheets",
        "List sheets",
        "List a spreadsheet's title and sheets, with each one's id and size, and its named ranges.",
        true,
        false,
        || object(json!({ "spreadsheet_id": { "type": "string" } }), &["spreadsheet_id"]),
    ),
    tool(
        "read_ranges",
        "Read ranges",
        "Read one or more ranges' values in one call: as shown, as plain values, or as the formulas typed.",
        true,
        false,
        || {
            object(
                json!({
                    "spreadsheet_id": { "type": "string" },
                    "ranges": { "type": "array", "items": range(), "minItems": 1 },
                    "render": { "type": "string", "enum": ["formatted", "unformatted", "formula"], "default": "formatted" }
                }),
                &["spreadsheet_id", "ranges"],
            )
        },
    ),
    tool(
        "write_ranges",
        "Write ranges",
        "Write rows of values to one or more ranges in one call. Formulas and dates are read as typed, unless raw is on.",
        false,
        false,
        || {
            object(
                json!({
                    "spreadsheet_id": { "type": "string" },
                    "data": {
                        "type": "array",
                        "minItems": 1,
                        "items": { "type": "object", "properties": { "range": range(), "values": rows() }, "required": ["range", "values"], "additionalProperties": false }
                    },
                    "raw": { "type": "boolean", "default": false }
                }),
                &["spreadsheet_id", "data"],
            )
        },
    ),
    tool(
        "append_rows",
        "Append rows",
        "Add rows after the last row of a table: the range names the table, like Sheet1 or Sheet1!A:D.",
        false,
        false,
        || {
            object(
                json!({
                    "spreadsheet_id": { "type": "string" },
                    "range": range(),
                    "values": rows(),
                    "raw": { "type": "boolean", "default": false }
                }),
                &["spreadsheet_id", "range", "values"],
            )
        },
    ),
    tool("clear_ranges", "Clear ranges", "Clear one or more ranges' values; their formats stay.", false, true, || {
        object(
            json!({ "spreadsheet_id": { "type": "string" }, "ranges": { "type": "array", "items": range(), "minItems": 1 } }),
            &["spreadsheet_id", "ranges"],
        )
    }),
    tool("create_spreadsheet", "Create spreadsheet", "Make a spreadsheet, with sheets named as given.", false, false, || {
        object(json!({ "title": { "type": "string" }, "sheets": { "type": "array", "items": { "type": "string" } } }), &["title"])
    }),
    tool("add_sheet", "Add sheet", "Add a sheet to a spreadsheet.", false, false, || {
        object(
            json!({
                "spreadsheet_id": { "type": "string" },
                "title": { "type": "string" },
                "rows": { "type": "integer", "minimum": 1 },
                "columns": { "type": "integer", "minimum": 1 },
                "index": { "type": "integer", "minimum": 0, "description": "Its place among the tabs; last by default." }
            }),
            &["spreadsheet_id", "title"],
        )
    }),
    tool(
        "update_sheet",
        "Update sheet",
        "Rename a sheet, move its tab, hide or show it, or freeze rows and columns. Only the fields given change.",
        false,
        false,
        || {
            object(
                json!({
                    "spreadsheet_id": { "type": "string" },
                    "sheet_id": { "type": "integer", "description": "As list_sheets lists it." },
                    "title": { "type": "string", "description": "The new name." },
                    "index": { "type": "integer", "minimum": 0 },
                    "hidden": { "type": "boolean" },
                    "frozen_rows": { "type": "integer", "minimum": 0 },
                    "frozen_columns": { "type": "integer", "minimum": 0 }
                }),
                &["spreadsheet_id", "sheet_id"],
            )
        },
    ),
    tool("delete_sheet", "Delete sheet", "Delete a sheet and everything on it.", false, true, || {
        object(json!({ "spreadsheet_id": { "type": "string" }, "sheet_id": { "type": "integer" } }), &["spreadsheet_id", "sheet_id"])
    }),
    tool(
        "batch_update",
        "Batch update",
        "Send Sheets API requests (spreadsheets.batchUpdate) as they are, all or none applied: repeatCell to format, sortRange, findReplace, mergeCells, addConditionalFormatRule, autoResizeDimensions, insertDimension, deleteDimension, addChart… Ranges in them use sheetId and zero-based indexes.",
        false,
        true,
        || {
            object(
                json!({
                    "spreadsheet_id": { "type": "string" },
                    "requests": { "type": "array", "items": { "type": "object" }, "minItems": 1 }
                }),
                &["spreadsheet_id", "requests"],
            )
        },
    ),
];

pub(super) async fn run(run: &Run<'_>, name: &str, args: &Args) -> Result<Value, GwsError> {
    let id = || need(args, "spreadsheet_id");
    let input = || if flag(args, "raw", false) { "RAW" } else { "USER_ENTERED" };
    match name {
        "list_sheets" => {
            let p = params(json!({
                "spreadsheetId": id()?,
                "fields": "properties.title,spreadsheetUrl,sheets.properties(sheetId,title,index,hidden,gridProperties),namedRanges",
            }));
            run.json(&["sheets", "spreadsheets", "get", "--params", &p]).await
        }
        "read_ranges" => {
            let render = match text(args, "render").unwrap_or("formatted") {
                "formatted" => "FORMATTED_VALUE",
                "unformatted" => "UNFORMATTED_VALUE",
                "formula" => "FORMULA",
                _ => return Err(GwsError::Call("render is formatted, unformatted or formula".into())),
            };
            let p = params(json!({ "spreadsheetId": id()?, "ranges": ranges(args)?, "valueRenderOption": render }));
            let got = run.json(&["sheets", "spreadsheets", "values", "batchGet", "--params", &p]).await?;
            Ok(json!(got["valueRanges"].as_array().cloned().unwrap_or_default()))
        }
        "write_ranges" => {
            let data: Vec<Value> = args
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|d| json!({ "range": d["range"], "values": d["values"] }))
                .collect();
            if data.is_empty() || data.iter().any(|d| !d["range"].is_string() || !d["values"].is_array()) {
                return Err(GwsError::Call("data is a list of { range, values }".into()));
            }
            let p = params(json!({ "spreadsheetId": id()? }));
            let body = json!({ "valueInputOption": input(), "data": data }).to_string();
            let done = run.json(&["sheets", "spreadsheets", "values", "batchUpdate", "--params", &p, "--json", &body]).await?;
            Ok(
                json!({ "updatedCells": done["totalUpdatedCells"], "updatedRanges": done["responses"].as_array().map(|r| r.iter().map(|r| r["updatedRange"].clone()).collect::<Vec<_>>()) }),
            )
        }
        "append_rows" => {
            let values =
                args.get("values").filter(|v| v.is_array()).ok_or_else(|| GwsError::Call("values is required".into()))?;
            let p = params(json!({
                "spreadsheetId": id()?, "range": need(args, "range")?, "valueInputOption": input(), "insertDataOption": "INSERT_ROWS",
            }));
            let done = run
                .json(&[
                    "sheets",
                    "spreadsheets",
                    "values",
                    "append",
                    "--params",
                    &p,
                    "--json",
                    &json!({ "values": values }).to_string(),
                ])
                .await?;
            Ok(json!({ "updatedRange": done["updates"]["updatedRange"], "updatedRows": done["updates"]["updatedRows"] }))
        }
        "clear_ranges" => {
            let p = params(json!({ "spreadsheetId": id()? }));
            let body = json!({ "ranges": ranges(args)? }).to_string();
            let done = run.json(&["sheets", "spreadsheets", "values", "batchClear", "--params", &p, "--json", &body]).await?;
            Ok(json!({ "cleared": done["clearedRanges"] }))
        }
        "create_spreadsheet" => {
            let sheets: Vec<Value> = strings(args, "sheets").iter().map(|t| json!({ "properties": { "title": t } })).collect();
            let mut body = json!({ "properties": { "title": need(args, "title")? } });
            if !sheets.is_empty() {
                body["sheets"] = json!(sheets);
            }
            let made = run.json(&["sheets", "spreadsheets", "create", "--json", &body.to_string()]).await?;
            Ok(json!({
                "spreadsheetId": made["spreadsheetId"], "link": made["spreadsheetUrl"],
                "sheets": made["sheets"].as_array().map(|s| s.iter().map(|s| json!({ "sheetId": s["properties"]["sheetId"], "title": s["properties"]["title"] })).collect::<Vec<_>>()),
            }))
        }
        "add_sheet" => {
            let mut properties = json!({ "title": need(args, "title")? });
            if let Some(index) = args.get("index").and_then(Value::as_u64) {
                properties["index"] = json!(index);
            }
            if args.contains_key("rows") || args.contains_key("columns") {
                properties["gridProperties"] = json!({ "rowCount": number(args, "rows", 1000, 10_000_000), "columnCount": number(args, "columns", 26, 18_278) });
            }
            let replies = batch(run, id()?, vec![json!({ "addSheet": { "properties": properties } })]).await?;
            Ok(replies[0]["addSheet"]["properties"].clone())
        }
        "update_sheet" => {
            let sheet = sheet_id(args)?;
            let mut properties = json!({ "sheetId": sheet });
            let mut fields = Vec::new();
            if let Some(title) = text(args, "title") {
                properties["title"] = json!(title);
                fields.push("title");
            }
            if let Some(index) = args.get("index").and_then(Value::as_u64) {
                properties["index"] = json!(index);
                fields.push("index");
            }
            if let Some(hidden) = args.get("hidden").and_then(Value::as_bool) {
                properties["hidden"] = json!(hidden);
                fields.push("hidden");
            }
            for (key, field, grid) in [
                ("frozen_rows", "gridProperties.frozenRowCount", "frozenRowCount"),
                ("frozen_columns", "gridProperties.frozenColumnCount", "frozenColumnCount"),
            ] {
                if let Some(n) = args.get(key).and_then(Value::as_u64) {
                    properties["gridProperties"][grid] = json!(n);
                    fields.push(field);
                }
            }
            if fields.is_empty() {
                return Err(GwsError::Call("Give title, index, hidden, frozen_rows or frozen_columns".into()));
            }
            batch(run, id()?, vec![json!({ "updateSheetProperties": { "properties": properties, "fields": fields.join(",") } })])
                .await?;
            Ok(json!({ "updated": sheet, "fields": fields }))
        }
        "delete_sheet" => {
            let sheet = sheet_id(args)?;
            batch(run, id()?, vec![json!({ "deleteSheet": { "sheetId": sheet } })]).await?;
            Ok(json!({ "deleted": sheet }))
        }
        "batch_update" => {
            let requests = args.get("requests").and_then(Value::as_array).cloned().unwrap_or_default();
            if requests.is_empty() {
                return Err(GwsError::Call("requests is required".into()));
            }
            let replies = batch(run, id()?, requests).await?;
            Ok(json!({ "replies": replies }))
        }
        other => Err(GwsError::Call(format!("{other} is not a tool"))),
    }
}

fn ranges(args: &Args) -> Result<Vec<String>, GwsError> {
    let mut ranges = strings(args, "ranges");
    if let Some(one) = text(args, "range") {
        ranges.push(one.to_string());
    }
    if ranges.is_empty() {
        return Err(GwsError::Call("ranges is required".into()));
    }
    Ok(ranges)
}

fn sheet_id(args: &Args) -> Result<u64, GwsError> {
    args.get("sheet_id")
        .and_then(Value::as_u64)
        .ok_or_else(|| GwsError::Call("sheet_id is required; list_sheets lists them".into()))
}

/// Requests sent as one batch; Sheets applies all of them or none.
async fn batch(run: &Run<'_>, id: &str, requests: Vec<Value>) -> Result<Vec<Value>, GwsError> {
    let p = params(json!({ "spreadsheetId": id }));
    let body = json!({ "requests": requests }).to_string();
    let done = run.json(&["sheets", "spreadsheets", "batchUpdate", "--params", &p, "--json", &body]).await?;
    Ok(done["replies"].as_array().cloned().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fake, runs, scratch};
    use super::super::{call, App};
    use super::*;

    #[tokio::test]
    async fn many_ranges_go_in_one_call_and_rows_append_as_typed() {
        let dir = scratch();
        let gws = fake(&dir, r#"{"valueRanges":[{"range":"A1"}]}"#, 0);
        call(
            &gws,
            App::Sheets,
            "read_ranges",
            &json!({ "spreadsheet_id": "s", "ranges": ["A1:B2", "C:C"], "render": "formula" }),
            "t",
        )
        .await
        .unwrap();
        call(&gws, App::Sheets, "append_rows", &json!({ "spreadsheet_id": "s", "range": "Data", "values": [[1, "=A1"]] }), "t")
            .await
            .unwrap();
        let calls = runs(&dir);
        let read: Value = serde_json::from_str(&calls[0][5]).unwrap();
        assert_eq!((&read["ranges"], &read["valueRenderOption"]), (&json!(["A1:B2", "C:C"]), &json!("FORMULA")));
        assert_eq!(calls[1][3], "append");
        let append: Value = serde_json::from_str(&calls[1][5]).unwrap();
        assert_eq!((&append["valueInputOption"], &append["insertDataOption"]), (&json!("USER_ENTERED"), &json!("INSERT_ROWS")));
        let _ = std::fs::remove_dir_all(dir);
    }
}
