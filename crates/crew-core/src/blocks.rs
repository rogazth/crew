use std::time::{SystemTime, UNIX_EPOCH};

use crew_protocol::{
    ApprovalDecision, ApprovalResolution, Block, BlockApproval, BlockQuestion, BlockRole, BlockTool,
    HarnessEvent, ToolDetail, ToolStatus,
};

pub fn new_block(role: BlockRole, text: impl Into<String>) -> Block {
    Block {
        id: uuid::Uuid::new_v4().to_string(),
        role,
        text: text.into(),
        at: Some(now_ms()),
        hidden: None,
        streaming: None,
        files: None,
        tool: None,
        approval: None,
        question: None,
        usage: None,
        from_agent: None,
    }
}

pub fn parse_blocks(raw: Option<&str>) -> Vec<Block> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let parsed: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let serde_json::Value::Array(items) = parsed else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            obj.get("id")?.as_str()?;
            obj.get("role")?.as_str()?;
            obj.get("text")?.as_str()?;
            serde_json::from_value(item).ok()
        })
        .collect()
}

pub fn is_open(block: &Block) -> bool {
    match block.role {
        BlockRole::Tool => block
            .tool
            .as_ref()
            .is_some_and(|tool| tool.status == ToolStatus::Pending),
        BlockRole::Approval => block
            .approval
            .as_ref()
            .is_some_and(|approval| approval.decided.is_none()),
        BlockRole::Question => block.question.as_ref().is_some_and(|question| {
            question.answers.is_none() && question.dismissed != Some(true)
        }),
        _ => false,
    }
}

pub fn settle_streaming(blocks: Vec<Block>) -> Vec<Block> {
    blocks
        .into_iter()
        .map(|mut block| {
            if block.streaming == Some(true) {
                block.streaming = Some(false);
            }
            block
        })
        .collect()
}

pub fn settle_turn(blocks: Vec<Block>, tools: ToolStatus) -> Vec<Block> {
    settle_streaming(blocks)
        .into_iter()
        .map(|mut block| {
            if let Some(tool) = block.tool.as_mut() {
                if tool.status == ToolStatus::Pending {
                    tool.status = tools.clone();
                }
            }
            if let Some(approval) = block.approval.as_mut() {
                if approval.decided.is_none() {
                    approval.decided = Some(ApprovalDecision::Deny);
                }
            }
            if let Some(question) = block.question.as_mut() {
                if question.answers.is_none() && question.dismissed != Some(true) {
                    question.dismissed = Some(true);
                }
            }
            block
        })
        .collect()
}

pub fn apply_event(blocks: Vec<Block>, event: HarnessEvent) -> Vec<Block> {
    match event {
        HarnessEvent::MessageDelta { text } => append_streaming(blocks, BlockRole::Assistant, text),
        HarnessEvent::ReasoningDelta { text } => append_streaming(blocks, BlockRole::Reasoning, text),
        HarnessEvent::MessageCompleted {} => settle_streaming(blocks),
        HarnessEvent::TurnCompleted { usage } => {
            let mut settled = settle_turn(blocks, ToolStatus::Completed);
            let Some(usage) = usage else {
                return settled;
            };
            // The last block of the turn, whatever it is. A run that ends on a
            // tool call would otherwise hang its cost on a reply fifty rows
            // above — which reads as what that reply cost — or lose it, when
            // the turn had no reply at all.
            let Some(index) = settled.len().checked_sub(1) else {
                return settled;
            };
            settled[index].usage = Some(usage);
            settled[index].at = Some(now_ms());
            settled
        }
        HarnessEvent::ToolStarted {
            call_id,
            name,
            title,
            detail,
        } => {
            let settled = settle_streaming(blocks);
            let mut tool = new_block(BlockRole::Tool, title.clone());
            tool.tool = Some(BlockTool {
                call_id,
                name,
                title: title.clone(),
                status: ToolStatus::Pending,
                detail: detail.map(ToolDetail::clipped),
            });
            // The approval row was this same call asking first; one line, not two.
            if let Some(last) = settled.last() {
                if let Some(approval) = &last.approval {
                    if approval.decided != Some(ApprovalDecision::Deny) && last.text == title {
                        tool.id = last.id.clone();
                        tool.approval = last.approval.clone();
                        let mut next = settled;
                        next.pop();
                        next.push(tool);
                        return next;
                    }
                }
            }
            let mut next = settled;
            next.push(tool);
            next
        }
        HarnessEvent::ToolUpdated {
            call_id,
            title,
            status,
            detail,
        } => blocks
            .into_iter()
            .map(|mut block| {
                let Some(tool) = block.tool.as_mut() else {
                    return block;
                };
                if tool.call_id != call_id {
                    return block;
                }
                if let Some(title) = title.clone() {
                    block.text = title.clone();
                    tool.title = title;
                }
                if let Some(status) = status.clone() {
                    tool.status = status;
                }
                // An update that carries no detail is a status change, not an
                // erasure: the command a row already showed stays on it.
                if let Some(detail) = detail.clone() {
                    tool.detail = Some(detail.clipped());
                }
                block
            })
            .collect(),
        HarnessEvent::ApprovalRequested {
            request_id,
            name,
            title,
            input,
        } => {
            let mut next = settle_streaming(blocks);
            let mut card = new_block(BlockRole::Approval, title);
            card.approval = Some(BlockApproval {
                request_id,
                name,
                input,
                decided: None,
            });
            next.push(card);
            next
        }
        HarnessEvent::ApprovalResolved {
            request_id,
            decision,
        } => {
            let decided = match decision {
                ApprovalResolution::Cancelled => ApprovalDecision::Deny,
                ApprovalResolution::Allow => ApprovalDecision::Allow,
                ApprovalResolution::Always => ApprovalDecision::Always,
                ApprovalResolution::Deny => ApprovalDecision::Deny,
            };
            // Request ids restart with every turn, so the id alone names an
            // approval in every turn that ever ran. Only the newest one still
            // waiting can be the one being answered.
            let mut next = blocks;
            let waiting = next.iter().rposition(|block| {
                block
                    .approval
                    .as_ref()
                    .is_some_and(|approval| approval.request_id == request_id && approval.decided.is_none())
            });
            if let Some(index) = waiting {
                if let Some(approval) = next[index].approval.as_mut() {
                    approval.decided = Some(decided);
                }
            }
            next
        }
        HarnessEvent::QuestionRequested {
            request_id,
            questions,
        } => {
            let settled = settle_streaming(blocks);
            let text = questions
                .first()
                .map(|first| {
                    if !first.header.is_empty() {
                        first.header.clone()
                    } else if !first.question.is_empty() {
                        first.question.clone()
                    } else {
                        "Question".into()
                    }
                })
                .unwrap_or_else(|| "Question".into());
            let mut card = new_block(BlockRole::Question, text);
            card.question = Some(BlockQuestion {
                request_id,
                questions,
                answers: None,
                dismissed: None,
            });
            // The provider announced the ask as a tool call first; the card is that call.
            if let Some(last) = settled.last() {
                if last
                    .tool
                    .as_ref()
                    .is_some_and(|tool| tool.status == ToolStatus::Pending && is_question_tool(&tool.name))
                {
                    card.id = last.id.clone();
                    let mut next = settled;
                    next.pop();
                    next.push(card);
                    return next;
                }
            }
            let mut next = settled;
            next.push(card);
            next
        }
        HarnessEvent::QuestionResolved {
            request_id,
            answers,
        } => {
            // Same as an approval: the id is only unique within its turn.
            let mut next = blocks;
            let waiting = next.iter().rposition(|block| {
                block.question.as_ref().is_some_and(|question| {
                    question.request_id == request_id
                        && question.answers.is_none()
                        && question.dismissed != Some(true)
                })
            });
            if let Some(index) = waiting {
                if let Some(question) = next[index].question.as_mut() {
                    match answers {
                        Some(answers) => question.answers = Some(answers),
                        None => question.dismissed = Some(true),
                    }
                }
            }
            next
        }
        HarnessEvent::SessionError { message } => {
            let mut next = settle_turn(blocks, ToolStatus::Interrupted);
            next.push(new_block(BlockRole::System, message));
            next
        }
        HarnessEvent::SessionEnded { .. } => settle_turn(blocks, ToolStatus::Interrupted),
        HarnessEvent::SessionNote { message } => {
            let mut next = settle_streaming(blocks);
            next.push(new_block(BlockRole::System, message));
            next
        }
        HarnessEvent::UserMessage {
            text,
            hidden,
            files,
            from_agent,
        } => {
            let mut block = new_block(BlockRole::User, text);
            if hidden == Some(true) {
                block.hidden = Some(true);
            }
            if let Some(files) = files.filter(|rows| !rows.is_empty()) {
                block.files = Some(files);
            }
            block.from_agent = from_agent;
            let mut next = blocks;
            next.push(block);
            next
        }
        HarnessEvent::SystemMessage { text } => {
            let mut next = blocks;
            next.push(new_block(BlockRole::System, text));
            next
        }
        HarnessEvent::SessionStarted {} | HarnessEvent::SessionProviderBound { .. } => blocks,
    }
}

pub fn is_question_tool(name: &str) -> bool {
    name.eq_ignore_ascii_case("askuserquestion")
}

fn append_streaming(blocks: Vec<Block>, role: BlockRole, text: String) -> Vec<Block> {
    if let Some(last) = blocks.last() {
        if last.role == role && last.streaming == Some(true) {
            let mut next = blocks;
            if let Some(last) = next.last_mut() {
                last.text.push_str(&text);
            }
            return next;
        }
    }
    let mut next = settle_streaming(blocks);
    let mut block = new_block(role, text);
    block.streaming = Some(true);
    next.push(block);
    next
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crew_protocol::{Question, QuestionOption, TurnUsage};
    use serde_json::json;

    fn questions() -> Vec<Question> {
        vec![
            Question {
                question: "Pick a color".into(),
                header: "Color".into(),
                multi_select: false,
                options: vec![
                    QuestionOption {
                        label: "Red".into(),
                        description: None,
                    },
                    QuestionOption {
                        label: "Blue".into(),
                        description: None,
                    },
                ],
            },
            Question {
                question: "Pick toppings".into(),
                header: "Toppings".into(),
                multi_select: true,
                options: vec![
                    QuestionOption {
                        label: "Cheese".into(),
                        description: None,
                    },
                    QuestionOption {
                        label: "Ham".into(),
                        description: None,
                    },
                ],
            },
        ]
    }

    fn run(events: Vec<HarnessEvent>, start: Vec<Block>) -> Vec<Block> {
        events.into_iter().fold(start, apply_event)
    }

    #[test]
    fn streaming_keeps_assistant_and_reasoning_apart() {
        let blocks = run(
            vec![
                HarnessEvent::ReasoningDelta {
                    text: "Let me ".into(),
                },
                HarnessEvent::ReasoningDelta {
                    text: "think.".into(),
                },
                HarnessEvent::MessageDelta {
                    text: "Done.".into(),
                },
                HarnessEvent::MessageDelta {
                    text: " Really.".into(),
                },
            ],
            vec![],
        );
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].role, BlockRole::Reasoning);
        assert_eq!(blocks[0].text, "Let me think.");
        assert_eq!(blocks[0].streaming, Some(false));
        assert_eq!(blocks[1].role, BlockRole::Assistant);
        assert_eq!(blocks[1].text, "Done. Really.");
        assert_eq!(blocks[1].streaming, Some(true));
    }

    #[test]
    fn question_replaces_pending_ask_tool() {
        let blocks = run(
            vec![
                HarnessEvent::ToolStarted {
                    call_id: "t1".into(),
                    name: "AskUserQuestion".into(),
                    title: "AskUserQuestion".into(),
                    detail: None,
                },
                HarnessEvent::QuestionRequested {
                    request_id: 1,
                    questions: questions(),
                },
            ],
            vec![],
        );
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].role, BlockRole::Question);
        assert_eq!(blocks[0].text, "Color");
        assert!(is_open(&blocks[0]));
    }

    #[test]
    fn question_stores_answers() {
        let blocks = run(
            vec![
                HarnessEvent::QuestionRequested {
                    request_id: 1,
                    questions: questions(),
                },
                HarnessEvent::QuestionResolved {
                    request_id: 1,
                    answers: Some(
                        [("Pick a color".into(), "Red".into())]
                            .into_iter()
                            .collect(),
                    ),
                },
            ],
            vec![],
        );
        assert_eq!(
            blocks[0].question.as_ref().and_then(|q| q.answers.as_ref()).and_then(|a| a.get("Pick a color")),
            Some(&"Red".to_string())
        );
        assert!(!is_open(&blocks[0]));
    }

    #[test]
    fn question_null_answer_dismisses() {
        let blocks = run(
            vec![
                HarnessEvent::QuestionRequested {
                    request_id: 1,
                    questions: questions(),
                },
                HarnessEvent::QuestionResolved {
                    request_id: 1,
                    answers: None,
                },
            ],
            vec![],
        );
        assert_eq!(blocks[0].question.as_ref().and_then(|q| q.dismissed), Some(true));
    }

    #[test]
    fn settle_dismisses_unanswered_question() {
        let blocks = settle_turn(
            run(
                vec![HarnessEvent::QuestionRequested {
                    request_id: 1,
                    questions: questions(),
                }],
                vec![],
            ),
            ToolStatus::Interrupted,
        );
        assert_eq!(blocks[0].question.as_ref().and_then(|q| q.dismissed), Some(true));
        assert!(!is_open(&blocks[0]));
    }

    #[test]
    fn approval_folds_into_one_tool_row() {
        let blocks = run(
            vec![
                HarnessEvent::ApprovalRequested {
                    request_id: 1,
                    name: "Bash".into(),
                    title: "npm run lint".into(),
                    input: Some(json!({ "command": "npm run lint" })),
                },
                HarnessEvent::ApprovalResolved {
                    request_id: 1,
                    decision: ApprovalResolution::Always,
                },
                HarnessEvent::ToolStarted {
                    call_id: "t1".into(),
                    name: "Bash".into(),
                    title: "npm run lint".into(),
                    detail: None,
                },
            ],
            vec![],
        );
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].role, BlockRole::Tool);
        assert_eq!(
            blocks[0].approval.as_ref().and_then(|row| row.decided.clone()),
            Some(ApprovalDecision::Always)
        );
    }

    #[test]
    fn denied_approval_stays_its_own_row() {
        let blocks = run(
            vec![
                HarnessEvent::ApprovalRequested {
                    request_id: 1,
                    name: "Bash".into(),
                    title: "rm -rf dist".into(),
                    input: None,
                },
                HarnessEvent::ApprovalResolved {
                    request_id: 1,
                    decision: ApprovalResolution::Deny,
                },
                HarnessEvent::ToolStarted {
                    call_id: "t1".into(),
                    name: "Bash".into(),
                    title: "rm -rf dist".into(),
                    detail: None,
                },
            ],
            vec![],
        );
        assert_eq!(
            blocks.iter().map(|b| b.role.clone()).collect::<Vec<_>>(),
            vec![BlockRole::Approval, BlockRole::Tool]
        );
    }

    #[test]
    fn user_and_system_messages_append_rows() {
        let blocks = run(
            vec![
                HarnessEvent::UserMessage {
                    text: "hi".into(),
                    hidden: Some(true),
                    files: None,
                    from_agent: None,
                },
                HarnessEvent::SystemMessage {
                    text: "Stopped".into(),
                },
            ],
            vec![],
        );
        assert_eq!(blocks[0].role, BlockRole::User);
        assert_eq!(blocks[0].text, "hi");
        assert_eq!(blocks[0].hidden, Some(true));
        assert_eq!(blocks[1].role, BlockRole::System);
        assert_eq!(blocks[1].text, "Stopped");
    }

    #[test]
    fn turn_completed_pins_usage_on_the_reply_the_turn_ended_with() {
        let blocks = run(
            vec![
                HarnessEvent::MessageDelta { text: "ok".into() },
                HarnessEvent::TurnCompleted {
                    usage: Some(TurnUsage {
                        input_tokens: None,
                        output_tokens: None,
                        cost_usd: Some(0.01),
                        duration_ms: None,
                    }),
                },
            ],
            vec![new_block(BlockRole::User, "hi")],
        );
        let last = blocks.last().unwrap();
        assert_eq!(last.usage.as_ref().and_then(|u| u.cost_usd), Some(0.01));
        assert_eq!(last.streaming, Some(false));
    }

    /// An agentic run ends on its last tool call as often as on a sentence.
    /// The cost is the turn's either way, and hanging it on a reply from
    /// further up reads as what that reply cost.
    #[test]
    fn turn_completed_pins_usage_on_a_tool_row_when_the_turn_ended_on_one() {
        let blocks = run(
            vec![
                HarnessEvent::MessageDelta { text: "on it".into() },
                HarnessEvent::MessageCompleted {},
                HarnessEvent::ToolStarted {
                    call_id: "c1".into(),
                    name: "bash".into(),
                    title: "npm test".into(),
                    detail: None,
                },
                HarnessEvent::ToolUpdated {
                    call_id: "c1".into(),
                    title: None,
                    status: Some(ToolStatus::Completed),
                    detail: None,
                },
                HarnessEvent::TurnCompleted {
                    usage: Some(TurnUsage {
                        input_tokens: None,
                        output_tokens: None,
                        cost_usd: Some(0.02),
                        duration_ms: None,
                    }),
                },
            ],
            vec![new_block(BlockRole::User, "hi")],
        );
        let last = blocks.last().unwrap();
        assert_eq!(last.role, BlockRole::Tool);
        assert_eq!(last.usage.as_ref().and_then(|u| u.cost_usd), Some(0.02));
        assert!(
            blocks.iter().all(|b| b.role != BlockRole::Assistant || b.usage.is_none()),
            "the cost landed on a reply as well"
        );
    }

    #[test]
    fn parse_blocks_keeps_optional_fields() {
        let raw = r#"[{"id":"a","role":"user","text":"hi","hidden":true,"files":[{"name":"x","path":"/x"}]}]"#;
        let blocks = parse_blocks(Some(raw));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].hidden, Some(true));
        assert_eq!(blocks[0].files.as_ref().map(|f| f.len()), Some(1));
    }

    #[derive(serde::Deserialize)]
    struct Fixture {
        #[serde(default)]
        start: Vec<Block>,
        events: Vec<HarnessEvent>,
    }

    fn canon(blocks: &[Block]) -> serde_json::Value {
        let mut raw = serde_json::to_value(blocks).expect("blocks json");
        let mut ids = std::collections::HashMap::new();
        rewrite(&mut raw, &mut ids);
        raw
    }

    fn rewrite(value: &mut serde_json::Value, ids: &mut std::collections::HashMap<String, String>) {
        match value {
            serde_json::Value::Array(items) => {
                for item in items {
                    rewrite(item, ids);
                }
            }
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::String(id)) = map.get("id").cloned() {
                    let next = ids.len();
                    let mapped = ids.entry(id).or_insert_with(|| format!("id-{next}")).clone();
                    map.insert("id".into(), serde_json::Value::String(mapped));
                }
                if map.contains_key("at") {
                    map.insert("at".into(), serde_json::Value::from(0));
                }
                for item in map.values_mut() {
                    rewrite(item, ids);
                }
            }
            _ => {}
        }
    }

    fn fold_typescript(payload: &str) -> Vec<Block> {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .expect("repo root");
        let script = root.join("scripts/fold-blocks.ts");
        let mut child = Command::new("npx")
            .args(["vite-node", script.to_str().expect("utf8 path")])
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn vite-node");
        child
            .stdin
            .as_mut()
            .expect("stdin")
            .write_all(payload.as_bytes())
            .expect("write fixture");
        let output = child.wait_with_output().expect("vite-node");
        assert!(
            output.status.success(),
            "vite-node failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).expect("ts fold json")
    }

    /// Every event this reducer knows, against a transcript that already has
    /// history, so the invariant below is tested where it could break.
    fn every_event() -> Vec<HarnessEvent> {
        vec![
            HarnessEvent::SessionStarted {},
            HarnessEvent::UserMessage {
                text: "hi".into(),
                files: None,
                hidden: None,
                from_agent: None,
            },
            HarnessEvent::SystemMessage { text: "note".into() },
            HarnessEvent::SessionNote { message: "note".into() },
            HarnessEvent::ReasoningDelta { text: "hm".into() },
            HarnessEvent::MessageDelta { text: "ok".into() },
            HarnessEvent::MessageCompleted {},
            HarnessEvent::ToolStarted {
                call_id: "c9".into(),
                name: "bash".into(),
                title: "ls".into(),
                detail: None,
            },
            HarnessEvent::ToolUpdated {
                call_id: "c9".into(),
                title: None,
                status: Some(ToolStatus::Completed),
                detail: None,
            },
            HarnessEvent::ApprovalRequested {
                request_id: 7,
                name: "bash".into(),
                title: "rm".into(),
                input: None,
            },
            HarnessEvent::ApprovalResolved {
                request_id: 7,
                decision: ApprovalResolution::Allow,
            },
            HarnessEvent::QuestionRequested { request_id: 8, questions: Vec::new() },
            HarnessEvent::QuestionResolved { request_id: 8, answers: None },
            HarnessEvent::TurnCompleted { usage: None },
            HarnessEvent::SessionError { message: "boom".into() },
            HarnessEvent::SessionEnded { code: Some(1) },
        ]
    }

    /// The `messages` table upserts by position, which is only cheap because
    /// blocks are append-only: a block arriving anywhere but the end rewrites
    /// every row after it. Nothing in the type system says so, so this does.
    ///
    /// "Append-only" allows a trailing block to go — an empty streaming reply
    /// is dropped when it settles — so the rule is that the shorter list is a
    /// prefix of the longer one. An insertion in the middle breaks that.
    #[test]
    fn no_event_puts_a_block_anywhere_but_the_end() {
        let history = run(
            vec![
                HarnessEvent::UserMessage {
                    text: "earlier".into(),
                    files: None,
                    hidden: None,
                    from_agent: None,
                },
                HarnessEvent::MessageDelta { text: "earlier answer".into() },
                HarnessEvent::MessageCompleted {},
                HarnessEvent::ToolStarted {
                    call_id: "c1".into(),
                    name: "bash".into(),
                    title: "npm test".into(),
                    detail: None,
                },
            ],
            Vec::new(),
        );
        let before: Vec<String> = history.iter().map(|block| block.id.clone()).collect();

        for event in every_event() {
            let after: Vec<String> = apply_event(history.clone(), event.clone())
                .iter()
                .map(|block| block.id.clone())
                .collect();
            let shared = before.len().min(after.len());
            assert_eq!(
                before[..shared],
                after[..shared],
                "{event:?} moved a block that was already written"
            );
        }
    }

    #[test]
    fn apply_event_matches_typescript() {
        let payload = include_str!("../tests/fixtures/blocks-parity.json");
        let fixture: Fixture = serde_json::from_str(payload).expect("parse fixture");
        let rust = run(fixture.events, fixture.start);
        let typescript = fold_typescript(payload);
        assert_eq!(canon(&rust), canon(&typescript));
    }

    #[test]
    fn parse_blocks_keeps_only_well_formed_rows() {
        let tool = r#"{"callId":"c1","name":"bash","title":"ls","status":"completed"}"#;
        let every_wrong_row = format!(
            r#"[
                {{"id":"ok1","role":"user","text":"hi"}},
                "a string",
                {{"role":"user","text":"no id"}},
                {{"id":7,"role":"user","text":"id is a number"}},
                {{"id":"x","text":"no role"}},
                {{"id":"x","role":5,"text":"role is a number"}},
                {{"id":"x","role":"user"}},
                {{"id":"x","role":"user","text":5}},
                {{"id":"x","role":"robot","text":"unknown role"}},
                {{"id":"x","role":"user","text":"bad flag","hidden":"yes"}},
                {{"id":"ok2","role":"tool","text":"ls","tool":{tool}}}
            ]"#
        );
        let cases: Vec<(&str, Option<&str>, Vec<&str>)> = vec![
            ("nothing stored", None, vec![]),
            ("an empty string", Some(""), vec![]),
            ("not json", Some("[{\"id\":"), vec![]),
            ("an object, not a list", Some(r#"{"id":"a","role":"user","text":"hi"}"#), vec![]),
            ("every way a row can be wrong, between two good ones", Some(&every_wrong_row), vec!["ok1", "ok2"]),
        ];
        for (name, raw, ids) in cases {
            let got: Vec<String> = parse_blocks(raw).into_iter().map(|block| block.id).collect();
            assert_eq!(got, ids, "{name}");
        }
    }

    fn tool_block(status: ToolStatus) -> Block {
        let mut block = new_block(BlockRole::Tool, "ls");
        block.tool = Some(BlockTool {
            call_id: "c1".into(),
            name: "bash".into(),
            title: "ls".into(),
            status,
            detail: None,
        });
        block
    }

    fn approval_block(decided: Option<ApprovalDecision>) -> Block {
        let mut block = new_block(BlockRole::Approval, "rm");
        block.approval = Some(BlockApproval { request_id: 1, name: "Bash".into(), input: None, decided });
        block
    }

    fn question_block(answered: bool, dismissed: Option<bool>) -> Block {
        let mut block = new_block(BlockRole::Question, "Color");
        block.question = Some(BlockQuestion {
            request_id: 1,
            questions: questions(),
            answers: answered.then(|| [("Pick a color".to_string(), "Red".to_string())].into_iter().collect()),
            dismissed,
        });
        block
    }

    fn streaming_reply() -> Block {
        let mut block = new_block(BlockRole::Assistant, "typing");
        block.streaming = Some(true);
        block
    }

    #[test]
    fn a_block_is_open_while_it_waits_for_someone() {
        let cases: Vec<(&str, Block, bool)> = vec![
            ("a pending tool", tool_block(ToolStatus::Pending), true),
            ("a finished tool", tool_block(ToolStatus::Completed), false),
            ("a tool row with no tool", new_block(BlockRole::Tool, "ls"), false),
            ("an approval waiting", approval_block(None), true),
            ("an approval answered", approval_block(Some(ApprovalDecision::Allow)), false),
            ("an approval row with no approval", new_block(BlockRole::Approval, "rm"), false),
            ("a question waiting", question_block(false, None), true),
            ("a question not dismissed", question_block(false, Some(false)), true),
            ("a question answered", question_block(true, None), false),
            ("a question dismissed", question_block(false, Some(true)), false),
            ("a question row with no question", new_block(BlockRole::Question, "Q"), false),
            ("a streaming reply", streaming_reply(), false),
            ("a user message", new_block(BlockRole::User, "hi"), false),
            ("a system note", new_block(BlockRole::System, "note"), false),
        ];
        for (name, block, open) in cases {
            assert_eq!(is_open(&block), open, "{name}");
        }
    }

    /// What settling left on a block: streaming, tool status, approval
    /// decision, question dismissed, question answered.
    type Settled = (Option<bool>, Option<ToolStatus>, Option<ApprovalDecision>, Option<bool>, bool);

    fn settled(block: &Block) -> Settled {
        (
            block.streaming,
            block.tool.as_ref().map(|tool| tool.status.clone()),
            block.approval.as_ref().and_then(|approval| approval.decided.clone()),
            block.question.as_ref().and_then(|question| question.dismissed),
            block.question.as_ref().is_some_and(|question| question.answers.is_some()),
        )
    }

    #[test]
    fn settling_a_turn_closes_whatever_is_still_open() {
        use ToolStatus::{Completed, Failed, Interrupted, Pending};
        let tool = |status| (None, Some(status), None, None, false);
        let approval = |decided| (None, None, Some(decided), None, false);
        let question_left = |dismissed, answered| (None, None, None, dismissed, answered);
        let cases: Vec<(&str, Block, ToolStatus, Settled)> = vec![
            ("a pending tool is interrupted", tool_block(Pending), Interrupted, tool(Interrupted)),
            ("a pending tool is completed", tool_block(Pending), Completed, tool(Completed)),
            ("a failed tool stays failed", tool_block(Failed), Completed, tool(Failed)),
            ("a waiting approval is denied", approval_block(None), Completed, approval(ApprovalDecision::Deny)),
            (
                "an allowed approval stays allowed",
                approval_block(Some(ApprovalDecision::Always)),
                Interrupted,
                approval(ApprovalDecision::Always),
            ),
            (
                "a waiting question is dismissed",
                question_block(false, None),
                Completed,
                question_left(Some(true), false),
            ),
            (
                "a question not dismissed yet is",
                question_block(false, Some(false)),
                Completed,
                question_left(Some(true), false),
            ),
            ("an answered question keeps its answer", question_block(true, None), Completed, question_left(None, true)),
            ("a streaming reply stops streaming", streaming_reply(), Completed, (Some(false), None, None, None, false)),
            (
                "a user message is left alone",
                new_block(BlockRole::User, "hi"),
                Completed,
                (None, None, None, None, false),
            ),
        ];
        for (name, block, tools, expected) in cases {
            let after = settle_turn(vec![block], tools);
            assert_eq!(settled(&after[0]), expected, "{name}");
        }
    }

    fn question(text: &str, header: &str) -> Question {
        Question { question: text.into(), header: header.into(), multi_select: false, options: Vec::new() }
    }

    fn tool_started(call_id: &str, name: &str, title: &str) -> HarnessEvent {
        HarnessEvent::ToolStarted { call_id: call_id.into(), name: name.into(), title: title.into(), detail: None }
    }

    fn asked(request_id: u64, title: &str) -> HarnessEvent {
        HarnessEvent::ApprovalRequested { request_id, name: "Bash".into(), title: title.into(), input: None }
    }

    fn resolved(request_id: u64, decision: ApprovalResolution) -> HarnessEvent {
        HarnessEvent::ApprovalResolved { request_id, decision }
    }

    fn ask_questions(request_id: u64, questions: Vec<Question>) -> HarnessEvent {
        HarnessEvent::QuestionRequested { request_id, questions }
    }

    fn user_message(text: &str, files: Option<Vec<crew_protocol::AttachedFile>>) -> HarnessEvent {
        HarnessEvent::UserMessage { text: text.into(), hidden: None, files, from_agent: None }
    }

    fn pending(call_id: &str, name: &str, title: &str) -> serde_json::Value {
        json!({ "callId": call_id, "name": name, "title": title, "status": "pending" })
    }

    /// A question block with nothing asked in it, as `canon` prints it.
    fn open_question(id: &str, request_id: u64) -> serde_json::Value {
        json!({ "id": id, "role": "question", "text": "Question", "at": 0,
                "question": { "requestId": request_id, "questions": [] } })
    }

    /// Each event against a transcript, compared with ids numbered in order of
    /// appearance and every timestamp zeroed.
    #[test]
    fn each_event_folds_into_the_transcript_it_should() {
        let usage = TurnUsage { input_tokens: Some(3), output_tokens: Some(4), cost_usd: None, duration_ms: None };
        let from = crew_protocol::AgentRef { id: "a1".into(), name: "Cuddles".into() };
        let file = crew_protocol::AttachedFile {
            name: "a.png".into(),
            path: "/w/a.png".into(),
            kind: None,
            size: Some(9),
        };
        let one_answer: std::collections::HashMap<String, String> =
            [("q".to_string(), "a".to_string())].into_iter().collect();
        let failed_ls = ToolDetail::Command { command: "ls -la".into(), exit_code: Some(2), output: None };
        let cases: Vec<(&str, Vec<Block>, Vec<HarnessEvent>, serde_json::Value)> = vec![
            (
                "a cancelled approval reads as a denial",
                vec![],
                vec![asked(1, "rm -rf dist"), resolved(1, ApprovalResolution::Cancelled)],
                json!([{ "id": "id-0", "role": "approval", "text": "rm -rf dist", "at": 0,
                         "approval": { "requestId": 1, "name": "Bash", "decided": "deny" } }]),
            ),
            (
                "an answer to an approval nobody asked for changes nothing",
                vec![],
                vec![
                    HarnessEvent::ApprovalRequested {
                        request_id: 1,
                        name: "Bash".into(),
                        title: "ls".into(),
                        input: Some(json!({ "command": "ls" })),
                    },
                    resolved(2, ApprovalResolution::Allow),
                ],
                json!([{ "id": "id-0", "role": "approval", "text": "ls", "at": 0,
                         "approval": { "requestId": 1, "name": "Bash", "input": { "command": "ls" } } }]),
            ),
            (
                "a question with no header is titled by its question",
                vec![],
                vec![ask_questions(1, vec![question("Pick one", "")])],
                json!([{ "id": "id-0", "role": "question", "text": "Pick one", "at": 0,
                         "question": { "requestId": 1, "questions": [
                             { "question": "Pick one", "header": "", "multiSelect": false, "options": [] }
                         ] } }]),
            ),
            (
                "a question with neither is just a question",
                vec![],
                vec![ask_questions(1, vec![question("", "")])],
                json!([{ "id": "id-0", "role": "question", "text": "Question", "at": 0,
                         "question": { "requestId": 1, "questions": [
                             { "question": "", "header": "", "multiSelect": false, "options": [] }
                         ] } }]),
            ),
            (
                "a question with nothing asked is still a question",
                vec![],
                vec![ask_questions(1, vec![])],
                json!([open_question("id-0", 1)]),
            ),
            (
                "a question answered twice keeps the first answer",
                vec![],
                vec![
                    ask_questions(1, vec![]),
                    HarnessEvent::QuestionResolved { request_id: 1, answers: Some(one_answer) },
                    HarnessEvent::QuestionResolved { request_id: 1, answers: None },
                ],
                json!([{ "id": "id-0", "role": "question", "text": "Question", "at": 0,
                         "question": { "requestId": 1, "questions": [], "answers": { "q": "a" } } }]),
            ),
            (
                "an answer to another question changes nothing",
                vec![],
                vec![ask_questions(1, vec![]), HarnessEvent::QuestionResolved { request_id: 9, answers: None }],
                json!([open_question("id-0", 1)]),
            ),
            (
                "a question after an ask that already finished is its own row",
                vec![],
                vec![
                    tool_started("t1", "AskUserQuestion", "Ask"),
                    HarnessEvent::ToolUpdated {
                        call_id: "t1".into(),
                        title: None,
                        status: Some(ToolStatus::Completed),
                        detail: None,
                    },
                    ask_questions(1, vec![]),
                ],
                json!([
                    { "id": "id-0", "role": "tool", "text": "Ask", "at": 0,
                      "tool": { "callId": "t1", "name": "AskUserQuestion", "title": "Ask", "status": "completed" } },
                    open_question("id-1", 1)
                ]),
            ),
            (
                "a question after another tool is its own row",
                vec![],
                vec![tool_started("t1", "Bash", "ls"), ask_questions(1, vec![])],
                json!([
                    { "id": "id-0", "role": "tool", "text": "ls", "at": 0, "tool": pending("t1", "Bash", "ls") },
                    open_question("id-1", 1)
                ]),
            ),
            (
                "a tool after an approval for something else is its own row",
                vec![],
                vec![
                    asked(1, "npm test"),
                    resolved(1, ApprovalResolution::Allow),
                    tool_started("t1", "Bash", "npm run lint"),
                ],
                json!([
                    { "id": "id-0", "role": "approval", "text": "npm test", "at": 0,
                      "approval": { "requestId": 1, "name": "Bash", "decided": "allow" } },
                    { "id": "id-1", "role": "tool", "text": "npm run lint", "at": 0,
                      "tool": pending("t1", "Bash", "npm run lint") }
                ]),
            ),
            (
                "a letter keeps its files and its sender, and a false hidden is left off",
                vec![],
                vec![HarnessEvent::UserMessage {
                    text: "mira".into(),
                    hidden: Some(false),
                    files: Some(vec![file]),
                    from_agent: Some(from),
                }],
                json!([{ "id": "id-0", "role": "user", "text": "mira", "at": 0,
                         "files": [{ "name": "a.png", "path": "/w/a.png", "size": 9 }],
                         // canon renumbers every id, the sender's too
                         "fromAgent": { "id": "id-1", "name": "Cuddles" } }]),
            ),
            (
                "an empty file list is no files",
                vec![],
                vec![user_message("hola", Some(vec![]))],
                json!([{ "id": "id-0", "role": "user", "text": "hola", "at": 0 }]),
            ),
            (
                "usage on an empty transcript has nowhere to go",
                vec![],
                vec![HarnessEvent::TurnCompleted { usage: Some(usage.clone()) }],
                json!([]),
            ),
            (
                "the end of a turn settles everything still open",
                vec![],
                vec![
                    HarnessEvent::MessageDelta { text: "ok".into() },
                    tool_started("c1", "bash", "ls"),
                    asked(2, "rm"),
                    ask_questions(3, vec![]),
                    HarnessEvent::TurnCompleted { usage: Some(usage.clone()) },
                ],
                json!([
                    { "id": "id-0", "role": "assistant", "text": "ok", "at": 0, "streaming": false },
                    { "id": "id-1", "role": "tool", "text": "ls", "at": 0,
                      "tool": { "callId": "c1", "name": "bash", "title": "ls", "status": "completed" } },
                    { "id": "id-2", "role": "approval", "text": "rm", "at": 0,
                      "approval": { "requestId": 2, "name": "Bash", "decided": "deny" } },
                    { "id": "id-3", "role": "question", "text": "Question", "at": 0,
                      "question": { "requestId": 3, "questions": [], "dismissed": true },
                      "usage": { "inputTokens": 3, "outputTokens": 4 } }
                ]),
            ),
            (
                "a session error interrupts what was running and says why",
                vec![],
                vec![tool_started("c1", "bash", "ls"), HarnessEvent::SessionError { message: "boom".into() }],
                json!([
                    { "id": "id-0", "role": "tool", "text": "ls", "at": 0,
                      "tool": { "callId": "c1", "name": "bash", "title": "ls", "status": "interrupted" } },
                    { "id": "id-1", "role": "system", "text": "boom", "at": 0 }
                ]),
            ),
            (
                "a session that ends interrupts without a word",
                vec![],
                vec![tool_started("c1", "bash", "ls"), HarnessEvent::SessionEnded { code: Some(137) }],
                json!([{ "id": "id-0", "role": "tool", "text": "ls", "at": 0,
                         "tool": { "callId": "c1", "name": "bash", "title": "ls", "status": "interrupted" } }]),
            ),
            (
                "a note settles the reply and adds a line",
                vec![],
                vec![
                    HarnessEvent::MessageDelta { text: "a".into() },
                    HarnessEvent::SessionNote { message: "compacted".into() },
                ],
                json!([
                    { "id": "id-0", "role": "assistant", "text": "a", "at": 0, "streaming": false },
                    { "id": "id-1", "role": "system", "text": "compacted", "at": 0 }
                ]),
            ),
            (
                "starting and binding a session change nothing",
                vec![new_block(BlockRole::User, "hi")],
                vec![
                    HarnessEvent::SessionStarted {},
                    HarnessEvent::SessionProviderBound { provider_session_id: "p1".into() },
                ],
                json!([{ "id": "id-0", "role": "user", "text": "hi", "at": 0 }]),
            ),
            (
                "an update renames and details only its own call",
                vec![],
                vec![
                    tool_started("c1", "bash", "ls"),
                    tool_started("c2", "bash", "pwd"),
                    HarnessEvent::ToolUpdated {
                        call_id: "c1".into(),
                        title: Some("ls -la".into()),
                        status: Some(ToolStatus::Failed),
                        detail: Some(failed_ls),
                    },
                ],
                json!([
                    { "id": "id-0", "role": "tool", "text": "ls -la", "at": 0,
                      "tool": { "callId": "c1", "name": "bash", "title": "ls -la", "status": "failed",
                                "detail": { "kind": "command", "command": "ls -la", "exitCode": 2 } } },
                    { "id": "id-1", "role": "tool", "text": "pwd", "at": 0, "tool": pending("c2", "bash", "pwd") }
                ]),
            ),
            (
                "an update that says nothing changes nothing",
                vec![new_block(BlockRole::User, "hi")],
                vec![
                    tool_started("c1", "bash", "ls"),
                    HarnessEvent::ToolUpdated { call_id: "c1".into(), title: None, status: None, detail: None },
                ],
                json!([
                    { "id": "id-0", "role": "user", "text": "hi", "at": 0 },
                    { "id": "id-1", "role": "tool", "text": "ls", "at": 0, "tool": pending("c1", "bash", "ls") }
                ]),
            ),
            (
                "reasoning between two replies starts a block each time",
                vec![],
                vec![
                    HarnessEvent::MessageDelta { text: "a".into() },
                    HarnessEvent::ReasoningDelta { text: "b".into() },
                    HarnessEvent::MessageDelta { text: "c".into() },
                ],
                json!([
                    { "id": "id-0", "role": "assistant", "text": "a", "at": 0, "streaming": false },
                    { "id": "id-1", "role": "reasoning", "text": "b", "at": 0, "streaming": false },
                    { "id": "id-2", "role": "assistant", "text": "c", "at": 0, "streaming": true }
                ]),
            ),
            (
                "a reply after a settled one is a new reply",
                vec![],
                vec![
                    HarnessEvent::MessageDelta { text: "a".into() },
                    HarnessEvent::MessageCompleted {},
                    HarnessEvent::MessageDelta { text: "b".into() },
                ],
                json!([
                    { "id": "id-0", "role": "assistant", "text": "a", "at": 0, "streaming": false },
                    { "id": "id-1", "role": "assistant", "text": "b", "at": 0, "streaming": true }
                ]),
            ),
        ];
        for (name, start, events, expected) in cases {
            assert_eq!(canon(&run(events, start)), expected, "{name}");
        }
    }

    /// Provider output is stored clipped, whether it arrives with the call or
    /// with its result.
    #[test]
    fn a_tool_detail_is_clipped_on_the_way_in() {
        let huge = "x".repeat(crew_protocol::TOOL_TEXT_LIMIT * 2);
        let clipped = crew_protocol::clip(&huge, crew_protocol::TOOL_TEXT_LIMIT);
        let output = |blocks: &[Block]| {
            let detail = blocks.last().and_then(|block| block.tool.as_ref()).and_then(|tool| tool.detail.clone());
            match detail {
                Some(ToolDetail::Output { text }) => text,
                other => panic!("expected an output detail, got {other:?}"),
            }
        };
        let started = run(
            vec![HarnessEvent::ToolStarted {
                call_id: "c1".into(),
                name: "mcp".into(),
                title: "mcp".into(),
                detail: Some(ToolDetail::Output { text: huge.clone() }),
            }],
            vec![],
        );
        assert_eq!(output(&started), clipped);
        let updated = run(
            vec![
                tool_started("c1", "mcp", "mcp"),
                HarnessEvent::ToolUpdated {
                    call_id: "c1".into(),
                    title: None,
                    status: None,
                    detail: Some(ToolDetail::Output { text: huge.clone() }),
                },
            ],
            vec![],
        );
        assert_eq!(output(&updated), clipped);
    }
}

/// Adversarial review. Added by review; no production code is touched.
#[cfg(test)]
mod id_reuse_review {
    use super::*;
    use crew_protocol::{ApprovalDecision, ApprovalResolution, HarnessEvent};

    /// `ApprovalResolved` rewrites every block in the transcript carrying that
    /// `request_id`, and `request_id` is `ClaudeLive::next_ui`, which is set
    /// back to 1 at the start of every turn (crates/crew-core/src/turns.rs:723).
    /// So the second turn's first approval rewrites the first turn's — and now
    /// that "Earlier messages" puts old turns back in the reader's hands, this
    /// is something they can watch happen.
    #[test]
    fn resolving_an_approval_does_not_rewrite_the_last_turns() {
        let events = vec![
            // Turn one: approval 1, denied.
            HarnessEvent::ApprovalRequested {
                request_id: 1,
                name: "Bash".into(),
                title: "rm -rf /".into(),
                input: None,
            },
            HarnessEvent::ApprovalResolved {
                request_id: 1,
                decision: ApprovalResolution::Deny,
            },
            HarnessEvent::TurnCompleted { usage: None },
            // Turn two: the counter started over, so this is approval 1 too.
            HarnessEvent::ApprovalRequested {
                request_id: 1,
                name: "Bash".into(),
                title: "ls".into(),
                input: None,
            },
            HarnessEvent::ApprovalResolved {
                request_id: 1,
                decision: ApprovalResolution::Allow,
            },
        ];
        let blocks = events
            .into_iter()
            .fold(Vec::<Block>::new(), apply_event);
        let decisions: Vec<Option<ApprovalDecision>> = blocks
            .iter()
            .filter(|block| block.role == BlockRole::Approval)
            .map(|block| block.approval.as_ref().and_then(|row| row.decided.clone()))
            .collect();
        assert_eq!(
            decisions,
            vec![Some(ApprovalDecision::Deny), Some(ApprovalDecision::Allow)],
            "the transcript now says `rm -rf /` was allowed"
        );
    }
}
