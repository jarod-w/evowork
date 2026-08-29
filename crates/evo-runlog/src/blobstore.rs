use crate::RunLogError;
use evo_protocol::{BlobClass, BlobRef};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// 文件系统 + content-addressed（Q-03）。blobs 表只做索引与保留期，内容在这里。
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub fn open(root: &Path) -> Result<Self, RunLogError> {
        fs::create_dir_all(root)?;
        Ok(Self {
            root: root.to_path_buf(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 落一份内容，返回引用。内容相同则复用同一份文件。
    ///
    /// `class` 目前只进 blobs 索引表（Task 5），不影响落盘路径——
    /// Phase 3 要「事件表上云、blob 留本地」，切分在目录级，不在 class 级。
    pub fn put(&self, _class: BlobClass, mime: &str, bytes: &[u8]) -> Result<BlobRef, RunLogError> {
        let hex_digest = hex::encode(Sha256::digest(bytes));
        let path = self.path_of_hex(&hex_digest);
        if !path.exists() {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            // 先写临时文件再 rename：同名 blob 并发写入时不会读到半截内容
            let tmp = path.with_extension("tmp");
            fs::write(&tmp, bytes)?;
            fs::rename(&tmp, &path)?;
        }
        Ok(BlobRef {
            content_hash: format!("sha256:{hex_digest}"),
            size: bytes.len() as u64,
            mime: mime.to_owned(),
        })
    }

    pub fn get(&self, r: &BlobRef) -> Result<Vec<u8>, RunLogError> {
        let path = self.path_of(&r.content_hash)?;
        fs::read(&path).map_err(|_| RunLogError::BlobNotFound(r.content_hash.clone()))
    }

    pub fn path_of(&self, content_hash: &str) -> Result<PathBuf, RunLogError> {
        let hex_digest = content_hash
            .strip_prefix("sha256:")
            .ok_or_else(|| RunLogError::BadBlobRef(content_hash.to_owned()))?;
        if hex_digest.len() < 4 {
            return Err(RunLogError::BadBlobRef(content_hash.to_owned()));
        }
        Ok(self.path_of_hex(hex_digest))
    }

    fn path_of_hex(&self, hex_digest: &str) -> PathBuf {
        self.root
            .join(&hex_digest[0..2])
            .join(&hex_digest[2..4])
            .join(hex_digest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use evo_protocol::BlobClass;

    #[test]
    fn put_then_get_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let r = store
            .put(BlobClass::Content, "text/plain", b"hello")
            .unwrap();
        assert_eq!(store.get(&r).unwrap(), b"hello");
        assert_eq!(r.size, 5);
        assert_eq!(r.mime, "text/plain");
    }

    #[test]
    fn same_content_gives_the_same_hash_and_is_written_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let a = store
            .put(BlobClass::Content, "text/plain", b"same")
            .unwrap();
        let b = store
            .put(BlobClass::Content, "text/plain", b"same")
            .unwrap();
        assert_eq!(a.content_hash, b.content_hash);
    }

    #[test]
    fn layout_is_two_by_two_fanout() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let r = store.put(BlobClass::Content, "text/plain", b"x").unwrap();
        let hex = r.content_hash.strip_prefix("sha256:").unwrap();
        let expected = dir.path().join(&hex[0..2]).join(&hex[2..4]).join(hex);
        assert!(expected.exists(), "blob 应落在 <h[0:2]>/<h[2:4]>/<h>");
    }

    #[test]
    fn missing_blob_reports_the_hash_it_looked_for() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let bogus = BlobRef {
            content_hash: format!("sha256:00{}", "ab".repeat(31)),
            size: 1,
            mime: "text/plain".into(),
        };
        let err = store.get(&bogus).unwrap_err().to_string();
        assert!(err.contains("sha256:"), "错误信息里要带上找不到的 hash");
    }
}
