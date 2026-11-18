//! 原生右键菜单 helper（Windows only）。
//!
//! 为什么是独立进程：菜单内容来自系统 Shell 的 `IContextMenu`，它会把第三方 shell
//! 扩展（7-Zip、TortoiseSVN、各种网盘）以 DLL 的形式加载进本进程。那些扩展崩了会
//! 带走宿主，所以必须与主进程隔离：本进程死了，主进程只看到非零退出码，前端退回
//! 自建菜单，不丢会话。
//!
//! 协议（与 `src-tauri/src/shellmenu.rs` 对应）：
//!   入参：`pinshell-shellmenu.exe --path <绝对路径> [--hwnd <十进制窗口句柄>]`
//!   出参：stdout 一行，`handled` / `cancelled`
//!   退出码：0 = 走完了（用户选了或取消）；非 0 = 菜单起不来（前端据此降级）
//!
//! 菜单坐标取鼠标当前位置：右键时鼠标就在那一行上，比前端算一堆 DPI 偏移可靠。

#[cfg(windows)]
fn main() {
    match imp::run() {
        Ok(()) => {}
        Err(message) => {
            eprintln!("[shellmenu] {message}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("[shellmenu] 原生右键菜单只在 Windows 上可用");
    std::process::exit(2);
}

#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::{w, PCSTR, PCWSTR};
    use windows::Win32::Foundation::{GetLastError, SetLastError, HWND, LPARAM, WPARAM, WIN32_ERROR};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        IContextMenu, IShellFolder, SHBindToParent, SHParseDisplayName, CMF_EXPLORE, CMF_NORMAL,
        CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreatePopupMenu, CreateWindowExW, DestroyMenu, DestroyWindow, GetCursorPos,
        GetMenuItemCount, PostMessageW, SetForegroundWindow, TrackPopupMenuEx, SW_SHOWNORMAL,
        TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_NULL, WINDOW_EX_STYLE, WS_POPUP,
    };

    /// 菜单命令 id 的起点。`QueryContextMenu` 从它开始编号，`TrackPopupMenuEx` 返回
    /// 的也是这个区间里的值；减掉起点就是 `InvokeCommand` 要的动词偏移。
    const ID_FIRST: u32 = 1;
    const ID_LAST: u32 = 0x7FFF;

    /// `CMIC_MASK_UNICODE`：告诉菜单用 `lpVerbW` 而不是 `lpVerb`。windows crate
    /// 没有导出这个名字，值取自 Windows SDK 的 shlobj.h。
    const CMIC_MASK_UNICODE: u32 = 0x0000_4000;

    pub fn run() -> Result<(), String> {
        let mut path: Option<String> = None;
        let mut hwnd_value: usize = 0;
        let mut probe = false;
        let args: Vec<String> = std::env::args().skip(1).collect();
        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--path" => {
                    index += 1;
                    path = args.get(index).cloned();
                }
                "--hwnd" => {
                    index += 1;
                    hwnd_value = args
                        .get(index)
                        .and_then(|value| value.parse::<usize>().ok())
                        .unwrap_or(0);
                }
                // 自检：走完 QueryContextMenu 就退出，不弹菜单。用来验证 COM 链路
                // 与 shell 扩展是否正常，也方便排障时判断「是不是 helper 本身起不来」。
                "--probe" => probe = true,
                _ => {}
            }
            index += 1;
        }

        let path = path.ok_or_else(|| "缺少 --path".to_string())?;
        if !std::path::Path::new(&path).exists() {
            return Err(format!("路径不存在: {path}"));
        }

        // IContextMenu 要求线程已初始化 COM；STA 是 shell 扩展的既定要求。
        // 初始化失败直接退出：前端会退回自建菜单，而不是弹一个残废的菜单。
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|err| format!("CoInitializeEx: {err}"))?;

        let outcome = unsafe { show(&path, HWND(hwnd_value as *mut core::ffi::c_void), probe) };
        unsafe { CoUninitialize() };
        match outcome {
            Ok(outcome) => {
                println!("{outcome}");
                Ok(())
            }
            Err(message) => Err(message),
        }
    }

    /// 菜单 owner 用的隐藏窗口。
    ///
    /// `TrackPopupMenuEx` 只认**本进程**的窗口句柄：传别的进程（主程序）的 HWND 会
    /// 立刻返回 0 并置 `ERROR_INVALID_PARAMETER`，菜单根本不出现——这正是「右键没反应」
    /// 的根因。用系统自带的 `STATIC` 类，省得注册窗口类。
    unsafe fn create_owner_window() -> Result<HWND, String> {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("PinShellMenu"),
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        )
        .map_err(|err| format!("CreateWindowExW: {err}"))
    }

    unsafe fn show(path: &str, parent_window: HWND, probe: bool) -> Result<&'static str, String> {
        let wide = to_wide(path);
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None)
            .map_err(|err| format!("SHParseDisplayName: {err}"))?;
        // 菜单 owner 必须是本进程的窗口，所以自己造一个，而不是借主程序的句柄。
        let owner = create_owner_window()?;

        // 父文件夹 + 最后一段 pidl：菜单是按条目的父文件夹生成的。
        let mut child: *mut ITEMIDLIST = std::ptr::null_mut();
        let bound = SHBindToParent::<IShellFolder>(pidl, Some(&mut child as *mut *mut ITEMIDLIST));
        // 不管后面成不成功，pidl 都由我们自己释放。
        let result = (|| -> Result<&'static str, String> {
            let parent = bound.map_err(|err| format!("SHBindToParent: {err}"))?;
            if child.is_null() {
                return Err("找不到条目的父目录".into());
            }
            let children = [child as *const ITEMIDLIST];
            let menu: IContextMenu = parent
                .GetUIObjectOf(owner, &children, None)
                .map_err(|err| format!("GetUIObjectOf: {err}"))?;

            let popup = CreatePopupMenu().map_err(|err| format!("CreatePopupMenu: {err}"))?;
            menu.QueryContextMenu(popup, 0, ID_FIRST, ID_LAST, CMF_NORMAL | CMF_EXPLORE)
                .ok()
                .map_err(|err| format!("QueryContextMenu: {err}"))?;

            // 自检模式到这里就够了：菜单项已经生成，说明 COM 与 shell 扩展都是通的。
            if probe {
                eprintln!("[shellmenu] probe items={}", GetMenuItemCount(Some(popup)));
                let _ = DestroyMenu(popup);
                return Ok("ready");
            }

            let mut point = Default::default();
            GetCursorPos(&mut point).map_err(|err| format!("GetCursorPos: {err}"))?;

            // 菜单的 owner 必须在前台，否则点菜单外面它不会消失（Win32 的老规矩）。
            // 主进程 spawn 之后会调 `AllowSetForegroundWindow` 把这份权限授予本进程。
            let _ = SetForegroundWindow(owner);
            let _ = PostMessageW(Some(owner), WM_NULL, WPARAM(0), LPARAM(0));

            SetLastError(WIN32_ERROR(0));
            let command = TrackPopupMenuEx(
                popup,
                (TPM_RETURNCMD | TPM_RIGHTBUTTON).0,
                point.x,
                point.y,
                owner,
                None,
            );
            let menu_error = GetLastError();

            let _ = DestroyMenu(popup);
            // 菜单期间前台被我们拿走了，还回主窗口，别让终端打不进字。
            if !parent_window.0.is_null() {
                let _ = SetForegroundWindow(parent_window);
            }

            if command.0 == 0 {
                // 0 既可能是「用户取消」，也可能是调用失败——只有看错误码才分得清。
                // 失败必须报错退出（前端据此画自建菜单）；报「取消」会让右键看起来毫无反应。
                if menu_error.0 != 0 {
                    return Err(format!("TrackPopupMenuEx: {menu_error:?}"));
                }
                return Ok("cancelled");
            }

            let offset = (command.0 as u32).saturating_sub(ID_FIRST);
            let info = CMINVOKECOMMANDINFOEX {
                cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
                fMask: CMIC_MASK_UNICODE,
                hwnd: owner,
                // MAKEINTRESOURCE(偏移)：低地址当整数用，不是真的指针。
                lpVerb: PCSTR(offset as *const u8),
                lpVerbW: PCWSTR(offset as *const u16),
                nShow: SW_SHOWNORMAL.0,
                ..Default::default()
            };

            menu.InvokeCommand((&info as *const CMINVOKECOMMANDINFOEX).cast::<CMINVOKECOMMANDINFO>())
                .map_err(|err| format!("InvokeCommand: {err}"))?;
            Ok("handled")
        })();

        if !pidl.is_null() {
            CoTaskMemFree(Some(pidl as *const core::ffi::c_void));
        }
        let _ = DestroyWindow(owner);
        result
    }

    fn to_wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
}
