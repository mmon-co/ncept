import { z } from "zod";
import { skipStop } from "./entries";

const stop = z.object({
  kind: z.string(),
  name: z.string(),
  nodes: z.array(z.string()),
  number: z.number(),
  numbered: z.boolean(),
  cleared: z.boolean(),
  probablyKnown: z.boolean(),
  active: z.boolean(),
  minutes: z.number().optional(),
  skip: skipStop,
});
export const missionReading = z.object({
  id: z.string(),
  statement: z.string(),
  active: z.string().nullable(),
  retired: z.boolean(),
  canReviseLesson: z.boolean(),
  next: z.string().nullable(),
  checkIn: z
    .object({ milestone: z.string().optional(), required: z.boolean(), final: z.literal(true).optional() })
    .optional(),
  asides: z.array(z.string()),
  sections: z.array(
    z.object({ number: z.number(), label: z.string(), minutesLeft: z.number(), lessons: z.array(stop) }),
  ),
  history: z.array(
    z.object({
      kind: z.string(),
      at: z.string(),
      session: z.string().optional(),
      parent: z.string().optional(),
      label: z.string(),
    }),
  ),
});
