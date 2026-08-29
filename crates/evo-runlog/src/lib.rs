pub mod blobstore;
pub mod schema;
pub mod store;

pub use blobstore::BlobStore;
pub use store::RunLog;

#[derive(Debug, thiserror::Error)]
pub enum RunLogError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("blob not found: {0}")]
    BlobNotFound(String),
    #[error("malformed blob ref: {0}")]
    BadBlobRef(String),
    #[error("seq gap in run {run_id}: expected {expected}, got {got}")]
    SeqGap {
        run_id: String,
        expected: u64,
        got: u64,
    },
}
