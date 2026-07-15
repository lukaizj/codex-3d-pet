import { describe, expect, it } from "vitest";
import { applyPetEvent, idleDelay } from "./presentation";

const event = {
  version: 1 as const,
  id: "123e4567-e89b-12d3-a456-426614174000",
  state: "completed" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("presentation state", () => {
  it("applies new events and ignores repeats", () => {
    const initial = { state: "idle" as const };
    const applied = applyPetEvent(initial, event);

    expect(applied.state).toBe("completed");
    expect(applyPetEvent(applied, event)).toBe(applied);
  });

  it("returns to idle after terminal states", () => {
    expect(idleDelay(event)).toBe(6_000);
    expect(idleDelay({ ...event, state: "working", ttlSeconds: 2 })).toBe(2_000);
  });
});
