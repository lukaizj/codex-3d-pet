import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { PetEvent, PetState } from "@codex-3d-pet/protocol";
import { PET_STATES } from "@codex-3d-pet/protocol";
import { AvatarStage } from "./components/AvatarStage";
import { PET_STATE_CAPTIONS, PET_STATE_LABELS, StatusBadge } from "./components/StatusBadge";
import { beginWindowDrag, getBridgeInfo, layoutPetWindow, prepareTransparentWindow, reportPersonaSelected, setAlwaysOnTop, setClickThrough } from "./lib/tauri";
import { usePetShapeHitTest } from "./lib/pet-shape-hit";
import type { AvatarController } from "./lib/avatar-controller";
import { loadPreferences, savePreferences } from "./lib/preferences";
import { applyPersonaImport } from "./state/persona-import";
import { applyPetEvent, idleDelay } from "./state/presentation";
import {
  ANIMATION_MODE_HINTS,
  ANIMATION_MODE_LABELS,
  ANIMATION_MODES,
  type AnimationMode,
  type PetPreferences,
  type Presentation,
} from "./types/pet";

const INITIAL_PRESENTATION: Presentation = { state: "idle" };

function stateLabel(state: PetState) {
  return PET_STATE_LABELS[state];
}

export function App() {
  const [preferences, setPreferences] = useState<PetPreferences>(() => loadPreferences());
  const [pendingPersona, setPendingPersona] = useState<PetPreferences["persona"]>();
  const [presentation, setPresentation] = useState<Presentation>(INITIAL_PRESENTATION);
  const [bridgeSecret, setBridgeSecret] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(() => !Boolean(loadPreferences().persona));
  const [error, setError] = useState<string>();
  const idleTimer = useRef<number | undefined>(undefined);
  const avatarControllerRef = useRef<AvatarController | undefined>(undefined);

  const persist = useCallback((next: PetPreferences) => {
    setPreferences(next);
    savePreferences(next);
  }, []);

  const resetIdleTimer = useCallback((event: PetEvent) => {
    window.clearTimeout(idleTimer.current);
    const delay = idleDelay(event);
    if (!delay) return;

    idleTimer.current = window.setTimeout(() => {
      setPresentation({ state: "idle" });
    }, delay);
  }, []);

  useEffect(() => {
    void prepareTransparentWindow().catch(() => undefined);
    getBridgeInfo().then((info) => setBridgeSecret(info.secret)).catch(() => setError("本地连接桥未能启动。"));
    reportPersonaSelected(Boolean(preferences.persona)).catch(() => undefined);

    let unlistenEvent: (() => void) | undefined;
    let unlistenMessage: (() => void) | undefined;
    let unlistenInputRestored: (() => void) | undefined;
    let unlistenOpenSettings: (() => void) | undefined;
    void listen<PetEvent>("pet://event", (event) => {
      setPresentation((current) => applyPetEvent(current, event.payload));
      resetIdleTimer(event.payload);
    }).then((unlisten) => {
      unlistenEvent = unlisten;
    });
    void listen<{ message: string }>("pet://message", (event) => {
      setPresentation((current) => ({ ...current, message: event.payload.message }));
    }).then((unlisten) => {
      unlistenMessage = unlisten;
    });
    void listen("pet://input-restored", () => {
      setPreferences((current) => {
        const next = { ...current, clickThrough: false };
        savePreferences(next);
        return next;
      });
    }).then((unlisten) => {
      unlistenInputRestored = unlisten;
    });
    void listen("pet://open-settings", () => {
      setPreferences((current) => {
        if (!current.clickThrough) return current;
        const next = { ...current, clickThrough: false };
        savePreferences(next);
        return next;
      });
      setSettingsOpen(true);
    }).then((unlisten) => {
      unlistenOpenSettings = unlisten;
    });

    return () => {
      window.clearTimeout(idleTimer.current);
      unlistenEvent?.();
      unlistenMessage?.();
      unlistenInputRestored?.();
      unlistenOpenSettings?.();
    };
  }, [preferences.persona, resetIdleTimer]);

  // 启动时先关掉穿透，避免上次残留导致整窗点不到
  useEffect(() => {
    void setClickThrough(false).catch(() => undefined);
    if (preferences.clickThrough) {
      persist({ ...preferences, clickThrough: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void setAlwaysOnTop(Boolean(preferences.persona)).catch(() => undefined);
  }, [preferences.persona]);

  useEffect(() => {
    if (settingsOpen) {
      void setClickThrough(false).catch(() => undefined);
      return;
    }
    if (preferences.clickThrough) {
      void setClickThrough(true).catch(() => undefined);
    }
  }, [settingsOpen, preferences.clickThrough]);

  // 设置面板展开时窗口上移增高，人物仍在下方不被挡住
  useEffect(() => {
    if (!preferences.persona) return;
    void layoutPetWindow(settingsOpen).catch(() => undefined);
  }, [preferences.persona, settingsOpen]);

  const hasPersona = Boolean(preferences.persona);
  const petMode = hasPersona && !settingsOpen;

  const getAvatarController = useCallback(() => avatarControllerRef.current, []);
  usePetShapeHitTest({
    enabled: petMode && !preferences.clickThrough,
    getController: getAvatarController,
  });

  const selectPersona = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "VRM 角色", extensions: ["vrm"] }],
    });
    if (!selected || Array.isArray(selected)) return;

    const name = selected.split(/[\\/]/).pop()?.replace(/\.vrm$/i, "") || "VRM 角色";
    setPendingPersona({ id: crypto.randomUUID(), name, filePath: selected, importedAt: new Date().toISOString() });
    setError(undefined);
  };

  const handleAvatarLoadSuccess = useCallback(
    (filePath: string) => {
      if (!pendingPersona || pendingPersona.filePath !== filePath) return;

      const result = applyPersonaImport(preferences.persona, pendingPersona, { ok: true });
      persist({ ...preferences, persona: result.persona });
      setPendingPersona(undefined);
      setError(undefined);
      setSettingsOpen(false);
      void reportPersonaSelected(true);
    },
    [pendingPersona, preferences, persist],
  );

  const handleAvatarLoadError = useCallback(
    (message: string) => {
      if (!pendingPersona) {
        setError(message);
        return;
      }

      const result = applyPersonaImport(preferences.persona, pendingPersona, { ok: false, error: message });
      setPendingPersona(undefined);
      setError(result.error);
      void reportPersonaSelected(Boolean(result.persona));
    },
    [pendingPersona, preferences.persona],
  );

  const handleAvatarLoadWarning = useCallback((message: string) => {
    setError(message);
  }, []);

  const removePersona = async () => {
    setPendingPersona(undefined);
    persist({ ...preferences, persona: undefined });
    setSettingsOpen(true);
    await reportPersonaSelected(false);
  };

  const toggleClickThrough = async () => {
    const next = !preferences.clickThrough;
    try {
      await setClickThrough(next);
      persist({ ...preferences, clickThrough: next });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法更新鼠标穿透设置。");
    }
  };

  const setScale = (scale: number) => persist({ ...preferences, scale });

  const setAnimationMode = (animationMode: AnimationMode) => persist({ ...preferences, animationMode });

  const openSettings = useCallback(() => {
    // 打开设置时关闭穿透，否则面板点不到
    if (preferences.clickThrough) {
      void setClickThrough(false).catch(() => undefined);
      persist({ ...preferences, clickThrough: false });
    }
    setSettingsOpen(true);
  }, [persist, preferences]);

  const toggleSettings = useCallback(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    openSettings();
  }, [openSettings, settingsOpen]);

  const handlePetPointerDown = (event: ReactPointerEvent) => {
    const alpha =
      avatarControllerRef.current?.sampleAlphaAtClient(event.clientX, event.clientY) ?? 255;
    // 空白透明处不拖、不开设置（形状穿透未切换瞬间的兜底）
    if (hasPersona && alpha < 12) return;

    // 右键 / 两指点按：打开设置（比 contextmenu 在 canvas 上更稳）
    if (event.button === 2) {
      event.preventDefault();
      event.stopPropagation();
      toggleSettings();
      return;
    }
    if (event.button !== 0) return;
    if (preferences.clickThrough) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, a, label, pre, [data-no-drag]")) return;
    event.preventDefault();
    void beginWindowDrag();
  };

  const handlePetContextMenu = (event: MouseEvent) => {
    const alpha =
      avatarControllerRef.current?.sampleAlphaAtClient(event.clientX, event.clientY) ?? 255;
    if (hasPersona && alpha < 12) return;
    event.preventDefault();
    event.stopPropagation();
    toggleSettings();
  };

  const handlePetDoubleClick = (event: MouseEvent) => {
    const alpha =
      avatarControllerRef.current?.sampleAlphaAtClient(event.clientX, event.clientY) ?? 255;
    if (hasPersona && alpha < 12) return;
    event.preventDefault();
    toggleSettings();
  };

  const mcpSnippet = useMemo(() => {
    if (!bridgeSecret) return "正在启动本地连接桥…";
    return `[mcp_servers.codex_3d_pet]\ncommand = "pnpm"\nargs = ["--dir", "${"/absolute/path/to/codex-3d-pet/apps/mcp-server"}", "start"]\nenv = { CODEX_PET_SECRET = "${bridgeSecret}", CODEX_PET_URL = "http://127.0.0.1:38241" }`;
  }, [bridgeSecret]);

  const copyMcpSnippet = async () => {
    await navigator.clipboard.writeText(mcpSnippet);
  };

  const shellClass = [
    "pet-shell",
    `state-${presentation.state}`,
    hasPersona ? "has-persona" : "",
    petMode ? "pet-mode" : "",
    settingsOpen ? "settings-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main
      className={shellClass}
      onContextMenu={handlePetContextMenu}
      onDoubleClick={handlePetDoubleClick}
    >
      {settingsOpen && (
        <header className="pet-header" data-tauri-drag-region>
          <div data-tauri-drag-region>
            <p className="eyebrow">CODEX 3D 桌宠</p>
            <StatusBadge state={presentation.state} />
          </div>
          {hasPersona && (
            <button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭设置">
              ×
            </button>
          )}
        </header>
      )}

      <section
        className={`avatar-area${hasPersona ? " has-model" : ""}${petMode ? " pet-drag" : ""}`}
        data-tauri-drag-region={!hasPersona ? true : undefined}
        onPointerDown={hasPersona ? handlePetPointerDown : undefined}
        onContextMenu={hasPersona ? handlePetContextMenu : undefined}
        onDoubleClick={hasPersona ? handlePetDoubleClick : undefined}
      >
        <AvatarStage
          personaPath={pendingPersona?.filePath ?? preferences.persona?.filePath}
          scale={preferences.scale}
          state={presentation.state}
          animationMode={preferences.animationMode}
          onLoadError={handleAvatarLoadError}
          onLoadSuccess={handleAvatarLoadSuccess}
          onLoadWarning={handleAvatarLoadWarning}
          onControllerChange={(controller) => {
            avatarControllerRef.current = controller;
          }}
        />
        {petMode && (
          <p className={`state-caption state-${presentation.state}`} data-no-drag>
            {PET_STATE_CAPTIONS[presentation.state]}
          </p>
        )}
        {!hasPersona && (
          <div className="empty-avatar">
            <span>✦</span>
            <h1>导入你的专属角色</h1>
            <p>请导入你拥有使用权的 VRM 文件。导入后右键角色即可打开设置。</p>
            <button className="primary-button" onClick={() => void selectPersona()} data-no-drag>
              导入 VRM
            </button>
          </div>
        )}
        {presentation.message && (
          <p className="speech-bubble" data-no-drag>
            {presentation.message}
          </p>
        )}
      </section>

      {settingsOpen && (
        <aside className="settings-panel" data-no-drag>
          <section>
            <div className="section-heading">
              <h2>角色</h2>
              {preferences.persona && <span className="persona-name">{preferences.persona.name}</span>}
            </div>
            <div className="button-row">
              <button className="secondary-button" onClick={() => void selectPersona()}>
                {preferences.persona ? "更换 VRM" : "导入 VRM"}
              </button>
              {preferences.persona && (
                <button className="quiet-button" onClick={() => void removePersona()}>
                  移除
                </button>
              )}
            </div>
            <p className="hint">右键角色开关设置。点不到时用托盘「打开设置」。</p>
          </section>

          <section>
            <div className="section-heading">
              <h2>动画模式</h2>
              <span className="persona-name">{ANIMATION_MODE_LABELS[preferences.animationMode]}</span>
            </div>
            <div className="mode-grid">
              {ANIMATION_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={preferences.animationMode === mode ? "active" : ""}
                  onClick={() => setAnimationMode(mode)}
                >
                  <strong>{ANIMATION_MODE_LABELS[mode]}</strong>
                  <span>{ANIMATION_MODE_HINTS[mode]}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="section-heading">
              <h2>桌宠行为</h2>
              <output>{Math.round(preferences.scale * 100)}%</output>
            </div>
            <input
              aria-label="角色缩放"
              type="range"
              min="0.5"
              max="1.7"
              step="0.05"
              value={preferences.scale}
              onChange={(event) => setScale(Number(event.target.value))}
            />
            <label className="toggle-row">
              <span>鼠标穿透角色</span>
              <input type="checkbox" checked={preferences.clickThrough} onChange={() => void toggleClickThrough()} />
            </label>
            <p className="hint">开启后无法拖动或右键；可从托盘选择「恢复桌宠鼠标交互」。</p>
          </section>

          <section>
            <div className="section-heading">
              <h2>Codex 连接</h2>
              <span className="connection-dot">本地连接桥</span>
            </div>
            <p className="hint">将下方内容复制到 Codex Desktop 的 MCP 配置中，然后让 Codex 调用 <code>get_pet_status</code>。</p>
            <pre>{mcpSnippet}</pre>
            <button className="secondary-button" onClick={() => void copyMcpSnippet()} disabled={!bridgeSecret}>
              复制 MCP 配置
            </button>
          </section>

          <section className="manual-state">
            <h2>预览状态</h2>
            <p className="hint">点一下可预览工作中 / 思考中等动作，也可由 Codex 通过 MCP 切换。</p>
            <div className="state-grid">
              {PET_STATES.map((state) => (
                <button key={state} className={presentation.state === state ? "active" : ""} onClick={() => setPresentation({ state })}>
                  {stateLabel(state)}
                </button>
              ))}
            </div>
          </section>
        </aside>
      )}

      {error && <p className="error-banner">{error}</p>}
    </main>
  );
}
