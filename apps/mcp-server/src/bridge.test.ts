import { describe, expect, it } from "vitest";
import { bridgeConfigFromEnv } from "./bridge.js";

describe("bridge configuration", () => {
  it("requires the local bridge secret", () => {
    expect(() => bridgeConfigFromEnv({})).toThrow("CODEX_PET_SECRET");
  });

  it("uses loopback by default", () => {
    expect(bridgeConfigFromEnv({ CODEX_PET_SECRET: "test" })).toEqual({
      url: "http://127.0.0.1:38241",
      secret: "test",
    });
  });
});
