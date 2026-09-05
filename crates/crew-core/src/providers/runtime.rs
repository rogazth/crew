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
