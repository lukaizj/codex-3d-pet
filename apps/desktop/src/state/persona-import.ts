import type { Persona } from "../types/pet";

export function applyPersonaImport(
  current: Persona | undefined,
  candidate: Persona,
  result: { ok: true } | { ok: false; error: string },
) {
  if (result.ok) {
    return { persona: candidate, error: undefined };
  }

  return { persona: current, error: `无法导入“${candidate.name}”：${result.error}` };
}
