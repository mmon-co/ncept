import { z } from "zod";

export const learningReading = z.object({
  missions: z.array(
    z.object({
      id: z.string(),
      statement: z.string(),
      active: z.boolean(),
      retired: z.boolean(),
      nodes: z.number(),
      next: z.string().nullable(),
    }),
  ),
  dueReview: z.array(z.object({ id: z.string(), label: z.string() })),
  sessions: z.array(
    z.object({
      id: z.string(),
      mode: z.string(),
      closed: z.boolean(),
      title: z.string(),
      mission: z.string().optional(),
      missionLabel: z.string().optional(),
      parent: z.string().optional(),
      nodes: z.array(z.object({ id: z.string(), label: z.string() })),
      threadId: z.string().nullable().optional(),
    }),
  ),
});
export const profileChoice = z.object({
  projectId: z.string(),
  name: z.string(),
  directory: z.string(),
  hostId: z.string(),
});
