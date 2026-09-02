import { selectGraph, type GraphQuery, type ResolvedGraph, type SelectedGraph } from "./patch";

export type ViewId = `view-${string}`;

export interface View {
  readonly id: ViewId;
  readonly name: string;
  readonly createdAt: string;
  readonly query: GraphQuery;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export function evaluateView(graph: ResolvedGraph, view: View): SelectedGraph {
  return selectGraph(graph, view.query);
}
