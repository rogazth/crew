#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Autonomy {
    Ask,
    /// File edits go through; everything else asks.
    Edits,
    /// The provider's own reviewer lets routine actions through.
    Auto,
    Full,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineImage {
    pub path: String,
    pub media_type: String,
    pub data: String,
}
