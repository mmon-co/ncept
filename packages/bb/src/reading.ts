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
export const mapReading = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      status: z.string(),
      frontier: z.boolean(),
      x: z.number(),
      y: z.number(),
    }),
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
  /** `cone` is the Mission's targets and everything they need. */
  missions: z.array(z.object({ id: z.string(), statement: z.string(), cone: z.array(z.string()) })),
});
/** The state a Node's mark shows, in the words the Map uses. */
export function stateName(node: { status: string; frontier: boolean }): string {
  if (node.status === "done") return "demonstrated";
  if (node.frontier) return "frontier";
  return node.status === "tentative" ? "tentative" : "unknown";
}
export const profileChoice = z.object({
  projectId: z.string(),
  name: z.string(),
  directory: z.string(),
  hostId: z.string(),
});
