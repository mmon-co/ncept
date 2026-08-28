import type { GraphCompilationInput, VisualGraph } from "./model";
import { projectVisualGraph } from "./project";
import { resolvePatchBundle } from "./resolve";
import { selectGraph } from "./select";

export function compileGraph(input: GraphCompilationInput): VisualGraph {
  const resolved = resolvePatchBundle(input.bundle);
  const attachedNames = new Set<string>();
  for (const tag of input.attachedTags ?? []) {
    if (tag.authority === "patch")
      throw new Error(`attached tag '${tag.name}' cannot claim Patch authority`);
    if (
      resolved.tags.some((candidate) => candidate.name === tag.name) ||
      attachedNames.has(tag.name)
    )
      throw new Error(`duplicate attached tag '${tag.name}'`);
    attachedNames.add(tag.name);
  }
  const selected = selectGraph(
    { ...resolved, tags: [...resolved.tags, ...(input.attachedTags ?? [])] },
    input.query,
  );
  return projectVisualGraph({
    graph: selected,
    learner: input.learner,
    annotations: input.annotations,
  });
}
