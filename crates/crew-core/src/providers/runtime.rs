use std::collections::HashMap;

use crew_protocol::{ApprovalDecision, HarnessEvent};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Autonomy {
    Ask,
    Full,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineImage {
    pub path: String,
    pub media_type: String,
    pub data: String,
}

#[derive(Clone, Debug)]
pub struct TurnInput {
    pub session_id: String,
    pub cwd: String,
    pub model: String,
    pub name: String,
    pub description: String,
    pub autonomy: Autonomy,
    pub resume: Option<String>,
    pub fresh: bool,
    pub text: String,
    pub files: Vec<String>,
    pub images: Vec<InlineImage>,
}

/// Mirrors `ProviderRuntime` in `src/lib/providers/runtime.ts`.
/// Process methods are wired with the turn drivers; parsers sit behind this trait.
pub trait ProviderRuntime: Send + Sync {
    fn send(&self, input: TurnInput, on_event: &dyn Fn(HarnessEvent)) -> Result<(), String>;
    fn cancel(&self, session_id: &str);
    fn stop(&self, session_id: &str);
    fn respond_approval(&self, session_id: &str, request_id: u64, decision: ApprovalDecision);
    fn respond_question(
        &self,
        session_id: &str,
        request_id: u64,
        answers: Option<HashMap<String, String>>,
    );
    fn is_live(&self, session_id: &str) -> bool;
}
