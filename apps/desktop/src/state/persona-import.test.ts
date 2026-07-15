import { describe, expect, it } from "vitest";
import { applyPersonaImport } from "./persona-import";

const existing = {
  id: "existing",
  name: "现有角色",
  filePath: "/Users/test/existing.vrm",
  importedAt: "2026-07-15T00:00:00.000Z",
};

const candidate = {
  id: "candidate",
  name: "新角色",
  filePath: "/Users/test/candidate.vrm",
  importedAt: "2026-07-15T00:01:00.000Z",
};

describe("persona import", () => {
  it("commits the selected persona only after loading succeeds", () => {
    expect(applyPersonaImport(existing, candidate, { ok: true })).toEqual({
      persona: candidate,
      error: undefined,
    });
  });

  it("preserves the current persona when replacement loading fails", () => {
    expect(applyPersonaImport(existing, candidate, { ok: false, error: "无法读取文件" })).toEqual({
      persona: existing,
      error: "无法导入“新角色”：无法读取文件",
    });
  });
});
