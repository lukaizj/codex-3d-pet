import { describe, expect, it } from "vitest";
import { PET_STATE_LABELS } from "./StatusBadge";

describe("PET_STATE_LABELS", () => {
  it("maps every stable protocol state to a Simplified Chinese label", () => {
    expect(PET_STATE_LABELS).toEqual({
      idle: "空闲",
      thinking: "思考中",
      working: "工作中",
      needs_attention: "等待你的注意",
      completed: "已完成",
      error: "需要帮助",
    });
  });
});
