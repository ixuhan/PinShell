// 界面文案的中英文词典与切换机制。
//
// 只做「一条文案一个键」的静态映射：没有复数规则、没有日期格式化——终端类界面的文案
// 全是短句，用 `{name}` 占位符就够了。切换语言时写 localStorage 并通知订阅者，
// 订阅者负责重画自己那块 DOM（静态文案用 `applyStaticI18n`，动态文案用 `t`）。

export type Locale = "zh" | "en";

export const LOCALE_KEY = "pinshell.locale";

type Entry = readonly [zh: string, en: string];

const DICT = {
  // ---------- 标题栏 ----------
  "titlebar.collapseLeft": ["收起左侧栏", "Collapse left sidebar"],
  "titlebar.expandLeft": ["展开左侧栏", "Expand left sidebar"],
  "titlebar.collapseRight": ["收起右侧栏", "Collapse right sidebar"],
  "titlebar.expandRight": ["展开右侧栏", "Expand right sidebar"],
  "titlebar.settings": ["全局设置", "Global settings"],
  "titlebar.minimize": ["最小化", "Minimize"],
  "titlebar.maximize": ["最大化", "Maximize"],
  "titlebar.restore": ["还原", "Restore"],
  "titlebar.close": ["关闭", "Close"],

  // ---------- 侧栏通用 ----------
  "panel.collapse": ["收起{label}", "Collapse {label}"],
  "panel.expand": ["展开{label}", "Expand {label}"],

  // ---------- 会话栏 ----------
  "sidebar.sessions": ["会话", "Sessions"],
  "sidebar.newTerminal": ["新建终端会话", "New terminal session"],
  "sidebar.serial": ["串口", "Serial"],
  "sidebar.refreshPorts": ["刷新串口列表", "Refresh serial ports"],
  "sidebar.autoPorts": ["自动刷新串口列表", "Auto-refresh serial ports"],
  "sidebar.autoPortsOn": ["自动刷新已开：每 1 秒枚举一次，点一下关闭", "Auto-refresh on: enumerates every second, click to turn off"],
  "sidebar.autoPortsOff": ["自动刷新：每 1 秒枚举一次", "Auto-refresh: enumerates every second"],
  "sidebar.portsResize": ["拖动调整串口面板高度", "Drag to resize the serial panel"],
  "sidebar.expand": ["向右展开侧栏", "Expand sidebar to the right"],
  "sidebar.resize": ["拖动调整会话栏宽度 · 双击恢复默认", "Drag to resize the sidebar · double-click to reset"],
  "sidebar.portsRefreshed": ["刷新于：{time}", "Refreshed: {time}"],
  "sidebar.enumerating": ["正在枚举串口…", "Enumerating serial ports…"],
  "sidebar.portsCount": ["{n} 个端口", "{n} ports"],
  "sidebar.portsEmpty": ["没有枚举到串口", "No serial ports found"],
  "sidebar.portsFailed": ["枚举串口失败", "Failed to enumerate serial ports"],

  // ---------- 会话行 ----------
  "session.menu": ["会话操作", "Session actions"],
  "session.menuOf": ["{title} 操作菜单", "{title} actions"],
  "session.rename": ["重命名", "Rename"],
  "session.delete": ["删除", "Delete"],
  "session.deleteConfirm": ["再次点击确认删除", "Click again to delete"],
  "session.clear": ["清屏", "Clear screen"],
  "session.copy": ["复制", "Copy"],
  "session.settings": ["会话设置", "Session settings"],
  "session.freeze": ["冻结会话", "Freeze session"],
  "session.freezeHint": ["结束进程/端口但保留记录、历史与屏幕，点开会重新拉起", "End the process/port but keep the record, history and screen; open it again to restart"],
  "session.resume": ["继续", "Resume"],
  "session.pause": ["暂停", "Pause"],
  "session.connect": ["连接", "Connect"],
  "session.disconnect": ["断开", "Disconnect"],
  "session.passthrough": ["直通", "Pass-through"],
  "session.takeover": ["接管", "Take over"],
  "session.running": ["运行中", "Running"],
  "session.paused": ["暂停中", "Paused"],
  "session.connected": ["已连接", "Connected"],
  "session.disconnected": ["已断开", "Disconnected"],
  "session.failed": ["失败", "Failed"],
  "session.doubleClickPause": ["双击切换暂停状态", "Double-click to toggle pause"],
  "session.doubleClickConnect": ["双击切换连接状态", "Double-click to toggle connection"],
  "session.pausedHint": ["输出已暂停 · 双击切换暂停状态", "Output paused · double-click to toggle"],
  "session.runningHint": ["会话运行中 · 双击切换暂停状态", "Session running · double-click to toggle"],
  "session.serialConnectedHint": ["串口已连接 · 双击此处切换连接状态", "Serial connected · double-click to toggle connection"],
  "session.serialDisconnectedHint": ["串口已断开 · 双击此处切换连接状态", "Serial disconnected · double-click to toggle connection"],

  // ---------- 列表多选（会话 / 快捷指令） ----------
  "bulk.selectSessions": ["批量选择会话", "Select multiple sessions"],
  "bulk.selectShortcuts": ["批量选择快捷指令", "Select multiple snippets"],
  "bulk.selectAll": ["全选", "Select all"],
  "bulk.invert": ["反选", "Invert"],
  "bulk.deleteHint": ["删除选中的项；首次点击后需再点一次确认", "Delete selected items; click once more to confirm"],
  "bulk.deleteCount": ["删除 ({n})", "Delete ({n})"],
  "bulk.deleteConfirm": ["确认删除（{n}）", "Confirm delete ({n})"],
  "bulk.done": ["完成", "Done"],

  // ---------- 命令历史覆盖层 ----------
  "history.title": ["命令历史", "Command history"],
  "history.clearHint": ["只清空当前会话的命令历史", "Clear this session's command history only"],
  "history.clear": ["清空本会话", "Clear session"],
  "history.clearArmed": ["再点一次确认", "Click again to confirm"],
  "history.closeHint": ["关闭（Esc）", "Close (Esc)"],
  "history.search": ["检索（含大写则区分大小写）", "Search (uppercase makes it case-sensitive)"],
  "history.foot": ["↑↓ 选择 · Enter 填入输入条 · Esc / Ctrl+R 关闭", "↑↓ select · Enter fills input · Esc / Ctrl+R closes"],
  "history.empty": ["没有匹配的命令", "No matching commands"],
  "history.older": ["更早", "Earlier"],
  "history.count": ["{n} 条", "{n} items"],
  "history.countCapped": ["{n} 条 · 显示最近 {m}", "{n} items · showing latest {m}"],

  // ---------- 输入条 ----------
  "input.resize": ["拖动调整输入区高度 · 双击恢复默认", "Drag to resize the input area · double-click to reset"],
  "input.placeholder": ["输入命令", "Type a command"],
  "input.placeholderSerial": ["输入要发送的内容", "Type content to send"],
  "input.placeholderHex": ["HEX：48 65 6C 6C 6F", "HEX: 48 65 6C 6C 6F"],
  "input.history": ["命令历史", "Command history"],
  "input.historyHint": ["命令历史", "Command history"],
  "input.paused": ["暂停中", "Paused"],
  "input.pausedHint": ["点「连接」按原配置重开；会话、回放与历史都还在", "Click Connect to reopen with the same settings; the session, replay and history are kept"],
  "input.overrideHint": ["切换直通 / 接管", "Toggle pass-through / take over"],
  "input.lockedPassthroughHint": ["按键正在透传给终端，点这里收回输入条", "Keys go to the terminal; click to take them back"],
  "input.lockedInputHint": ["输入条已接管，点这里切回直通", "Input bar owns the keys; click to pass them through"],
  "input.toTakeover": ["切换到接管输入", "Switch to take-over input"],
  "input.toPassthrough": ["切换到直通输入", "Switch to pass-through input"],
  "input.hex": ["HEX", "HEX"],
  "input.hexHint": ["切换 HEX 输入（仅限十六进制字符，自动按字节分隔）", "Toggle HEX input (hex digits only, auto-separated by byte)"],
  "input.hexOdd": ["HEX 字符数必须为偶数，每个字节需要两位", "HEX needs an even number of digits: two per byte"],
  "input.log": ["日志", "Log"],
  "input.logHint": ["打开本会话的串口日志", "Open this session's serial log"],
  "input.noLog": ["本次会话没有日志文件", "This session has no log file"],
  "input.send": ["发送", "Send"],
  "input.sendHint": ["发送（Enter）", "Send (Enter)"],
  "input.lockedPassthrough": ["已锁直通 · 按键全给通道", "Pass-through locked · keys go to the channel"],
  "input.lockedInput": ["已锁输入条 · 按键不回通道", "Input locked · keys stay here"],
  "input.serialConnecting": ["串口 · 连接中", "Serial · connecting"],
  "input.serialFailed": ["{port} · 失败", "{port} · failed"],
  "input.serialDisconnected": ["{port} · 断开", "{port} · disconnected"],
  "input.connectFailed": ["连接失败", "Connection failed"],
  "input.portDropped": ["端口已断开", "Port disconnected"],
  "input.noSession": ["当前没有会话", "No active session"],

  // ---------- 文件面板 ----------
  "files.title": ["文件", "Files"],
  "files.expand": ["向左展开文件栏", "Expand file panel to the left"],
  "files.resize": ["拖动调整宽度 · 双击恢复默认", "Drag to resize · double-click to reset"],
  "files.follow": ["跟随", "Follow"],
  "files.fixed": ["固定", "Pinned"],
  "files.followHint": ["面板跟随当前会话的 CWD；点一下改成固定路径", "Follows the session CWD; click to pin a path"],
  "files.fixedHint": ["面板停在固定路径；点一下恢复跟随当前会话", "Panel stays on a fixed path; click to follow the session again"],
  "files.sort": ["文件排序方式", "File sort order"],
  "files.sortName": ["名称", "Name"],
  "files.sortCreated": ["创建时间", "Created"],
  "files.sortHint": ["文件排序方式：{sort}（点一下更换）", "File sort: {sort} (click to change)"],
  "files.sortNameAsc": ["名称 ↑（A→Z，0→9）", "Name ↑ (A→Z, 0→9)"],
  "files.sortNameDesc": ["名称 ↓（Z→A，9→0）", "Name ↓ (Z→A, 9→0)"],
  "files.sortCreatedAsc": ["创建时间 ↑（最早在前）", "Created ↑ (oldest first)"],
  "files.sortCreatedDesc": ["创建时间 ↓（最新在前）", "Created ↓ (newest first)"],
  "files.refresh": ["刷新", "Refresh"],
  "files.auto": ["自动刷新文件列表", "Auto-refresh file list"],
  "files.autoOn": ["自动刷新已开：当前目录每 {n} 秒刷新一次，点一下关闭", "Auto-refresh on: refreshes every {n}s, click to turn off"],
  "files.autoOff": ["自动刷新：每 {n} 秒刷新一次（大目录自动放慢），点一下开启", "Auto-refresh: every {n}s (slower for big folders), click to turn on"],
  "files.hidden": ["显示隐藏项（以点开头或带隐藏属性）", "Show hidden entries (dot-prefixed or hidden attribute)"],
  "files.hiddenShort": ["隐", "Hid"],
  "files.hiddenMark": ["（隐藏）", " (hidden)"],
  "files.foot": ["双击目录进入 · 双击文件填入输入条", "Double-click a folder to enter · a file to fill the input"],
  "files.emptyHidden": ["（只有隐藏项）", "(hidden entries only)"],
  "files.emptyDir": ["（空目录）", "(empty folder)"],
  "files.count": ["{n} 项", "{n} items"],
  "files.hiddenCount": ["隐藏 {n}", "hidden {n}"],
  "files.truncated": ["只显示前 {n} 项", "showing first {n} items"],
  "files.refreshedAt": ["刷新于：{time}", "Refreshed: {time}"],
  "files.waiting": ["等待刷新", "Waiting to refresh"],
  "files.noSession": ["无会话", "No session"],
  "files.copied": ["已复制路径", "Path copied"],
  "files.openWith": ["用默认程序打开", "Open with default app"],
  "files.open": ["打开", "Open"],
  "files.reveal": ["在资源管理器中显示", "Show in File Explorer"],
  "files.revealParent": ["在资源管理器中显示上级目录", "Show parent folder in File Explorer"],
  "files.fill": ["填入输入条", "Fill the input"],
  "files.copyPath": ["复制路径", "Copy path"],
  "files.editPath": ["编辑路径（回车跳转，Esc 取消）", "Edit path (Enter to go, Esc to cancel)"],
  "files.link": ["符号链接", "Symbolic link"],
  "files.autoShort": ["刷", "Auto"],
  "files.parent": ["上级目录", "Parent folder"],

  // ---------- 快捷指令 ----------
  "shortcuts.title": ["快捷指令", "Snippets"],
  "shortcuts.new": ["新建快捷指令", "New snippet"],
  "shortcuts.import": ["导入", "Import"],
  "shortcuts.export": ["导出", "Export"],
  "shortcuts.importHint": ["导入指令集 JSON", "Import snippets from JSON"],
  "shortcuts.exportHint": ["导出当前会话指令集 JSON", "Export this session's snippets as JSON"],
  "shortcuts.empty": ["暂无快捷指令", "No snippets yet"],
  "shortcuts.unnamed": ["未命名指令", "Untitled snippet"],
  "shortcuts.clickToEdit": ["（点击编辑，添加命令）", "(click to edit and add a command)"],
  "shortcuts.execute": ["执行", "Run"],
  "shortcuts.fill": ["填入", "Fill"],
  "shortcuts.moveUp": ["上移", "Move up"],
  "shortcuts.moveDown": ["下移", "Move down"],
  "shortcuts.edit": ["编辑", "Edit"],
  "shortcuts.remove": ["删除", "Delete"],
  "shortcuts.nameLabel": ["名称", "Name"],
  "shortcuts.commandLabel": ["命令", "Command"],
  "shortcuts.modeLegend": ["点击行为", "Click behavior"],
  "shortcuts.cancel": ["取消", "Cancel"],
  "shortcuts.save": ["保存", "Save"],
  "shortcuts.nameRequired": ["请输入名称", "Please enter a name"],
  "shortcuts.imported": ["已导入 {n} 条", "Imported {n} snippets"],
  "shortcuts.batchDeleted": ["已删除 {n} 条", "Deleted {n} snippets"],
  "shortcuts.exported": ["已导出到 {path}", "Exported to {path}"],
  "shortcuts.exportFailed": ["导出失败：{error}", "Export failed: {error}"],
  "shortcuts.exportTitle": ["导出会话指令集", "Export session snippets"],
  "shortcuts.exportFilter": ["JSON 指令集", "JSON snippets"],
  "shortcuts.badShape": ["指令集格式无效：需要 JSON 数组或包含 items 数组的对象", "Invalid snippet file: expected a JSON array or an object with an items array"],
  "shortcuts.badItem": ["指令集格式无效：每项必须包含名称、命令和 execute/fill 模式", "Invalid snippet file: each item needs a name, a command and an execute/fill mode"],
  "shortcuts.resize": ["拖动调整快捷指令区高度", "Drag to resize the snippets panel"],
  "shortcuts.newTitle": ["新建快捷指令", "New snippet"],
  "shortcuts.editTitle": ["编辑快捷指令", "Edit snippet"],

  // ---------- 新建串口会话 ----------
  "serial.title": ["新建串口会话", "New serial session"],
  "serial.closeHint": ["关闭（Esc）", "Close (Esc)"],
  "serial.port": ["端口", "Port"],
  "serial.baud": ["波特率", "Baud rate"],
  "serial.baudHint": ["可直接输入，也可点右侧箭头选常用值", "Type a value or use the arrow to pick a common rate"],
  "serial.baudPick": ["选择常用波特率", "Pick a common baud rate"],
  "serial.dataBits": ["数据位", "Data bits"],
  "serial.parity": ["校验", "Parity"],
  "serial.parityNone": ["无", "None"],
  "serial.parityOdd": ["奇", "Odd"],
  "serial.parityEven": ["偶", "Even"],
  "serial.stopBits": ["停止位", "Stop bits"],
  "serial.flow": ["流控", "Flow control"],
  "serial.flowNone": ["无", "None"],
  "serial.lineEnding": ["行结束符", "Line ending"],
  "serial.sendMode": ["发送方式", "Send mode"],
  "serial.modeLine": ["行缓冲", "Line buffered"],
  "serial.modeDirect": ["直发", "Direct"],
  "serial.flagsHint": ["打开端口时把这两条握手线拉高；多数 USB 转串口需要", "Raise these handshake lines when opening; most USB adapters need it"],
  "serial.cancel": ["取消", "Cancel"],
  "serial.create": ["创建", "Create"],
  "serial.connecting": ["连接中…", "Connecting…"],
  "serial.portRequired": ["端口未知：请从左侧串口列表选择端口。", "Unknown port: pick one from the serial list on the left."],
  "serial.baudRequired": ["波特率必须是正整数", "Baud rate must be a positive integer"],
  "serial.bluetooth": ["蓝牙", "Bluetooth"],
  "serial.unknown": ["串口设备", "Serial device"],
  "serial.virtual": ["虚拟", "Virtual"],

  // ---------- 会话设置 ----------
  "sessionSettings.title": ["会话设置", "Session settings"],
  "sessionSettings.titleOf": ["会话设置 · {title}", "Session settings · {title}"],
  "sessionSettings.close": ["关闭", "Close"],
  "sessionSettings.sectionDisplay": ["终端显示", "Terminal display"],
  "sessionSettings.fontSize": ["字体大小", "Font size"],
  "sessionSettings.sectionTerminal": ["终端与时间", "Terminal and time"],
  "sessionSettings.crAsNewline": ["回车作为换行", "Send CR as newline"],
  "sessionSettings.consoleTimestamps": ["控制台显示时间戳", "Show timestamps in console"],
  "sessionSettings.fileTimestamps": ["文件记录时间戳", "Write timestamps to file"],
  "sessionSettings.timestampFormat": ["时间戳格式", "Timestamp format"],
  "sessionSettings.timestampFormatHint": ["可用 yyyy / MM / dd / HH / mm / ss / SSS，也支持 %H:%M:%S 这类 strftime 写法", "Use yyyy / MM / dd / HH / mm / ss / SSS, or a strftime pattern like %H:%M:%S"],
  "sessionSettings.sectionLog": ["日志", "Logging"],
  "sessionSettings.logging": ["记录会话日志", "Record session log"],
  "sessionSettings.newLogOnToggle": ["暂停/继续（连接/断开）时新建日志文件", "Start a new log file on pause/resume (disconnect/connect)"],
  "sessionSettings.logFilename": ["日志文件名", "Log file name"],
  "sessionSettings.logDirectory": ["日志目录", "Log directory"],
  "sessionSettings.browse": ["浏览", "Browse"],
  "sessionSettings.open": ["打开", "Open"],
  "sessionSettings.sectionSerial": ["串口参数", "Serial parameters"],
  "sessionSettings.port": ["端口", "Port"],
  "sessionSettings.portHint": ["端口在创建会话时确定；想换端口请从左侧串口列表新建会话", "The port is fixed when the session is created; create a new session from the serial list to use another port"],
  "sessionSettings.baud": ["波特率", "Baud rate"],
  "sessionSettings.dataBits": ["数据位", "Data bits"],
  "sessionSettings.parity": ["校验位", "Parity"],
  "sessionSettings.stopBits": ["停止位", "Stop bits"],
  "sessionSettings.flow": ["流控", "Flow control"],
  "sessionSettings.flowNone": ["无", "None"],
  "sessionSettings.flowSoftware": ["软件", "Software"],
  "sessionSettings.flowHardware": ["硬件", "Hardware"],
  "sessionSettings.lineEnding": ["发送行尾", "Line ending"],
  "sessionSettings.sendMode": ["发送模式", "Send mode"],
  "sessionSettings.modeLine": ["按行", "By line"],
  "sessionSettings.modeDirect": ["直接", "Direct"],
  "sessionSettings.cancel": ["取消", "Cancel"],
  "sessionSettings.save": ["保存", "Save"],
  "sessionSettings.needPath": ["请先选择日志目录。", "Choose a log directory first."],
  "sessionSettings.notLoaded": ["设置尚未成功加载，不能保存。", "Settings did not load, so they cannot be saved."],
  "sessionSettings.invalidSerial": ["请填写有效端口和波特率。", "Enter a valid port and baud rate."],
  "sessionSettings.invalidFont": ["字体大小必须是 9 到 28 之间的整数。", "Font size must be an integer between 9 and 28."],
  "sessionSettings.loading": ["加载中…", "Loading…"],

  // ---------- 全局设置 ----------
  "globalSettings.title": ["全局设置", "Global settings"],
  "globalSettings.close": ["关闭设置", "Close settings"],
  "globalSettings.sectionGeneral": ["常规", "General"],
  "globalSettings.language": ["语言", "Language"],
  "globalSettings.langZh": ["中文", "Chinese"],
  "globalSettings.langEn": ["English", "English"],
  "globalSettings.theme": ["主题", "Theme"],
  "globalSettings.themeDark": ["暗黑", "Dark"],
  "globalSettings.themeMidnight": ["深空蓝", "Midnight"],
  "globalSettings.themeEmber": ["炭火", "Ember"],
  "globalSettings.themeNord": ["极地雾", "Polar"],
  "globalSettings.themeCream": ["乳白", "Cream"],
  "globalSettings.themeSand": ["沙岩", "Sand"],
  "globalSettings.themeBright": ["明亮", "Bright"],
  "globalSettings.themeMist": ["雾灰", "Mist"],
  "globalSettings.themePaper": ["素纸", "Paper"],
  "globalSettings.sectionAbout": ["关于", "About"],
  "globalSettings.version": ["版本 {version}", "Version {version}"],
  "globalSettings.checkUpdate": ["检查更新", "Check for updates"],
  "globalSettings.checking": ["正在检查更新…", "Checking for updates…"],
  "globalSettings.upToDate": ["已是最新版本", "You are up to date"],
  "globalSettings.updateAvailable": ["发现新版本 {version}", "Version {version} is available"],
  "globalSettings.updateFailed": ["检查更新失败：{error}", "Update check failed: {error}"],
  "globalSettings.notConfigured": ["未配置更新源，无法检查更新", "No update source configured"],
  "globalSettings.done": ["完成", "Done"],

  // ---------- 通用 ----------
  "common.copy": ["复制", "Copy"],
  "common.cancel": ["取消", "Cancel"],
  "common.save": ["保存", "Save"],
  "common.close": ["关闭", "Close"],
  "common.ok": ["确定", "OK"]
} as const satisfies Record<string, Entry>;

export type MessageKey = keyof typeof DICT;

const listeners = new Set<(locale: Locale) => void>();

function readStored(): Locale {
  try {
    return localStorage.getItem(LOCALE_KEY) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

let current: Locale = readStored();

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(LOCALE_KEY, next);
  } catch {
    // 存不下只影响下次启动的默认值
  }
  // 单测里没有 DOM：`document` 缺失时只更新语言本身
  if (typeof document !== "undefined") {
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  }
  for (const listener of listeners) listener(next);
}

export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/// 取一条文案。占位符写成 `{name}`，用 `vars` 填。
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const entry: Entry | undefined = DICT[key];
  let text = entry ? entry[current === "zh" ? 0 : 1] : String(key);
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/// 把 `data-i18n*` 标注的静态文案刷成当前语言。
/// - `data-i18n` → textContent
/// - `data-i18n-title` → title
/// - `data-i18n-aria` → aria-label
/// - `data-i18n-ph` → placeholder
export function applyStaticI18n(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n as MessageKey);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle as MessageKey);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAria as MessageKey));
  }
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-ph]")) {
    el.placeholder = t(el.dataset.i18nPh as MessageKey);
  }
}

/// 启动时把 `<html lang>` 对齐到当前语言（静态文案由各模块自己刷）。
export function initLocale(): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
  }
}
