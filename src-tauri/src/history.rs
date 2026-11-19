//! 命令历史的落盘：`history.db`（SQLite、WAL、单写线程），以及库不可用时的内存降级。
//!
//! 规则（去重、次数、封顶、检索排序、时间锚点）全在 `core_domain::history`；这里只做持久化：
//! - 一条命令一行，`rev` 是这个会话的「第几次提交」，再次执行时换成新的 `rev` 挪到最新，
//!   所以 `history:append` 的 `rev` 在会话内严格递增且连续，前端可以据此判缺口；
//! - 先发 PTY、再把写入排进单写线程，写库失败不阻塞输入；
//! - 库打不开或损坏：改名为 `history.db.corrupt-<时间>` 后重建空库；再失败就本次运行只用内存，
//!   并只发一次 `history:degraded`。

use core_domain::history::{normalize, Entry, Log, HISTORY_CAP, HISTORY_WINDOW};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};

pub const HISTORY_FILE: &str = "history.db";
pub const CORRUPT_PREFIX: &str = "history.db.corrupt-";

/// 前端消费的历史条目。字段就是前端缓存契约（L2-02）里的一份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HistoryItem {
    /// 会话内单调序号（第几次提交），不是数据库行号
    pub id: i64,
    pub command: String,
    /// UTC 毫秒
    pub used_ms: u64,
    pub use_count: u32,
}

impl From<Entry> for HistoryItem {
    fn from(entry: Entry) -> Self {
        Self {
            id: entry.id,
            command: entry.command,
            used_ms: entry.used_ms,
            use_count: entry.use_count,
        }
    }
}

#[derive(Clone, Serialize)]
struct AppendPayload {
    session_id: String,
    item: HistoryItem,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS history (
    session_id TEXT NOT NULL,
    rev        INTEGER NOT NULL,
    command    TEXT NOT NULL,
    used_ms    INTEGER NOT NULL,
    use_count  INTEGER NOT NULL,
    PRIMARY KEY (session_id, rev)
);
CREATE UNIQUE INDEX IF NOT EXISTS history_by_command ON history(session_id, command);
CREATE TABLE IF NOT EXISTS history_meta (
    session_id TEXT PRIMARY KEY,
    next_rev   INTEGER NOT NULL
);
";

// ---------- 单写线程的存储本体 ----------

pub struct Store {
    conn: Option<Connection>,
    /// 库不可用时的纯内存副本，语义与库一致（每个会话一个 `Log`）
    memory: HashMap<String, Log>,
    path: PathBuf,
    cap: usize,
    /// 本次运行是否已经降级（写失败或一开始就打不开）
    pub degraded: bool,
    /// 损坏库被改名到的位置，启动时打印出来给用户看
    pub recovered: Option<PathBuf>,
}

impl Store {
    pub fn open(path: PathBuf) -> Self {
        Self::open_with_cap(path, HISTORY_CAP)
    }

    fn open_with_cap(path: PathBuf, cap: usize) -> Self {
        match open_db(&path) {
            Ok(conn) => {
                return Self {
                    conn: Some(conn),
                    memory: HashMap::new(),
                    path,
                    cap,
                    degraded: false,
                    recovered: None,
                }
            }
            Err(err) => eprintln!("[data] history open failed: {err}"),
        }

        let recovered = quarantine(&path);
        match &recovered {
            Some(dest) => println!("[data] history.db unreadable, moved to {}", dest.display()),
            None => eprintln!("[data] history.db unreadable and could not be renamed"),
        }

        match open_db(&path) {
            Ok(conn) => Self {
                conn: Some(conn),
                memory: HashMap::new(),
                path,
                cap,
                degraded: false,
                recovered,
            },
            Err(err) => {
                eprintln!("[data] history unavailable this run (memory only): {err}");
                Self {
                    conn: None,
                    memory: HashMap::new(),
                    path,
                    cap,
                    degraded: true,
                    recovered,
                }
            }
        }
    }

    /// 没有数据目录时直接用内存模式：功能在，重启后不留。
    pub fn memory_only(path: PathBuf) -> Self {
        Self {
            conn: None,
            memory: HashMap::new(),
            path,
            cap: HISTORY_CAP,
            degraded: true,
            recovered: None,
        }
    }

    /// 记一条命令。空白行不记。写库失败会降级为内存并返回 `true` 之外的副作用
    /// （调用方看 `degraded` 是否刚变）。
    pub fn record(&mut self, session: &str, command: &str, used_ms: u64) -> Option<Entry> {
        let command = normalize(command)?;
        if let Some(conn) = self.conn.as_mut() {
            match sql_record(conn, session, &command, used_ms, self.cap) {
                Ok(entry) => return Some(entry),
                Err(err) => {
                    eprintln!("[data] history write failed, memory only this run: {err}");
                    self.conn = None;
                    self.degraded = true;
                }
            }
        }
        self.memory
            .entry(session.to_string())
            .or_default()
            .record(&command, used_ms)
    }

    /// 最近 `limit` 条（按 id 升序，最后一条最新）与 `upto_id`（当前最大 id）。
    pub fn snapshot(&self, session: &str, limit: usize) -> (Vec<Entry>, i64) {
        if let Some(conn) = self.conn.as_ref() {
            match sql_snapshot(conn, session, limit) {
                Ok(snapshot) => return snapshot,
                // 读失败不降级：写路径才是数据来源，前端缓存还能撑住这一帧
                Err(err) => eprintln!("[data] history snapshot: {err}"),
            }
        }
        let log = self.memory.get(session);
        let (items, next) = match log {
            Some(log) => (log.entries().to_vec(), log.next_id()),
            None => (Vec::new(), 1),
        };
        let start = items.len().saturating_sub(limit);
        (items[start..].to_vec(), next - 1)
    }

    /// 全量检索（最多 `cap` 条），排序规则在 core-domain。
    pub fn search(&self, session: &str, query: &str) -> Vec<Entry> {
        let all = if let Some(conn) = self.conn.as_ref() {
            match sql_all(conn, session) {
                Ok(items) => items,
                Err(err) => {
                    eprintln!("[data] history search: {err}");
                    Vec::new()
                }
            }
        } else {
            self.memory
                .get(session)
                .map(|log| log.entries().to_vec())
                .unwrap_or_default()
        };
        core_domain::history::search(&all, query)
            .into_iter()
            .cloned()
            .collect()
    }

    /// 清空本会话的命令。`next_rev` 保留，清空后新命令的 id 继续变大。
    pub fn clear(&mut self, session: &str) {
        if let Some(conn) = self.conn.as_ref() {
            if let Err(err) = conn.execute(
                "DELETE FROM history WHERE session_id = ?1",
                params![session],
            ) {
                eprintln!("[data] history clear {session}: {err}");
            }
            return;
        }
        if let Some(log) = self.memory.get_mut(session) {
            log.clear();
        }
    }

    /// 删除会话节点时连同历史一起销毁（I2）。
    pub fn delete_session(&mut self, session: &str) {
        if let Some(conn) = self.conn.as_ref() {
            let _ = conn.execute(
                "DELETE FROM history WHERE session_id = ?1",
                params![session],
            );
            let _ = conn.execute(
                "DELETE FROM history_meta WHERE session_id = ?1",
                params![session],
            );
            return;
        }
        self.memory.remove(session);
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

// ---------- SQL ----------

fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 2000;",
    )
    .map_err(|e| format!("pragmas: {e}"))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("schema: {e}"))?;

    // 半截写入或外部损坏：quick_check 是最便宜的整体校验
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| format!("integrity check: {e}"))?;
    if check != "ok" {
        return Err(format!("integrity check: {check}"));
    }
    Ok(conn)
}

/// 把坏库（连同 `-wal` / `-shm`）挪成 `history.db.corrupt-<UTC 毫秒>`。
/// 主文件改不掉就返回 `None`：这时只能内存运行，不能假装重建成功。
fn quarantine(path: &Path) -> Option<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = path.with_file_name(format!("{CORRUPT_PREFIX}{stamp}"));
    if !path.exists() {
        return None;
    }
    if let Err(err) = std::fs::rename(path, &dest) {
        eprintln!("[data] rename {}: {err}", path.display());
        return None;
    }
    for suffix in ["-wal", "-shm"] {
        let from = sidecar(path, suffix);
        if from.exists() {
            let _ = std::fs::rename(&from, sidecar(&dest, suffix));
        }
    }
    Some(dest)
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

fn sql_record(
    conn: &mut Connection,
    session: &str,
    command: &str,
    used_ms: u64,
    cap: usize,
) -> rusqlite::Result<Entry> {
    let tx = conn.transaction()?;

    let previous: Option<u32> = tx
        .query_row(
            "SELECT use_count FROM history WHERE session_id = ?1 AND command = ?2",
            params![session, command],
            |row| row.get(0),
        )
        .optional()?;
    let use_count = previous.unwrap_or(0).saturating_add(1);

    // 先取号、再删旧行、再插入：号只由 history_meta 决定，不会被删除影响
    let rev: i64 = tx.query_row(
        "SELECT COALESCE((SELECT next_rev FROM history_meta WHERE session_id = ?1), 1)",
        params![session],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO history_meta (session_id, next_rev) VALUES (?1, ?2)
         ON CONFLICT(session_id) DO UPDATE SET next_rev = excluded.next_rev",
        params![session, rev + 1],
    )?;
    tx.execute(
        "DELETE FROM history WHERE session_id = ?1 AND command = ?2",
        params![session, command],
    )?;
    tx.execute(
        "INSERT INTO history (session_id, rev, command, used_ms, use_count)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![session, rev, command, used_ms as i64, use_count],
    )?;
    // 每会话封顶：丢 rev 最小的（最久没执行过）那些
    tx.execute(
        "DELETE FROM history
         WHERE session_id = ?1
           AND rev NOT IN (
               SELECT rev FROM history WHERE session_id = ?1 ORDER BY rev DESC LIMIT ?2
           )",
        params![session, cap as i64],
    )?;
    tx.commit()?;

    Ok(Entry {
        id: rev,
        command: command.to_string(),
        used_ms,
        use_count,
    })
}

fn sql_snapshot(
    conn: &Connection,
    session: &str,
    limit: usize,
) -> rusqlite::Result<(Vec<Entry>, i64)> {
    let next_rev: i64 = conn.query_row(
        "SELECT COALESCE((SELECT next_rev FROM history_meta WHERE session_id = ?1), 1)",
        params![session],
        |row| row.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT rev, command, used_ms, use_count FROM history
         WHERE session_id = ?1 ORDER BY rev DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![session, limit as i64], |row| {
        Ok(Entry {
            id: row.get(0)?,
            command: row.get(1)?,
            used_ms: row.get::<_, i64>(2)? as u64,
            use_count: row.get(3)?,
        })
    })?;
    let mut items: Vec<Entry> = rows.collect::<rusqlite::Result<_>>()?;
    items.reverse(); // 升序：最后一条是最新
    Ok((items, next_rev - 1))
}

fn sql_all(conn: &Connection, session: &str) -> rusqlite::Result<Vec<Entry>> {
    let mut stmt = conn.prepare(
        "SELECT rev, command, used_ms, use_count FROM history
         WHERE session_id = ?1 ORDER BY rev",
    )?;
    let rows = stmt.query_map(params![session], |row| {
        Ok(Entry {
            id: row.get(0)?,
            command: row.get(1)?,
            used_ms: row.get::<_, i64>(2)? as u64,
            use_count: row.get(3)?,
        })
    })?;
    rows.collect()
}

// ---------- 对外句柄：所有操作排队给单写线程 ----------

enum Job {
    Record {
        session: String,
        command: String,
        used_ms: u64,
    },
    Snapshot {
        session: String,
        limit: usize,
        reply: Sender<(Vec<Entry>, i64)>,
    },
    Search {
        session: String,
        query: String,
        reply: Sender<Vec<Entry>>,
    },
    Clear {
        session: String,
    },
    DeleteSession {
        session: String,
    },
}

/// 历史库句柄。克隆开销只有 `Arc`；`Drop` 不等待写线程（进程退出时丢最后一条可接受）。
pub struct History {
    tx: Sender<Job>,
    path: PathBuf,
}

impl History {
    /// `dir == None`：没有可用数据目录，本次运行只用内存。
    pub fn open(dir: Option<&Path>, app: AppHandle) -> Arc<Self> {
        let path = dir
            .map(|d| d.join(HISTORY_FILE))
            .unwrap_or_else(|| PathBuf::from(HISTORY_FILE));
        let (tx, rx) = mpsc::channel();
        let thread_path = path.clone();
        let has_dir = dir.is_some();
        let spawned = thread::Builder::new()
            .name("history".into())
            .spawn(move || run(thread_path, has_dir, rx, app));
        if let Err(err) = spawned {
            eprintln!("[data] history thread failed: {err}");
        }
        Arc::new(Self { tx, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 不阻塞调用方：PTY 已经写过，落库排进队列即可。
    pub fn record(&self, session: &str, command: &str, used_ms: u64) {
        self.send(Job::Record {
            session: session.to_string(),
            command: command.to_string(),
            used_ms,
        });
    }

    /// 附着时取最近 `HISTORY_WINDOW` 条与 `upto_id`。
    pub fn snapshot(&self, session: &str) -> (Vec<Entry>, i64) {
        let (tx, rx) = mpsc::channel();
        self.send(Job::Snapshot {
            session: session.to_string(),
            limit: HISTORY_WINDOW,
            reply: tx,
        });
        rx.recv().unwrap_or_default()
    }

    /// 全量检索（Ctrl+R 防抖后）。查询规则在 core-domain。
    pub fn search(&self, session: &str, query: &str) -> Vec<Entry> {
        let (tx, rx) = mpsc::channel();
        self.send(Job::Search {
            session: session.to_string(),
            query: query.to_string(),
            reply: tx,
        });
        rx.recv().unwrap_or_default()
    }

    pub fn clear(&self, session: &str) {
        self.send(Job::Clear {
            session: session.to_string(),
        });
    }

    /// 删除会话节点时调用（I2）。
    pub fn delete_session(&self, session: &str) {
        self.send(Job::DeleteSession {
            session: session.to_string(),
        });
    }

    fn send(&self, job: Job) {
        if self.tx.send(job).is_err() {
            eprintln!("[data] history thread is gone");
        }
    }
}

fn run(path: PathBuf, has_dir: bool, rx: Receiver<Job>, app: AppHandle) {
    let mut store = if has_dir {
        Store::open(path)
    } else {
        Store::memory_only(path)
    };
    for job in rx {
        match job {
            Job::Record {
                session,
                command,
                used_ms,
            } => {
                let was_degraded = store.degraded;
                if let Some(entry) = store.record(&session, &command, used_ms) {
                    let _ = app.emit(
                        "history:append",
                        AppendPayload {
                            session_id: session,
                            item: entry.into(),
                        },
                    );
                }
                if !was_degraded && store.degraded {
                    let _ = app.emit("history:degraded", ());
                }
            }
            Job::Snapshot {
                session,
                limit,
                reply,
            } => {
                let _ = reply.send(store.snapshot(&session, limit));
            }
            Job::Search {
                session,
                query,
                reply,
            } => {
                let _ = reply.send(store.search(&session, &query));
            }
            Job::Clear { session } => store.clear(&session),
            Job::DeleteSession { session } => store.delete_session(&session),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("pinshell-history-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn commands(items: &[Entry]) -> Vec<&str> {
        items.iter().map(|e| e.command.as_str()).collect()
    }

    #[test]
    fn records_dedupe_move_to_latest_and_count() {
        let dir = temp_dir("dedupe");
        let mut store = Store::open(dir.join(HISTORY_FILE));
        let a = store.record("s", "git status\r", 100).unwrap();
        store.record("s", "ls", 200).unwrap();
        let again = store.record("s", "git status", 300).unwrap();

        assert_eq!((a.id, a.use_count), (1, 1));
        assert_eq!((again.id, again.use_count), (3, 2));
        let (items, upto) = store.snapshot("s", HISTORY_WINDOW);
        assert_eq!(commands(&items), vec!["ls", "git status"]);
        assert_eq!(items[1].used_ms, 300);
        assert_eq!(upto, 3);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sessions_are_isolated_and_clear_keeps_the_id_counter() {
        let dir = temp_dir("sessions");
        let mut store = Store::open(dir.join(HISTORY_FILE));
        store.record("a", "one", 1);
        store.record("a", "two", 2);
        store.record("b", "other", 3);

        store.clear("a");
        assert!(store.snapshot("a", HISTORY_WINDOW).0.is_empty());
        assert_eq!(
            commands(&store.snapshot("b", HISTORY_WINDOW).0),
            vec!["other"]
        );

        // 清空后 id 继续变大，前端不会把它当成重复事件
        let next = store.record("a", "three", 4).unwrap();
        assert_eq!(next.id, 3);
        assert_eq!(store.snapshot("a", HISTORY_WINDOW).1, 3);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_a_session_drops_its_history() {
        let dir = temp_dir("delete");
        let mut store = Store::open(dir.join(HISTORY_FILE));
        store.record("a", "one", 1);
        store.record("b", "two", 2);
        store.delete_session("a");

        assert!(store.snapshot("a", HISTORY_WINDOW).0.is_empty());
        assert_eq!(store.snapshot("a", HISTORY_WINDOW).1, 0);
        assert_eq!(store.snapshot("b", HISTORY_WINDOW).0.len(), 1);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cap_drops_oldest_rows_and_survives_reopen() {
        let dir = temp_dir("cap");
        let path = dir.join(HISTORY_FILE);
        let mut store = Store::open_with_cap(path.clone(), 3);
        for (index, cmd) in ["a", "b", "c", "d"].iter().enumerate() {
            store.record("s", cmd, index as u64);
        }
        assert_eq!(commands(&store.snapshot("s", 10).0), vec!["b", "c", "d"]);
        drop(store);

        // 重新打开：数据、序号、次数都还在（UTC 毫秒原样往返）
        let store = Store::open_with_cap(path, 3);
        let (items, upto) = store.snapshot("s", 10);
        assert_eq!(commands(&items), vec!["b", "c", "d"]);
        assert_eq!(items[2].used_ms, 3);
        assert_eq!(upto, 4);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_limit_keeps_the_newest_tail() {
        let dir = temp_dir("window");
        let mut store = Store::open(dir.join(HISTORY_FILE));
        for index in 0..5 {
            store.record("s", &format!("cmd {index}"), index);
        }
        let (items, upto) = store.snapshot("s", 2);
        assert_eq!(commands(&items), vec!["cmd 3", "cmd 4"]);
        assert_eq!(upto, 5);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_covers_the_whole_history_not_just_the_window() {
        let dir = temp_dir("search");
        let mut store = Store::open_with_cap(dir.join(HISTORY_FILE), 1_000);
        for index in 0..6 {
            store.record("s", &format!("cmd {index}"), index as u64);
        }
        let hits = store.search("s", "cmd");
        assert_eq!(hits.len(), 6);
        assert_eq!(hits[0].command, "cmd 5");
        // 查询含大写时区分大小写
        assert!(store.search("s", "CMD").is_empty());
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_db_is_renamed_and_rebuilt() {
        // L1-10：主库损坏 → 改名 history.db.corrupt-<时间> 并重建空库，启动不阻塞
        let dir = temp_dir("corrupt");
        let path = dir.join(HISTORY_FILE);
        std::fs::write(&path, b"this is not a sqlite database at all").unwrap();

        let store = Store::open(path.clone());
        assert!(store.degraded == false);
        assert!(store.recovered.is_some());
        assert!(store.snapshot("s", HISTORY_WINDOW).0.is_empty());
        assert!(path.exists());
        let quarantined: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with(CORRUPT_PREFIX))
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(quarantined.len(), 1);
        assert_eq!(
            std::fs::read(&quarantined[0]).unwrap(),
            b"this is not a sqlite database at all"
        );
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_session_reads_empty_instead_of_failing() {
        let dir = temp_dir("unknown");
        let store = Store::open(dir.join(HISTORY_FILE));
        assert!(store.snapshot("ghost", HISTORY_WINDOW).0.is_empty());
        assert!(store.search("ghost", "").is_empty());
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_only_store_keeps_the_same_semantics() {
        let mut store = Store::memory_only(PathBuf::from("unused"));
        assert!(store.degraded);
        store.record("s", "a", 1);
        store.record("s", "b", 2);
        let again = store.record("s", "a", 3).unwrap();
        assert_eq!(again.use_count, 2);
        assert_eq!(commands(&store.snapshot("s", 10).0), vec!["b", "a"]);
        store.clear("s");
        assert!(store.snapshot("s", 10).0.is_empty());
        assert_eq!(store.record("s", "c", 4).unwrap().id, 4);
    }

    #[test]
    fn database_file_lives_in_the_data_dir() {
        let dir = temp_dir("path");
        let store = Store::open(dir.join(HISTORY_FILE));
        assert_eq!(store.path(), dir.join(HISTORY_FILE).as_path());
        assert!(store.path().exists());
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
