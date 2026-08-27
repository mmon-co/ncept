import type { GraphCompilationInput, VisualGraph } from "./model";
import { projectVisualGraph } from "./project";
import { resolvePatchBundle } from "./resolve";
import { selectGraph } from "./select";

export function compileGraph(input: GraphCompilationInput): VisualGraph {
  const resolved = resolvePatchBundle(input.bundle);
  const selected = selectGraph(resolved, input.query);
  return projectVisualGraph({
    graph: selected,
    learner: input.learner,
    annotations: input.annotations,
  });
}
