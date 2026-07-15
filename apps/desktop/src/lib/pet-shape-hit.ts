import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import type { AvatarController } from "./avatar-controller";
import { setClickThrough } from "./tauri";

const ALPHA_HIT = 12;
const POLL_MS = 32;

/**
 * 桌宠模式：按人物像素做穿透——透明处点穿到桌面，点到角色才接收鼠标。
 * 去掉可见的「假透明热区」矩形。
 */
export function usePetShapeHitTest(options: {
  enabled: boolean;
  getController: () => AvatarController | undefined;
}) {
  const ignoringRef = useRef<boolean | undefined>(undefined);
  const { enabled, getController } = options;

  useEffect(() => {
    if (!enabled) {
      ignoringRef.current = undefined;
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      if (cancelled) return;
      try {
        const controller = getController();
        const window = getCurrentWindow();
        if (!controller) {
          if (ignoringRef.current !== false) {
            ignoringRef.current = false;
            await setClickThrough(false);
          }
        } else {
          const cursor = await cursorPosition();
          const origin = await window.innerPosition();
          const factor = await window.scaleFactor();
          const x = (cursor.x - origin.x) / factor;
          const y = (cursor.y - origin.y) / factor;
          const alpha = controller.sampleAlphaAtClient(x, y);
          const shouldIgnore = alpha < ALPHA_HIT;
          if (ignoringRef.current !== shouldIgnore) {
            ignoringRef.current = shouldIgnore;
            await setClickThrough(shouldIgnore);
          }
        }
      } catch {
        // 窗口未就绪时忽略
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void tick(), POLL_MS);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      ignoringRef.current = undefined;
    };
  }, [enabled, getController]);
}
