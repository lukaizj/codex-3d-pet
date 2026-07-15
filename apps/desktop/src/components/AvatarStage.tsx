import { useEffect, useRef } from "react";
import type { PetState } from "@codex-3d-pet/protocol";
import { AvatarController } from "../lib/avatar-controller";
import type { AnimationMode } from "../types/pet";

/** 动画逻辑重大更新时 +1，强制重建控制器（避免 HMR 残留旧实例） */
const CONTROLLER_REVISION = 8;

interface AvatarStageProps {
  personaPath?: string;
  scale: number;
  state: PetState;
  animationMode: AnimationMode;
  onLoadError: (message: string) => void;
  onLoadSuccess?: (filePath: string) => void;
  onControllerChange?: (controller: AvatarController | undefined) => void;
}

export function AvatarStage({
  personaPath,
  scale,
  state,
  animationMode,
  onLoadError,
  onLoadSuccess,
  onControllerChange,
}: AvatarStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<AvatarController | undefined>(undefined);

  useEffect(() => {
    if (!canvasRef.current) return;
    const controller = new AvatarController(canvasRef.current);
    controllerRef.current = controller;
    controller.setAnimationMode(animationMode);
    controller.setPresentation(state);
    onControllerChange?.(controller);
    return () => {
      controller.dispose();
      controllerRef.current = undefined;
      onControllerChange?.(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaPath, CONTROLLER_REVISION]);

  useEffect(() => {
    controllerRef.current?.setScale(scale);
  }, [scale]);

  useEffect(() => {
    controllerRef.current?.setPresentation(state);
  }, [state]);

  useEffect(() => {
    controllerRef.current?.setAnimationMode(animationMode);
  }, [animationMode]);

  useEffect(() => {
    if (!personaPath || !controllerRef.current) return;

    let active = true;
    void controllerRef.current.load(personaPath).then(
      () => {
        if (active) onLoadSuccess?.(personaPath);
      },
      (error: unknown) => {
        if (active) onLoadError(error instanceof Error ? error.message : "无法加载 VRM 角色。");
      },
    );

    return () => {
      active = false;
    };
  }, [personaPath, onLoadError, onLoadSuccess, CONTROLLER_REVISION]);

  return (
    <canvas
      key={`${personaPath ?? "empty"}-r${CONTROLLER_REVISION}`}
      ref={canvasRef}
      className="avatar-canvas"
      aria-label="3D 桌宠角色预览"
    />
  );
}
