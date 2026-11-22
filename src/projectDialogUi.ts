// 新建项目 / 项目设置共用一个弹窗（ADR 0008）。
//
// 新建时只有「名称 + 根目录」两项；设置模式多一行只读统计。
// 名称校验只有「全空白拒绝」一条，正式规则（trim / 截断 40）在 core-domain。

import { invoke } from "@tauri-apps/api/core";
import { enableDialogDrag, resetDialogPosition } from "./modalDrag";
import { onLocaleChange, t } from "./i18n";

export interface ProjectSummary {
  id: string;
  name: string;
  root: string | null;
}

export interface ProjectDialogDeps {
  /// 新建成功后拿到 id：调用方负责选中、展开并重挂主区
  onCreated(id: string): Promise<void> | void;
  /// 设置保存成功后重新读一次工作区
  onSaved(id: string): Promise<void> | void;
  /// 只读统计（终端几格、串口几格）
  statsOf(id: string): { terminal: number; serial: number };
}

export interface ProjectDialogHandle {
  openCreate(): void;
  openSettings(project: ProjectSummary): void;
  close(): void;
  isOpen(): boolean;
}

export function setupProjectDialog(deps: ProjectDialogDeps): ProjectDialogHandle {
  const overlay = document.createElement("div");
  overlay.className = "project-overlay";
  overlay.hidden = true;

  const dialog = document.createElement("section");
  dialog.className = "project-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const heading = document.createElement("h3");
  const nameLabel = document.createElement("label");
  const nameText = document.createElement("span");
  nameText.textContent = t("project.name");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.maxLength = 40;
  nameInput.autocomplete = "off";
  nameInput.spellcheck = false;
  nameLabel.append(nameText, nameInput);

  const rootLabel = document.createElement("label");
  const rootText = document.createElement("span");
  rootText.textContent = t("project.root");
  const rootInput = document.createElement("input");
  rootInput.type = "text";
  rootInput.placeholder = t("project.rootPlaceholder");
  rootInput.autocomplete = "off";
  rootInput.spellcheck = false;
  rootLabel.append(rootText, rootInput);

  const stats = document.createElement("span");
  stats.className = "project-stats";

  const error = document.createElement("span");
  error.className = "project-error";
  error.setAttribute("role", "alert");

  const actions = document.createElement("div");
  actions.className = "project-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("project.cancel");
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary";
  actions.append(cancel, save);

  dialog.append(heading, nameLabel, rootLabel, stats, error, actions);
  overlay.append(dialog);
  document.body.append(overlay);
  enableDialogDrag(heading, dialog);

  let current: ProjectSummary | null = null;
  let busy = false;

  function setError(text: string) {
    error.textContent = text;
  }

  function close() {
    if (busy) return;
    overlay.hidden = true;
    setError("");
  }

  function paintStats() {
    if (!current) {
      stats.hidden = true;
      return;
    }
    const counts = deps.statsOf(current.id);
    stats.hidden = false;
    stats.textContent = t("project.stats", {
      terminal: counts.terminal,
      serial: counts.serial
    });
  }

  async function submit() {
    if (busy) return;
    const name = nameInput.value.trim();
    if (!name) {
      setError(t("project.nameRequired"));
      nameInput.focus();
      return;
    }
    busy = true;
    save.disabled = true;
    setError("");
    try {
      if (current) {
        await invoke("project_rename", { id: current.id, name });
        await invoke("project_set_root", {
          id: current.id,
          root: rootInput.value.trim() || null
        });
        const id = current.id;
        busy = false;
        save.disabled = false;
        overlay.hidden = true;
        await deps.onSaved(id);
      } else {
        const id = await invoke<string>("project_create", { name });
        busy = false;
        save.disabled = false;
        overlay.hidden = true;
        await deps.onCreated(id);
      }
    } catch (err) {
      busy = false;
      save.disabled = false;
      setError(String(err));
    }
  }

  cancel.addEventListener("click", close);
  save.addEventListener("click", () => void submit());
  // 「创建 / 保存」不抢焦点：错误信息还在时可以直接改了再回车
  save.addEventListener("mousedown", (event) => event.preventDefault());
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    if (event.key === "Enter" && event.target !== rootInput) {
      event.preventDefault();
      void submit();
    }
  });

  onLocaleChange(() => {
    nameText.textContent = t("project.name");
    rootText.textContent = t("project.root");
    rootInput.placeholder = t("project.rootPlaceholder");
    cancel.textContent = t("project.cancel");
    save.textContent = current ? t("project.save") : t("project.create");
    heading.textContent = current ? t("project.settings") : t("project.new");
    paintStats();
  });

  return {
    openCreate() {
      current = null;
      heading.textContent = t("project.new");
      nameInput.value = t("project.defaultName");
      rootInput.value = "";
      save.textContent = t("project.create");
      setError("");
      paintStats();
      resetDialogPosition(dialog);
      overlay.hidden = false;
      nameInput.focus();
      nameInput.select();
    },
    openSettings(project) {
      current = project;
      heading.textContent = t("project.settings");
      nameInput.value = project.name;
      rootInput.value = project.root ?? "";
      save.textContent = t("project.save");
      setError("");
      paintStats();
      resetDialogPosition(dialog);
      overlay.hidden = false;
      nameInput.focus();
      nameInput.select();
    },
    close,
    isOpen() {
      return !overlay.hidden;
    }
  };
}
