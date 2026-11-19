use std::path::PathBuf;

#[tauri::command]
pub(super) fn shortcuts_export_file(path: String, contents: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if target.extension().and_then(|ext| ext.to_str()) != Some("json") {
        return Err("导出文件必须使用 .json 扩展名".into());
    }
    std::fs::write(&target, contents)
        .map_err(|err| format!("写入 {} 失败：{err}", target.display()))
}

#[tauri::command]
pub(super) fn shortcuts_export_default_path() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|err| format!("无法获取软件目录：{err}"))?;
    let root = exe
        .parent()
        .ok_or_else(|| "无法获取软件根目录".to_string())?;
    Ok(root
        .join("pinshell-shortcuts.json")
        .to_string_lossy()
        .into_owned())
}
