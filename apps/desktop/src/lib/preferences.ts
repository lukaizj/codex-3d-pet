import type { PetPreferences } from "../types/pet";
import { ANIMATION_MODES, DEFAULT_PREFERENCES } from "../types/pet";

const KEY = "codex-3d-pet.preferences.v1";

function normalize(preferences: PetPreferences): PetPreferences {
  const animationMode = ANIMATION_MODES.includes(preferences.animationMode)
    ? preferences.animationMode
    : DEFAULT_PREFERENCES.animationMode;
  return { ...DEFAULT_PREFERENCES, ...preferences, animationMode };
}

export function loadPreferences(): PetPreferences {
  try {
    const value = localStorage.getItem(KEY);
    if (!value) return DEFAULT_PREFERENCES;
    return normalize(JSON.parse(value) as PetPreferences);
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: PetPreferences) {
  localStorage.setItem(KEY, JSON.stringify(normalize(preferences)));
}
