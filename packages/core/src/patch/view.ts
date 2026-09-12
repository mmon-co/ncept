import type { TagIndex } from "../theory/theory";
import type { GraphQuery, ResolvedGraph, SelectedGraph } from "./model";
import { selectGraph } from "./select";

export type ViewId = `view-${string}`;

export interface View {
  readonly id: ViewId;
  readonly name: string;
  readonly createdAt: string;
  readonly query: GraphQuery;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export function evaluateView(graph: ResolvedGraph, view: View, tags?: TagIndex): SelectedGraph {
  return selectGraph(graph, view.query, tags);
}
