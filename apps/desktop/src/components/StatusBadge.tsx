import type { PetState } from "@codex-3d-pet/protocol";

export const PET_STATE_LABELS: Record<PetState, string> = {
  idle: "空闲",
  thinking: "思考中",
  working: "工作中",
  needs_attention: "等待你的注意",
  completed: "已完成",
  error: "需要帮助",
};

/** 桌宠头顶显示的状态提示文案 */
export const PET_STATE_CAPTIONS: Record<PetState, string> = {
  idle: "空闲待机",
  thinking: "正在思考…",
  working: "认真干活中",
  needs_attention: "需要你看一眼",
  completed: "搞定啦！",
  error: "卡住了，需要帮助",
};

export function StatusBadge({ state }: { state: PetState }) {
  return <span className={`status-badge state-${state}`}>{PET_STATE_LABELS[state]}</span>;
}
