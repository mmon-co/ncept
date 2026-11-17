import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { entrySchema } from "./entries";
import { learningReading, mapReading, profileChoice } from "./reading";
import { missionReading } from "./mission-reading";

// The request travels through a host-local temporary file, so a full carry never
// has to fit an OS argument or bb CLI's single-line stdin limit.
export const handoffSchema = z.object({
  session: z.string().min(1),
  mode: z.string().min(1),
  kickoff: z.string().optional(),
  learnerKickoff: z.boolean().optional(),
  carry: z
    .string()
    .max(4 * 1024 * 1024)
    .optional(),
  aside: z.boolean(),
});
const retirement = z.object({ missionId: z.string(), outcome: z.enum(["achieved", "abandoned"]) });
const sessionDescription = z.object({ session: z.string(), mode: z.string(), title: z.string() });
export const rpcContract = defineRpcContract({
  retire: { input: retirement.extend({ projectId: z.string() }), output: z.object({}), tags: () => ["learning"] },
  profiles: { input: z.object({}), output: z.array(profileChoice) },
  mission: {
    input: z.object({ projectId: z.string(), missionId: z.string() }),
    output: missionReading,
    tags: () => ["learning"],
  },
  reading: { input: z.object({ projectId: z.string() }), output: learningReading, tags: () => ["learning"] },
  map: {
    input: z.object({ projectId: z.string(), missionId: z.string().optional() }),
    output: mapReading,
    tags: () => ["learning"],
  },
  context: {
    input: z.object({ threadId: z.string() }),
    output: learningReading.shape.sessions.element.nullable(),
    tags: () => ["learning"],
  },
  threadProject: { input: z.object({ threadId: z.string() }), output: z.string().nullable() },
  open: {
    input: z.object({ projectId: z.string(), intent: entrySchema }).strict(),
    output: z.object({ threadId: z.string(), title: z.string() }),
  },
  thread: {
    input: z.object({ projectId: z.string(), session: z.string() }).strict(),
    output: z.object({ threadId: z.string().nullable() }),
  },
});
export const hostContract = defineRpcContract({
  retire: { input: retirement.extend({ directory: z.string() }), output: z.object({}) },
  recognize: { input: z.object({ directory: z.string() }), output: z.boolean() },
  mission: { input: z.object({ directory: z.string(), missionId: z.string() }), output: missionReading },
  reading: { input: z.object({ directory: z.string() }), output: learningReading },
  map: { input: z.object({ directory: z.string(), missionId: z.string().optional() }), output: mapReading },
  entry: {
    input: z.object({ directory: z.string(), intent: entrySchema }),
    output: z.object({ title: z.string(), resume: z.string().optional() }),
  },
  session: {
    input: z.object({ directory: z.string(), session: z.string() }),
    output: sessionDescription,
  },
  init: {
    input: z.object({ directory: z.string(), source: z.string().optional() }),
    output: z.object({ directory: z.string() }),
  },
  handoff: {
    input: z.object({ directory: z.string(), requestFile: z.string() }),
    output: handoffSchema.extend({ title: z.string() }),
  },
});
