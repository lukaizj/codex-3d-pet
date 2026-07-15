import { z } from "zod";

export const PET_STATES = [
  "idle",
  "thinking",
  "working",
  "needs_attention",
  "completed",
  "error",
] as const;

export const PET_SEVERITIES = ["info", "success", "warning", "error"] as const;

export const MAX_MESSAGE_LENGTH = 280;
export const MAX_TTL_SECONDS = 3_600;
export const PROTOCOL_VERSION = 1;

export const petStateSchema = z.enum(PET_STATES);
export type PetState = z.infer<typeof petStateSchema>;

export const petEventSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  id: z.string().uuid(),
  state: petStateSchema,
  message: z.string().trim().max(MAX_MESSAGE_LENGTH).optional(),
  ttlSeconds: z.number().int().min(1).max(MAX_TTL_SECONDS).optional(),
  createdAt: z.string().datetime(),
});
export type PetEvent = z.infer<typeof petEventSchema>;

export const stateToolInputSchema = z.object({
  state: petStateSchema,
  message: z.string().trim().max(MAX_MESSAGE_LENGTH).optional(),
  ttl_seconds: z.number().int().min(1).max(MAX_TTL_SECONDS).optional(),
});
export type StateToolInput = z.infer<typeof stateToolInputSchema>;

export const messageToolInputSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  severity: z.enum(PET_SEVERITIES).optional(),
});
export type MessageToolInput = z.infer<typeof messageToolInputSchema>;

export const petStatusSchema = z.object({
  connected: z.boolean(),
  personaSelected: z.boolean(),
  currentState: petStateSchema,
  message: z.string().max(MAX_MESSAGE_LENGTH).optional(),
  eventId: z.string().uuid().optional(),
});
export type PetStatus = z.infer<typeof petStatusSchema>;

export function createPetEvent(input: StateToolInput): PetEvent {
  return petEventSchema.parse({
    version: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    state: input.state,
    message: input.message,
    ttlSeconds: input.ttl_seconds,
    createdAt: new Date().toISOString(),
  });
}
