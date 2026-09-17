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
            let Some(index) = settled.iter().rposition(|block| block.role == BlockRole::Assistant) else {
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
    fn turn_completed_pins_usage_on_last_assistant() {
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

    #[test]
    fn apply_event_matches_typescript() {
        let payload = include_str!("../tests/fixtures/blocks-parity.json");
        let fixture: Fixture = serde_json::from_str(payload).expect("parse fixture");
        let rust = run(fixture.events, fixture.start);
        let typescript = fold_typescript(payload);
        assert_eq!(canon(&rust), canon(&typescript));
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
