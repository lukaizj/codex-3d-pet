import type { PetEvent, PetState } from "@codex-3d-pet/protocol";
import type { Presentation } from "../types/pet";

const TERMINAL_STATES = new Set<PetState>(["completed", "error"]);

export function applyPetEvent(current: Presentation, event: PetEvent): Presentation {
  if (current.eventId === event.id) {
    return current;
  }

  return { state: event.state, message: event.message, eventId: event.id };
}

export function idleDelay(event: PetEvent): number | undefined {
  if (event.ttlSeconds) {
    return event.ttlSeconds * 1_000;
  }

  return TERMINAL_STATES.has(event.state) ? 6_000 : undefined;
}
