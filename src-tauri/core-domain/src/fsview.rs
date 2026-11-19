//! 文件面板的纯规则：条目模型、排序、隐藏过滤、截断与路径归一化。
//!
//! 这里不碰文件系统：读目录、取大小/时间、判 Windows 隐藏属性都在 `src-tauri`。
//! 本模块只吃「已经读到的数据」，因此能在 L0 用普通单元测试驱动。

/// 一次列目录最多返回多少条。面板是给人翻的，几千条之后既没人看也拖慢渲染。
/// 超出只截断显示，不改变磁盘上的任何东西，`Listing::truncated` 会告诉调用方。
pub const MAX_ENTRIES: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Dir,
    File,
    /// 读取失败、设备、管道等：显示出来，但不可进入
    Other,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EntryKind::Dir => "dir",
            EntryKind::File => "file",
            EntryKind::Other => "other",
        }
    }

    pub fn is_dir(self) -> bool {
        matches!(self, EntryKind::Dir)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    /// 链接按目标判定（指向目录就可以进入）；是否链接单独记在 `link` 上
    pub kind: EntryKind,
    pub link: bool,
    /// 只有普通文件有意义，目录与其它一律 0
    pub size: u64,
    /// UTC 毫秒；取不到时间（文件系统不支持）时为 `None`
    pub modified_ms: Option<i64>,
    /// UTC 毫秒；文件系统不提供创建时间时为 `None`
    pub created_ms: Option<i64>,
    /// 以 `.` 开头或 Windows 隐藏属性
    pub hidden: bool,
}

impl Entry {
    pub fn new(name: impl Into<String>, kind: EntryKind) -> Self {
        let name = name.into();
        let hidden = is_hidden(&name);
        Self {
            name,
            kind,
            link: false,
            size: 0,
            modified_ms: None,
            created_ms: None,
            hidden,
        }
    }
}

/// 一次列目录的结果。`path`/`parent` 都是归一化之后的显示形式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub path: String,
    /// 已经是根（`C:\`、`\\server\share`、`` `\``）时为 `None`
    pub parent: Option<String>,
    /// 过滤与截断之后真正返回的条目
    pub entries: Vec<Entry>,
    /// 过滤前（含隐藏项）的条目数
    pub total: usize,
    pub hidden_count: usize,
    /// 条目数超过上限，`entries` 只是前一段
    pub truncated: bool,
}

/// 以 `.` 开头的名字算隐藏。Windows 的隐藏属性由调用方直接写进 `Entry::hidden`。
pub fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// 目录在前，然后按名字做大小写不敏感的字典序；完全相同再比原名，保证顺序确定。
pub fn sort_entries(entries: &mut [Entry]) {
    entries.sort_by(|a, b| {
        b.kind
            .is_dir()
            .cmp(&a.kind.is_dir())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// 过滤 → 排序 → 截断。`limit` 为 0 表示一条都不返回（调用方通常传 [`MAX_ENTRIES`]）。
pub fn build_listing(path: &str, entries: Vec<Entry>, show_hidden: bool, limit: usize) -> Listing {
    let total = entries.len();
    let hidden_count = entries.iter().filter(|entry| entry.hidden).count();
    let mut kept: Vec<Entry> = entries
        .into_iter()
        .filter(|entry| show_hidden || !entry.hidden)
        .collect();
    sort_entries(&mut kept);
    let truncated = kept.len() > limit;
    kept.truncate(limit);
    Listing {
        path: normalize(path),
        parent: parent_of(path),
        entries: kept,
        total,
        hidden_count,
        truncated,
    }
}

/// 统一分隔符、折叠重复分隔符、去掉 `.` 段与末尾分隔符。
///
/// 保留盘符根（`C:\`）、UNC 前缀（`\\server\share`）与根相对路径的前导 `\`；
/// **不解析 `..`**：面板的导航只走 [`child_of`] 与 [`parent_of`]，永远不会自己造出 `..`，
/// 而把 `..` 折掉会让「显示的是什么」与「系统解析出什么」产生分歧。
pub fn normalize(path: &str) -> String {
    let path = path.trim();
    if path.is_empty() {
        return String::new();
    }

    let unified = path.replace('/', "\\");
    let unc = unified.starts_with("\\\\");
    let rooted = !unc && unified.starts_with('\\');

    let segments: Vec<&str> = unified
        .split('\\')
        // 开头那段在绝对路径里是空的，UNC 的前两段也是
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();

    let mut out = String::new();
    if unc {
        out.push_str("\\\\");
    } else if rooted {
        out.push('\\');
    }

    let mut start = 0;
    if !unc {
        if let Some(first) = segments.first() {
            if is_drive(first) {
                out.push_str(first);
                out.push('\\');
                start = 1;
            }
        }
    }

    for (index, segment) in segments[start..].iter().enumerate() {
        if index > 0 {
            out.push('\\');
        }
        out.push_str(segment);
    }
    out
}

fn is_drive(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    bytes.len() == 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

/// `C:\` 这种盘符根：normalize 之后固定是三字节，且以分隔符结尾。
fn is_drive_root(path: &str) -> bool {
    path.len() == 3 && path.ends_with('\\') && is_drive(&path[..2])
}

/// 上一级目录。根返回 `None`。相对路径的父是去掉最后一段后的相对路径。
pub fn parent_of(path: &str) -> Option<String> {
    let path = normalize(path);
    if path.is_empty() || path == "\\" {
        return None;
    }

    let unc = path.starts_with("\\\\");
    if !unc && is_drive_root(&path) {
        // `C:\` 已经是根
        return None;
    }

    let separator = path.rfind('\\')?;
    let parent = &path[..separator];
    if parent.is_empty() {
        return None;
    }
    if parent.len() == 2 && is_drive(parent) {
        return Some(format!("{parent}\\"));
    }
    if unc && unc_segments(parent) < 2 {
        // `\\server` 不是完整的 UNC 根，再往上就没有了
        return None;
    }
    Some(parent.to_string())
}

fn unc_segments(path: &str) -> usize {
    path.trim_start_matches('\\')
        .split('\\')
        .filter(|segment| !segment.is_empty())
        .count()
}

/// 进入子项：父路径为空时直接用名字；父以分隔符结尾时不再补一个。
pub fn child_of(parent: &str, name: &str) -> String {
    let base = normalize(parent);
    let name = name.trim_matches('\\');
    if base.is_empty() {
        return name.to_string();
    }
    if base.ends_with('\\') {
        format!("{base}{name}")
    } else {
        format!("{base}\\{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, kind: EntryKind) -> Entry {
        Entry::new(name, kind)
    }

    fn names(listing: &Listing) -> Vec<&str> {
        listing.entries.iter().map(|entry| entry.name.as_str()).collect()
    }

    #[test]
    fn dot_names_are_hidden_but_windows_attributes_are_separate() {
        assert!(is_hidden(".git"));
        assert!(is_hidden("."));
        assert!(!is_hidden("git"));
        let mut hidden = entry("desktop.ini", EntryKind::File);
        hidden.hidden = true; // Windows 隐藏属性由后端写进来
        assert!(hidden.hidden);
    }

    #[test]
    fn directories_come_first_then_case_insensitive_names() {
        let mut entries = vec![
            entry("zebra.txt", EntryKind::File),
            entry("Alpha", EntryKind::File),
            entry("beta", EntryKind::Dir),
            entry("apple.txt", EntryKind::File),
        ];
        sort_entries(&mut entries);
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["beta", "Alpha", "apple.txt", "zebra.txt"]);
    }

    #[test]
    fn names_differing_only_in_case_keep_a_stable_order() {
        let mut entries = vec![entry("readme", EntryKind::File), entry("README", EntryKind::File)];
        sort_entries(&mut entries);
        // 小写相同，按原名排：`README` 在上
        assert_eq!(entries[0].name, "README");
        assert_eq!(entries[1].name, "readme");
    }

    #[test]
    fn hidden_entries_are_counted_even_when_filtered_out() {
        let entries = vec![
            entry(".git", EntryKind::Dir),
            entry(".env", EntryKind::File),
            entry("src", EntryKind::Dir),
        ];
        let listing = build_listing("C:\\work", entries.clone(), false, MAX_ENTRIES);
        assert_eq!(names(&listing), vec!["src"]);
        assert_eq!(listing.total, 3);
        assert_eq!(listing.hidden_count, 2);
        assert!(!listing.truncated);

        let all = build_listing("C:\\work", entries, true, MAX_ENTRIES);
        assert_eq!(names(&all), vec![".git", "src", ".env"]);
        assert_eq!(all.hidden_count, 2);
    }

    #[test]
    fn limit_truncates_after_sorting_and_reports_it() {
        let entries = vec![
            entry("b.txt", EntryKind::File),
            entry("a.txt", EntryKind::File),
            entry("dir", EntryKind::Dir),
        ];
        let listing = build_listing("C:\\work", entries, true, 2);
        assert_eq!(names(&listing), vec!["dir", "a.txt"]);
        assert!(listing.truncated);
        assert_eq!(listing.total, 3);

        let empty = build_listing("C:\\work", Vec::new(), true, 0);
        assert!(!empty.truncated);
        assert!(empty.entries.is_empty());
    }

    #[test]
    fn normalize_folds_separators_and_dots_but_keeps_roots() {
        assert_eq!(normalize(""), "");
        assert_eq!(normalize("  "), "");
        assert_eq!(normalize("C:/work/./src/"), "C:\\work\\src");
        assert_eq!(normalize("C:\\\\work\\\\"), "C:\\work");
        assert_eq!(normalize("C:\\"), "C:\\");
        assert_eq!(normalize("C:"), "C:\\");
        assert_eq!(normalize("\\\\server\\share\\dir\\"), "\\\\server\\share\\dir");
        assert_eq!(normalize("\\\\server\\share"), "\\\\server\\share");
        assert_eq!(normalize("\\Windows\\"), "\\Windows");
        // 不折 `..`：显示与实际解析保持一致
        assert_eq!(normalize("C:\\work\\..\\tmp"), "C:\\work\\..\\tmp");
    }

    #[test]
    fn parent_of_stops_at_drive_and_unc_roots() {
        assert_eq!(parent_of("C:\\"), None);
        assert_eq!(parent_of("C:\\work"), Some("C:\\".to_string()));
        assert_eq!(parent_of("C:\\work\\src\\"), Some("C:\\work".to_string()));
        assert_eq!(parent_of("\\\\server\\share"), None);
        assert_eq!(parent_of("\\\\server\\share\\dir"), Some("\\\\server\\share".to_string()));
        assert_eq!(
            parent_of("\\\\server\\share\\dir\\deep"),
            Some("\\\\server\\share\\dir".to_string())
        );
        assert_eq!(parent_of("work\\src"), Some("work".to_string()));
        assert_eq!(parent_of("work"), None);
        assert_eq!(parent_of(""), None);
    }

    #[test]
    fn child_of_never_doubles_the_separator() {
        assert_eq!(child_of("C:\\", "work"), "C:\\work");
        assert_eq!(child_of("C:\\work", "src"), "C:\\work\\src");
        assert_eq!(child_of("C:/work/", "src"), "C:\\work\\src");
        assert_eq!(child_of("", "C:\\work"), "C:\\work");
        assert_eq!(child_of("\\\\server\\share", "dir"), "\\\\server\\share\\dir");
    }

    #[test]
    fn listing_path_and_parent_are_normalized() {
        let listing = build_listing("C:/work/", Vec::new(), true, MAX_ENTRIES);
        assert_eq!(listing.path, "C:\\work");
        assert_eq!(listing.parent, Some("C:\\".to_string()));
    }
}
