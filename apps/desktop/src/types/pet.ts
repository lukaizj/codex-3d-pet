import type { PetState } from "@codex-3d-pet/protocol";

export interface Persona {
  id: string;
  name: string;
  filePath: string;
  importedAt: string;
}

/** 桌宠动画模式：控制待机与状态动作的幅度 */
export const ANIMATION_MODES = ["calm", "lively", "expressive"] as const;
export type AnimationMode = (typeof ANIMATION_MODES)[number];

export const ANIMATION_MODE_LABELS: Record<AnimationMode, string> = {
  calm: "安静",
  lively: "活泼",
  expressive: "生动",
};

export const ANIMATION_MODE_HINTS: Record<AnimationMode, string> = {
  calm: "轻柔待机，状态差异收敛",
  lively: "自然夸张：能看懂状态，但不会乱抽",
  expressive: "更戏剧化一些，适合演示",
};

export interface PetPreferences {
  scale: number;
  clickThrough: boolean;
  animationMode: AnimationMode;
  persona?: Persona;
}

export interface Presentation {
  state: PetState;
  message?: string;
  eventId?: string;
}

export const DEFAULT_PREFERENCES: PetPreferences = {
  scale: 0.72,
  clickThrough: false,
  animationMode: "lively",
};
