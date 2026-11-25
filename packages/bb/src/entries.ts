import { z } from "zod";

export const skipStop = z.object({
  kind: z.string(),
  number: z.number(),
});

export const entrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skip-lesson"), missionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("skip-to"), missionId: z.string().min(1), stop: skipStop }).strict(),
  z.object({ kind: z.literal("continue"), missionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("new-mission") }).strict(),
  z
    .object({
      kind: z.literal("tell-tutor"),
      missionId: z.string().min(1),
      request: z.string().refine((value) => value.trim().length > 0, "Tell the tutor what you want to change"),
    })
    .strict(),
  z.object({ kind: z.literal("revise-lesson"), missionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("revise-route"), missionId: z.string().min(1) }).strict(),
]);
