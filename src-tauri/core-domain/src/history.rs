//! 命令历史的纯规则：什么算一行、重复怎么合并、检索怎么排序、跨天锚点怎么算。
//!
//! 落盘在 `src-tauri/src/history.rs`（`history.db`）；这里只有内存模型与判定，
//! 因此可以被单元测试直接驱动（L0-18），也用于库打不开时的降级模式。
//!
//! 时间一律是 **UTC 毫秒**；任何「今天/昨天」的判断都必须带上调用方给的本地时区偏移，
//! 规则本身不去读系统时区（测试要能注入固定时区，见 L0-09）。

/// 每个会话最多保留多少条命令。超出后从最久未用的开始丢。
pub const HISTORY_CAP: usize = 10_000;

/// 前端热缓存 / 附着快照的最大条数。逐键 Ghost Text 只在这个窗口内匹配。
pub const HISTORY_WINDOW: usize = 5_000;

/// 一条命令历史。`id` 是会话内的单调序号（等于「第几次提交」），
/// 同一条命令再次执行时换成新的 `id` 挪到最新，`use_count` 累加。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: i64,
    pub command: String,
    /// 最后一次执行的时刻，UTC 毫秒
    pub used_ms: u64,
    pub use_count: u32,
}

/// 把一次提交的原始字节变成要记的命令：
/// 去掉结尾的回车/换行；全空白返回 `None`（空白行不记）。
pub fn normalize(data: &str) -> Option<String> {
    let line = data.trim_end_matches(['\r', '\n']);
    if line.trim().is_empty() {
        return None;
    }
    Some(line.to_string())
}

/// 纯内存的历史模型。语义与 `history.db` 完全一致：
/// - 去重键是原文，重复执行只留一行并挪到最新（`id` 递增）、次数累加；
/// - 每会话封顶 `HISTORY_CAP`；
/// - 清空只作用于这个模型（一个模型 == 一个会话）；
/// - `id` 只增不减，清空后继续往上走（前端据此判断缺口）。
#[derive(Debug, Clone)]
pub struct Log {
    entries: Vec<Entry>,
    next_id: i64,
    cap: usize,
}

impl Log {
    pub fn new() -> Self {
        Self::with_capacity(HISTORY_CAP)
    }

    pub fn with_capacity(cap: usize) -> Self {
        Self {
            entries: Vec::new(),
            next_id: 1,
            cap: cap.max(1),
        }
    }

    /// 按 `id` 从小到大（最旧 → 最新）。`snapshot` 与 ↑↓ 都靠这个顺序。
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 记一条命令。返回新条目；空白行返回 `None`。
    pub fn record(&mut self, command: &str, used_ms: u64) -> Option<Entry> {
        let command = normalize(command)?;
        let previous = self
            .entries
            .iter()
            .position(|entry| entry.command == command);
        let use_count = match previous {
            Some(index) => {
                let old = self.entries.remove(index);
                old.use_count.saturating_add(1)
            }
            None => 1,
        };
        let entry = Entry {
            id: self.next_id,
            command,
            used_ms,
            use_count,
        };
        self.next_id = self.next_id.saturating_add(1);
        self.entries.push(entry.clone());
        self.trim();
        Some(entry)
    }

    /// 清空命令，但序号继续递增：清空之后的新条目 id 仍然比旧的大。
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// 当前「下一个 id」；快照的 `upto_id` = 这个值减一。
    pub fn next_id(&self) -> i64 {
        self.next_id
    }

    fn trim(&mut self) {
        while self.entries.len() > self.cap {
            self.entries.remove(0);
        }
    }
}

impl Default for Log {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- 检索 ----------

/// 查询里出现大写字母就区分大小写；否则一律不区分。
/// 这样 `git` 能命中 `Git status`，而 `Git` 只命中原文含 `Git` 的。
pub fn is_case_sensitive(query: &str) -> bool {
    query.chars().any(char::is_uppercase)
}

/// 子串匹配。`to_lowercase` 处理非 ASCII 的大小写（例如 `Ä`），不追求完整 Unicode casefold。
pub fn matches(command: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    if is_case_sensitive(query) {
        command.contains(query)
    } else {
        command.to_lowercase().contains(&query.to_lowercase())
    }
}

/// 检索结果：命中子串，按最后使用时间倒序（同一时刻按 id 倒序）。
/// 全量最多 10k 条，逐条比较即可，不需要索引结构。
pub fn search<'a>(entries: &'a [Entry], query: &str) -> Vec<&'a Entry> {
    let mut hits: Vec<&Entry> = entries
        .iter()
        .filter(|entry| matches(&entry.command, query))
        .collect();
    hits.sort_by(|a, b| b.used_ms.cmp(&a.used_ms).then_with(|| b.id.cmp(&a.id)));
    hits
}

// ---------- 时间戳锚点（L0-09） ----------

const MS_PER_DAY: i64 = 86_400_000;

/// UTC 毫秒 → 指定时区下的本地日期 `YYYY-MM-DD`。
///
/// `offset_minutes` 是本地时区相对 UTC 的偏移（东八区 = 480）。测试注入固定值，
/// 生产由前端用 `Date` 取当前时区；规则本身不读系统时区。
pub fn local_day(ms: u64, offset_minutes: i32) -> String {
    let local_ms = (ms as i64).saturating_add(offset_minutes as i64 * 60_000);
    let (year, month, day) = civil_from_days(local_ms.div_euclid(MS_PER_DAY));
    format!("{year:04}-{month:02}-{day:02}")
}

/// 为「按时间倒序」的检索结果逐个算出锚点：本地日期变化时给出这一天的日期，
/// 与上一条同日则给 `None`。第一条永远带锚点（列表开头需要一个日期）。
pub fn day_anchors(entries: &[Entry], offset_minutes: i32) -> Vec<Option<String>> {
    let mut out = Vec::with_capacity(entries.len());
    let mut previous: Option<String> = None;
    for entry in entries {
        let day = local_day(entry.used_ms, offset_minutes);
        if previous.as_deref() == Some(day.as_str()) {
            out.push(None);
        } else {
            out.push(Some(day.clone()));
            previous = Some(day);
        }
    }
    out
}

/// Howard Hinnant 的 `civil_from_days`：天数（1970-01-01 为 0）→ 公历年月日。
/// 先算日期再格式化，避开闰年与月份长度的分支表。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commands(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|e| e.command.as_str()).collect()
    }

    fn entry(id: i64, command: &str, used_ms: u64, use_count: u32) -> Entry {
        Entry {
            id,
            command: command.to_string(),
            used_ms,
            use_count,
        }
    }

    #[test]
    fn normalize_strips_only_trailing_line_endings() {
        assert_eq!(normalize("echo hi\r").as_deref(), Some("echo hi"));
        assert_eq!(normalize("a\r\nb\n").as_deref(), Some("a\r\nb"));
        assert_eq!(normalize("\r"), None);
        assert_eq!(normalize("   \r\n"), None);
        assert_eq!(normalize(""), None);
    }

    #[test]
    fn repeated_command_moves_to_latest_and_counts() {
        // L0-18：去重挪到最新并累加次数
        let mut log = Log::new();
        let first = log.record("git status\r", 100).unwrap();
        assert_eq!((first.id, first.use_count), (1, 1));
        let second = log.record("ls\r", 200).unwrap();
        assert_eq!(second.id, 2);
        let again = log.record("git status\r", 300).unwrap();
        assert_eq!(again.id, 3);
        assert_eq!(again.use_count, 2);
        assert_eq!(commands(log.entries()), vec!["ls", "git status"]);
        assert_eq!(log.entries()[1].used_ms, 300);
    }

    #[test]
    fn blank_lines_are_not_recorded_and_do_not_consume_ids() {
        let mut log = Log::new();
        assert!(log.record("\r", 1).is_none());
        assert!(log.record("  \r\n", 2).is_none());
        assert_eq!(log.next_id(), 1);
        assert_eq!(log.record("dir\r", 3).unwrap().id, 1);
    }

    #[test]
    fn cap_drops_the_oldest_and_stops_at_capacity() {
        // L0-18：10k 封顶（用 3 条演示同一规则）
        let mut log = Log::with_capacity(3);
        for (index, cmd) in ["a", "b", "c", "d"].iter().enumerate() {
            log.record(cmd, index as u64);
        }
        assert_eq!(commands(log.entries()), vec!["b", "c", "d"]);
        assert_eq!(log.len(), 3);
    }

    #[test]
    fn re_recording_an_entry_at_capacity_does_not_drop_another() {
        let mut log = Log::with_capacity(2);
        log.record("a", 1);
        log.record("b", 2);
        log.record("a", 3);
        assert_eq!(commands(log.entries()), vec!["b", "a"]);
        assert_eq!(log.len(), 2);
    }

    #[test]
    fn sessions_are_isolated_and_clear_touches_one_session() {
        // L0-18：会话隔离；清空只作用当前会话
        let mut a = Log::new();
        let mut b = Log::new();
        a.record("one", 1);
        a.record("two", 2);
        b.record("other", 3);

        a.clear();
        assert!(a.is_empty());
        assert_eq!(commands(b.entries()), vec!["other"]);
        // 序号不因清空回退：新条目仍然比旧的 id 大
        assert_eq!(a.next_id(), 3);
        assert_eq!(a.record("three", 4).unwrap().id, 3);
    }

    #[test]
    fn search_is_case_insensitive_until_the_query_has_uppercase() {
        let query_lower = "git";
        assert!(matches("Git status", query_lower));
        assert!(matches("GIT PUSH", query_lower));
        assert!(matches("GitHub", "Git"));
        assert!(!matches("git", "Git"));
        assert!(!matches("git status", "Git"));
        assert!(!matches("git status", "GIT"));
        assert!(matches("anything", ""));
    }

    #[test]
    fn search_sorts_by_last_use_descending() {
        let entries = vec![
            entry(1, "ls", 100, 3),
            entry(2, "git status", 300, 1),
            entry(3, "git log", 200, 5),
        ];
        let hits = search(&entries, "git");
        let names: Vec<&str> = hits.iter().map(|e| e.command.as_str()).collect();
        assert_eq!(names, vec!["git status", "git log"]);
        // 子串出现在中间也算命中
        let hits = search(&entries, "tus");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, 2);
    }

    #[test]
    fn local_day_uses_the_injected_timezone() {
        // 2026-11-16T16:30:00Z
        let ms = 1_794_846_600_000u64;
        assert_eq!(local_day(ms, 0), "2026-11-16");
        // 东八区已经跨到 17 日 00:30
        assert_eq!(local_day(ms, 480), "2026-11-17");
        // 西五区还在 16 日 11:30
        assert_eq!(local_day(ms, -300), "2026-11-16");
    }

    #[test]
    fn day_anchors_insert_only_when_the_local_day_changes() {
        // L0-09：跨天插一行、同日不插、按注入的本地时区判断
        let day1 = 1_794_700_800_000u64; // 2026-11-15T00:00:00Z
        let entries = vec![
            entry(1, "newest", day1 + 22 * 3_600_000, 1), // 15 日 22:00Z = 16 日 06:00 (+8)
            entry(2, "same-day", day1 + 20 * 3_600_000, 1), // 15 日 20:00Z = 16 日 04:00 (+8)
            entry(3, "yesterday", day1 + 10 * 3_600_000, 1), // 15 日 10:00Z = 15 日 18:00 (+8)
        ];
        let anchors = day_anchors(&entries, 480);
        assert_eq!(anchors[0].as_deref(), Some("2026-11-16"));
        assert_eq!(anchors[1], None);
        assert_eq!(anchors[2].as_deref(), Some("2026-11-15"));

        // 换一个时区，第一条就落到 15 日，和第二条同日
        let anchors = day_anchors(&entries, 0);
        assert_eq!(anchors[0].as_deref(), Some("2026-11-15"));
        assert_eq!(anchors[1], None);
        assert_eq!(anchors[2], None);
    }

    #[test]
    fn day_anchor_handles_month_and_year_boundaries() {
        // 2026-12-31T23:30:00Z；东八区已是 2027-01-01
        let ms = 1_798_759_800_000u64;
        assert_eq!(local_day(ms, 0), "2026-12-31");
        assert_eq!(local_day(ms, 480), "2027-01-01");
        // 闰年 2 月 29 日
        assert_eq!(local_day(1_709_164_800_000, 0), "2024-02-29");
        assert_eq!(local_day(1_794_846_600_000, 480), "2026-11-17");
    }
}
