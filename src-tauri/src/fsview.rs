//! 读目录：把 `std::fs` 的结果装进 `core_domain::fsview` 的条目模型。
//!
//! 排序、隐藏过滤、截断、路径归一化都在 core-domain：同一套规则只有一份实现，
//! 这里只负责「把磁盘上发生了什么如实填进结构体」。

use core_domain::fsview::{self as rules, Entry, EntryKind, Listing};
use std::path::Path;
use std::time::UNIX_EPOCH;

/// 列出 `path` 的一层内容。单个条目读失败只跳过它，不让整次列目录失败。
pub fn list(path: &Path, show_hidden: bool) -> Result<Listing, String> {
    if path.is_file() {
        return Err(format!("不是目录: {}", path.display()));
    }
    let reader = std::fs::read_dir(path).map_err(|err| describe(path, &err))?;
    let mut entries = Vec::new();
    for item in reader {
        if let Ok(item) = item {
            entries.push(read_entry(&item));
        }
    }
    Ok(rules::build_listing(
        &path.display().to_string(),
        entries,
        show_hidden,
        rules::MAX_ENTRIES,
    ))
}

fn read_entry(item: &std::fs::DirEntry) -> Entry {
    // 文件名不是 UTF-8 时用有损转换：显示出来比整条丢掉有用，反正只是只读展示
    let name = item.file_name().to_string_lossy().into_owned();
    let path = item.path();
    let link = std::fs::symlink_metadata(&path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);

    // 跟随链接判断目标类型：指向目录的链接应该能进去
    let meta = std::fs::metadata(&path).ok();
    let kind = match &meta {
        Some(meta) if meta.is_dir() => EntryKind::Dir,
        Some(meta) if meta.is_file() => EntryKind::File,
        _ => EntryKind::Other,
    };

    let mut entry = Entry::new(name, kind);
    entry.link = link;
    if let Some(meta) = meta {
        if kind == EntryKind::File {
            entry.size = meta.len();
        }
        entry.modified_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as i64);
        entry.created_ms = meta
            .created()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as i64);

        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            // FILE_ATTRIBUTE_HIDDEN：`desktop.ini` 这类不以点开头的隐藏项
            if meta.file_attributes() & 0x2 != 0 {
                entry.hidden = true;
            }
        }
    }
    entry
}

fn describe(path: &Path, err: &std::io::Error) -> String {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::NotFound => format!("目录不存在: {}", path.display()),
        ErrorKind::PermissionDenied => format!("没有访问权限: {}", path.display()),
        _ => format!("读取目录失败: {}（{err}）", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// 临时目录守卫：测试失败也要删掉，绝不留在用户的 temp 里越积越多。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("pinshell-fsview-{tag}-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_directories_first_and_skips_dot_files_by_default() {
        let dir = TempDir::new("basic");
        fs::create_dir(dir.path().join("z_dir")).unwrap();
        fs::write(dir.path().join("b.txt"), b"hello").unwrap();
        fs::write(dir.path().join(".hidden"), b"x").unwrap();

        let listing = list(dir.path(), false).expect("list");
        let names: Vec<&str> = listing
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["z_dir", "b.txt"]);
        assert_eq!(listing.total, 3);
        assert_eq!(listing.hidden_count, 1);
        assert!(!listing.truncated);
        assert!(!listing.entries[1].link);

        let file = listing
            .entries
            .iter()
            .find(|entry| entry.name == "b.txt")
            .unwrap();
        assert_eq!(file.kind, EntryKind::File);
        assert_eq!(file.size, 5);
        assert!(file.modified_ms.is_some());
        assert!(listing.entries[0].kind.is_dir());
        assert_eq!(
            listing.parent,
            rules::parent_of(&dir.path().display().to_string())
        );
    }

    #[test]
    fn show_hidden_brings_dot_files_back() {
        let dir = TempDir::new("hidden");
        fs::write(dir.path().join(".env"), b"X=1").unwrap();
        fs::write(dir.path().join("readme.md"), b"#").unwrap();

        let listing = list(dir.path(), true).expect("list");
        let names: Vec<&str> = listing
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec![".env", "readme.md"]);
        assert_eq!(listing.hidden_count, 1);
    }

    #[test]
    fn a_missing_path_and_a_file_are_reported_in_plain_language() {
        let dir = TempDir::new("errors");
        let missing = dir.path().join("nope");
        let err = list(&missing, false).unwrap_err();
        assert!(err.contains("目录不存在"), "{err}");

        let file = dir.path().join("plain.txt");
        fs::write(&file, b"x").unwrap();
        let err = list(&file, false).unwrap_err();
        assert!(err.contains("不是目录"), "{err}");
    }
}
