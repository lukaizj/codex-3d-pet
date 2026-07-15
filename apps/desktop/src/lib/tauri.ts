import { invoke } from "@tauri-apps/api/core";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface BridgeInfo {
  url: string;
  secret: string;
}

const PET_WINDOW = { width: 220, height: 300 };
const SETTINGS_WINDOW = { width: 300, height: 640 };

export function getBridgeInfo() {
  return invoke<BridgeInfo>("bridge_info");
}

export function reportPersonaSelected(selected: boolean) {
  return invoke<void>("set_persona_selected", { selected });
}

export async function setClickThrough(enabled: boolean) {
  await invoke<void>("set_click_through", { enabled });
}

/** 复制用户选择的 VRM 到应用目录，返回本地稳定路径。 */
export function importVrm(sourcePath: string) {
  return invoke<string>("import_vrm", { sourcePath });
}

/** 读取本地 VRM 字节（绕过 convertFileSrc / asset 协议）。 */
export function readVrmBytes(path: string) {
  return invoke<ArrayBuffer | number[] | Uint8Array>("read_vrm_bytes", { path });
}

export function writeSelfTestResult(result: Record<string, unknown>) {
  return invoke<void>("write_self_test_result", { result });
}

export function beginWindowDrag() {
  return getCurrentWindow().startDragging();
}

export function setAlwaysOnTop(enabled: boolean) {
  return getCurrentWindow().setAlwaysOnTop(enabled);
}

/** 透明窗：关阴影 + 清背景色，避免 macOS 出现方框底。 */
export async function prepareTransparentWindow() {
  const window = getCurrentWindow();
  await Promise.all([
    window.setShadow(false).catch(() => undefined),
    window.setBackgroundColor({ red: 0, green: 0, blue: 0, alpha: 0 }).catch(() => undefined),
  ]);
}

/**
 * 打开设置时拉高窗口，并锚定右下角，让设置在人物上方展开、不挡角色。
 */
export async function layoutPetWindow(settingsOpen: boolean) {
  const window = getCurrentWindow();
  const target = settingsOpen ? SETTINGS_WINDOW : PET_WINDOW;
  const factor = await window.scaleFactor();
  const pos = await window.outerPosition();
  const old = await window.outerSize();
  const bottom = pos.y + old.height;
  const right = pos.x + old.width;

  await window.setSize(new LogicalSize(target.width, target.height));
  const newHeight = Math.round(target.height * factor);
  const newWidth = Math.round(target.width * factor);
  await window.setPosition(
    new PhysicalPosition(Math.round(right - newWidth), Math.round(bottom - newHeight)),
  );
}
