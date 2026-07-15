import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_LENGTH, createPetEvent, stateToolInputSchema } from "./index.js";

describe("Codex pet protocol", () => {
  it("creates a versioned event", () => {
    const event = createPetEvent({ state: "working", message: "Updating files", ttl_seconds: 30 });

    expect(event.state).toBe("working");
    expect(event.version).toBe(1);
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects invalid states and oversized messages", () => {
    expect(() => stateToolInputSchema.parse({ state: "flying" })).toThrow();
    expect(() => stateToolInputSchema.parse({ state: "idle", message: "x".repeat(MAX_MESSAGE_LENGTH + 1) })).toThrow();
  });
});
