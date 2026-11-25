import { isMaterialRef } from "./material.js";
import type { TagIndex } from "../theory/theory.js";
import { isContentDigest } from "../digest.js";
import { PatchCompileError } from "./errors.js";
import { contributionKey, provenanceOf, materialKey, sameExactPatchRef } from "./model.js";
import type {
  BaseQuery,
  BaseTake,
  SemanticOperation,
  EdgeId,
  ExactPatchRef,
  GraphQuery,
  MetadataSetId,
  MetadataSubject,
  NodeId,
  PatchId,
  ResolvedGraph,
  SelectedGraph,
} from "./model.js";

interface Fragment {
  readonly tags: Set<string>;
  readonly nodes: Set<NodeId>;
  readonly edges: Set<EdgeId>;
  readonly metadataSets: Set<MetadataSetId>;
}

export const GRAPH_QUERY_OPERAND_BOUNDS = {
  union: { min: 2 },
  intersection: { min: 2 },
  difference: { min: 2, max: 2 },
} as const;

function malformed(message: string): never {
  throw new PatchCompileError("malformed-query", message);
}

export function parseGraphQuery(value: unknown, label = "query"): GraphQuery {
  if (!isRecord(value)) return malformed(`${label} must be an object`);
  const raw = value;
  const keys = Object.keys(raw);
  if (keys.length !== 1) return malformed(`${label} must contain exactly one query term`);
  if (keys[0] === "tag") {
    if (typeof raw.tag !== "string" || raw.tag.length === 0)
      return malformed(`${label}.tag must be a non-empty string`);
    return { tag: raw.tag };
  }
  if (keys[0] === "cone" || keys[0] === "dependents") {
    const operation = keys[0];
    const term = raw[operation];
    if (!isRecord(term) || Object.keys(term).some((key) => key !== "targets"))
      return malformed(`${label}.${operation} must contain only targets`);
    if (!isArray(term.targets) || !term.targets.every(isNodeId))
      return malformed(`${label}.${operation}.targets must contain Node ids`);
    // An uncharted Mission saves the empty dependency cone before it has targets.
    if (operation === "cone") return { cone: { targets: term.targets } };
    const [first, ...rest] = term.targets;
    if (first === undefined) return malformed(`${label}.${operation}.targets must contain at least one Node id`);
    const targets: [NodeId, ...NodeId[]] = [first, ...rest];
    return { dependents: { targets } };
  }
  if (keys[0] === "provenance") {
    if (!isRecord(raw.provenance)) return malformed(`${label}.provenance must be an exact Patch reference`);
    const ref = raw.provenance;
    if (
      !isPatchId(ref.identity) ||
      !isContentDigest(ref.digest) ||
      Object.keys(ref).some((key) => key !== "identity" && key !== "digest")
    )
      return malformed(`${label}.provenance must be an exact Patch reference`);
    return {
      provenance: {
        identity: ref.identity,
        digest: ref.digest,
      },
    };
  }
  if (keys[0] === "union" || keys[0] === "intersection") {
    const operation = keys[0];
    const children = raw[operation];
    if (!isArray(children) || children.length < GRAPH_QUERY_OPERAND_BOUNDS[operation].min)
      return malformed(`${label}.${operation} must contain at least two terms`);
    const [first, second, ...rest] = children;
    if (first === undefined || second === undefined)
      return malformed(`${label}.${operation} must contain at least two terms`);
    const parsed: [GraphQuery, GraphQuery, ...GraphQuery[]] = [
      parseGraphQuery(first, `${label}.${operation}[0]`),
      parseGraphQuery(second, `${label}.${operation}[1]`),
      ...rest.map((child, index) => parseGraphQuery(child, `${label}.${operation}[${index + 2}]`)),
    ];
    return operation === "union" ? { union: parsed } : { intersection: parsed };
  }
  if (keys[0] === "difference") {
    if (!isArray(raw.difference) || raw.difference.length !== 2)
      return malformed(`${label}.difference must contain exactly two terms`);
    return {
      difference: [
        parseGraphQuery(raw.difference[0], `${label}.difference[0]`),
        parseGraphQuery(raw.difference[1], `${label}.difference[1]`),
      ],
    };
  }
  return malformed(`${label} has an unknown query term '${keys[0]}'`);
}

export function parseBaseQuery(value: unknown): BaseQuery {
  if (!isRecord(value) || Object.keys(value).length !== 1) return malformed("expected one base query term");
  if ("nodes" in value && isArray(value.nodes) && value.nodes.every(isNodeId)) return { nodes: value.nodes };
  for (const key of ["union", "intersection", "difference"] as const)
    if (key in value) {
      const items = value[key];
      if (!isArray(items) || items.length < 2 || (key === "difference" && items.length !== 2))
        return malformed("invalid base query operands");
      const a = parseBaseQuery(items[0]),
        b = parseBaseQuery(items[1]);
      if (key === "difference") return { difference: [a, b] };
      const terms: [BaseQuery, BaseQuery, ...BaseQuery[]] = [a, b, ...items.slice(2).map(parseBaseQuery)];
      return key === "intersection" ? { intersection: terms } : { union: terms };
    }
  const term = parseGraphQuery(value);
  if ("cone" in term || "dependents" in term || ("tag" in term && !term.tag.startsWith("is:"))) return term;
  return malformed("base queries require authored graph terms");
}

export function validateBaseTake(take: unknown): asserts take is BaseTake {
  if (take === "needed") return;
  if (!isRecord(take)) return malformed("invalid base take");
  if (take.kind === "needed" && Object.keys(take).every((k) => k === "kind" || k === "include")) {
    if ("include" in take) parseBaseQuery(take.include);
    return;
  }
  const named = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (take.kind !== "only" || !isArray(take.nodes) || !take.nodes.every(isNodeId))
    return malformed("invalid only.nodes");
  for (const [key, list] of Object.entries(take)) {
    if (key === "kind" || key === "nodes") continue;
    if (
      !["edges", "metadataSets", "materials", "tagSubjects"].includes(key) ||
      !isArray(list) ||
      !list.every((v) =>
        key === "edges"
          ? typeof v === "string" && /^edge-[0-9a-z-]+$/.test(v)
          : key === "metadataSets"
            ? typeof v === "string" && /^metadata-[0-9a-z-]+$/.test(v)
            : key === "tagSubjects"
              ? named(v)
              : isMaterialRef(v),
      )
    )
      return malformed("invalid only." + key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && /^node-[0-9a-z-]+$/.test(value);
}

function isPatchId(value: unknown): value is `patch-${string}` {
  return typeof value === "string" && /^patch-[0-9a-z-]+$/.test(value);
}

function combine(left: Fragment, right: Fragment, operation: "union" | "intersection" | "difference"): Fragment {
  const ids = <T>(leftIds: Set<T>, rightIds: Set<T>): Set<T> => {
    if (operation === "union") return new Set([...leftIds, ...rightIds]);
    if (operation === "intersection") return new Set([...leftIds].filter((id) => rightIds.has(id)));
    return new Set([...leftIds].filter((id) => !rightIds.has(id)));
  };
  return {
    tags: ids(left.tags, right.tags),
    nodes: ids(left.nodes, right.nodes),
    edges: ids(left.edges, right.edges),
    metadataSets: ids(left.metadataSets, right.metadataSets),
  };
}

function subjectInFragment(graph: ResolvedGraph, subject: MetadataSubject, fragment: Fragment): boolean {
  if (subject.kind === "node") return fragment.nodes.has(subject.id);
  if (subject.kind === "edge") return fragment.edges.has(subject.id);
  const tag = graph.tags.find(({ name }) => name === subject.name);
  return (
    fragment.tags.has(subject.name) ||
    tag?.nodes.some((id) => fragment.nodes.has(id)) === true ||
    tag?.edges.some((id) => fragment.edges.has(id)) === true
  );
}

function includeSubjects(graph: ResolvedGraph, subjects: readonly MetadataSubject[], fragment: Fragment): void {
  const includeEdge = (id: EdgeId) => {
    const edge = graph.edges.find((edge) => edge.id === id);
    if (edge === undefined) throw new PatchCompileError("dangling-metadata", `missing edge '${id}'`);
    fragment.edges.add(id);
    fragment.nodes.add(edge.from);
    fragment.nodes.add(edge.to);
  };
  for (const subject of subjects) {
    if (subject.kind === "node") fragment.nodes.add(subject.id);
    else if (subject.kind === "edge") includeEdge(subject.id);
    else {
      fragment.tags.add(subject.name);
      const tag = graph.tags.find(({ name }) => name === subject.name);
      for (const id of tag?.nodes ?? []) fragment.nodes.add(id);
      for (const id of tag?.edges ?? []) includeEdge(id);
    }
  }
}

function tagFragment(graph: ResolvedGraph, name: string, tags?: TagIndex): Fragment {
  if (name.startsWith("is:") && tags === undefined)
    throw new PatchCompileError("unknown-tag", `theory tag '${name}' requires a TagIndex`);
  const tag =
    name.startsWith("is:") && tags !== undefined
      ? { nodes: [...tags(name.slice(3))], edges: [], metadataSets: [] }
      : graph.tags.find((candidate) => candidate.name === name);
  if (tag === undefined) throw new PatchCompileError("unknown-tag", `unknown tag '${name}'`);
  for (const id of tag.nodes)
    if (!graph.nodes.some((node) => node.id === id))
      throw new PatchCompileError("dangling-tag", `tag '${name}' targets missing node '${id}'`);
  const nodes = new Set(tag.nodes);
  const edges = new Set(tag.edges);
  const metadataSets = new Set(tag.metadataSets);
  const fragment = { nodes, edges, metadataSets, tags: new Set([name]) };

  const includeEdge = (id: EdgeId): void => {
    const edge = graph.edges.find((candidate) => candidate.id === id);
    if (edge === undefined) throw new PatchCompileError("dangling-tag", `tag '${name}' targets missing edge '${id}'`);
    edges.add(id);
    nodes.add(edge.from);
    nodes.add(edge.to);
  };
  for (const edge of tag.edges) includeEdge(edge);
  for (const id of tag.metadataSets) {
    const metadata = graph.metadataSets.find((candidate) => candidate.id === id);
    if (metadata === undefined)
      throw new PatchCompileError("dangling-tag", `tag '${name}' targets missing metadata set '${id}'`);
    includeSubjects(graph, metadata.subjects, fragment);
  }
  for (const metadata of graph.metadataSets)
    if (metadata.subjects.some((subject) => subjectInFragment(graph, subject, fragment))) metadataSets.add(metadata.id);
  return fragment;
}

function coneFragment(graph: ResolvedGraph, targets: readonly NodeId[], dependents = false): Fragment {
  const nodes = new Set<NodeId>();
  const edges = new Set<EdgeId>();
  const pending = [...targets];
  while (pending.length > 0) {
    const node = pending.shift();
    if (node === undefined || nodes.has(node)) continue;
    if (!graph.nodes.some(({ id }) => id === node))
      throw new PatchCompileError(
        "dangling-query",
        `${dependents ? "dependents" : "cone"} targets missing node '${node}'`,
      );
    nodes.add(node);
    for (const edge of graph.edges)
      if ((dependents ? edge.from : edge.to) === node) {
        edges.add(edge.id);
        pending.push(dependents ? edge.to : edge.from);
      }
  }
  const fragment: Fragment = { nodes, edges, metadataSets: new Set(), tags: new Set() };
  const metadataSets = new Set(
    graph.metadataSets
      .filter((metadata) => metadata.subjects.some((subject) => subjectInFragment(graph, subject, fragment)))
      .map(({ id }) => id),
  );
  return { ...fragment, metadataSets };
}

function provenanceFragment(graph: ResolvedGraph, ref: ExactPatchRef): Fragment {
  if (!graph.patchOrder.some((candidate) => sameExactPatchRef(candidate, ref)))
    throw new PatchCompileError("unknown-provenance", "provenance selector names a Patch outside the graph");
  const contributed = (items: readonly { readonly patch: typeof ref }[] | undefined): boolean =>
    items?.some((item) => sameExactPatchRef(item.patch, ref)) === true;
  const nodes = new Set(
    graph.nodes.filter(({ id }) => contributed(provenanceOf(graph.provenance.nodes, id))).map(({ id }) => id),
  );
  const edges = new Set(
    graph.edges.filter(({ id }) => contributed(provenanceOf(graph.provenance.edges, id))).map(({ id }) => id),
  );
  const metadataSets = new Set(
    graph.metadataSets
      .filter(({ id }) => contributed(provenanceOf(graph.provenance.metadataSets, id)))
      .map(({ id }) => id),
  );
  const fragment = { nodes, edges, metadataSets, tags: new Set<string>() };
  for (const edge of graph.edges)
    if (edges.has(edge.id)) {
      nodes.add(edge.from);
      nodes.add(edge.to);
    }
  for (const metadata of graph.metadataSets)
    if (metadataSets.has(metadata.id)) includeSubjects(graph, metadata.subjects, fragment);
  for (const metadata of graph.metadataSets)
    if (metadata.subjects.some((subject) => subjectInFragment(graph, subject, fragment))) metadataSets.add(metadata.id);
  return fragment;
}

function evaluate(graph: ResolvedGraph, query: GraphQuery | BaseQuery, tags?: TagIndex, traversal = graph): Fragment {
  if ("nodes" in query)
    return { nodes: new Set(query.nodes), edges: new Set(), metadataSets: new Set(), tags: new Set() };
  if ("tag" in query) return tagFragment(graph, query.tag, tags);
  if ("cone" in query) return coneFragment(traversal, query.cone.targets);
  if ("dependents" in query) return coneFragment(traversal, query.dependents.targets, true);
  if ("provenance" in query) return provenanceFragment(graph, query.provenance);
  if ("difference" in query)
    return combine(
      evaluate(graph, query.difference[0], tags, traversal),
      evaluate(graph, query.difference[1], tags, traversal),
      "difference",
    );
  const operation = "union" in query ? "union" : "intersection";
  const children = "union" in query ? query.union : query.intersection;
  const [first, ...rest] = children;
  return rest.reduce(
    (fragment, child) => combine(fragment, evaluate(graph, child, tags, traversal), operation),
    evaluate(graph, first, tags, traversal),
  );
}

function selectedGraph(
  graph: ResolvedGraph,
  fragment: Fragment,
  roots?: ReadonlySet<string>,
  extraRoots?: ReadonlySet<string>,
  tagSubjects?: ReadonlySet<string>,
): SelectedGraph {
  const nodes = fragment.nodes;
  const edges = new Set(
    [...fragment.edges].filter((id) => {
      const edge = graph.edges.find((candidate) => candidate.id === id);
      return edge !== undefined && nodes.has(edge.from) && nodes.has(edge.to);
    }),
  );
  const selectedMetadata = graph.metadataSets.flatMap((metadata) => {
    if (!fragment.metadataSets.has(metadata.id)) return [];
    const subjects = metadata.subjects.filter((subject) =>
      subject.kind === "tag" && tagSubjects
        ? tagSubjects.has(subject.name)
        : subjectInFragment(graph, subject, { ...fragment, edges }),
    );
    return subjects.length === 0 ? [] : [{ ...metadata, subjects }];
  });
  const metadataSets = new Set(selectedMetadata.map(({ id }) => id));

  let selectedMaterials = graph.materials.filter(
    (material) =>
      (roots?.has(materialKey(material)) ?? material.about.some((id) => nodes.has(id))) ||
      extraRoots?.has(materialKey(material)),
  );
  if (selectedMaterials.some((material) => material.dependsOn?.length)) {
    const available = new Map(graph.materials.map((material) => [materialKey(material), material]));
    const selected = new Set(selectedMaterials);
    for (const material of selected)
      for (const ref of material.dependsOn ?? []) {
        const target = available.get(materialKey(ref));
        if (target) selected.add(target);
      }
    selectedMaterials = graph.materials.filter((material) => selected.has(material));
  }
  const materials = selectedMaterials.map((material) => ({
    ...material,
    about: material.about.filter((id) => nodes.has(id)),
  }));
  return {
    ...graph,
    materials,
    unavailablePlaygrounds: graph.unavailablePlaygrounds.filter((id) =>
      materials.some((material) => material.playground === id),
    ),
    nodes: graph.nodes.filter(({ id }) => nodes.has(id)),
    edges: graph.edges.filter(({ id }) => edges.has(id)),
    metadataSets: selectedMetadata,
    tags: graph.tags.map((tag) => ({
      ...tag,
      nodes: tag.nodes.filter((id) => nodes.has(id)),
      edges: tag.edges.filter((id) => edges.has(id)),
      metadataSets: tag.metadataSets.filter((id) => metadataSets.has(id)),
    })),
    provenance: {
      nodes: graph.provenance.nodes.filter(([id]) => nodes.has(id)),
      edges: graph.provenance.edges.filter(([id]) => edges.has(id)),
      metadataSets: graph.provenance.metadataSets.filter(([id]) => metadataSets.has(id)),
      materials: materials.map((material) => {
        const key = materialKey(material);
        return [key, provenanceOf(graph.provenance.materials, key) ?? []] as const;
      }),
      metadataProperties: graph.provenance.metadataProperties.filter(([id]) => metadataSets.has(id)),
    },
  };
}

/** Nodes whose every structural contribution comes from one of the selected Patches. */
export function nodesContributedOnlyBy(graph: ResolvedGraph, patches: ReadonlySet<PatchId>): ReadonlySet<NodeId> {
  return new Set(
    graph.nodes
      .filter(({ id }) => {
        const contributions = provenanceOf(graph.provenance.nodes, id);
        return (
          contributions !== undefined &&
          contributions.length > 0 &&
          contributions.every(({ patch }) => patches.has(patch.identity))
        );
      })
      .map(({ id }) => id),
  );
}

/** Project a Node subset using the same Edge, Material and metadata narrowing as query selection. */
export function selectNodeSubset(graph: ResolvedGraph, nodes: ReadonlySet<NodeId>): SelectedGraph {
  return selectedGraph(graph, {
    tags: new Set(),
    nodes: new Set(nodes),
    edges: new Set(graph.edges.map(({ id }) => id)),
    metadataSets: new Set(graph.metadataSets.map(({ id }) => id)),
  });
}

/** The export of one direct base along one dependent's path. */
export function takeBase(
  graph: ResolvedGraph,
  take: BaseTake,
  operations: readonly SemanticOperation[],
): SelectedGraph {
  validateBaseTake(take);
  const only = typeof take === "object" && take.kind === "only" ? take : undefined;
  const nodes = new Set<NodeId>(only?.nodes),
    tagNames = new Set<string>(),
    extraRoots = new Set<string>();
  const edge = (id: EdgeId) => {
    const e = graph.edges.find((x) => x.id === id);
    if (e) {
      nodes.add(e.from);
      nodes.add(e.to);
    }
  };
  const tag = (name: string) => {
    if (graph.tags.some((t) => t.name === name)) {
      tagNames.add(name);
      for (const id of tagFragment(graph, name).nodes) nodes.add(id);
    }
  };
  const subjects = (list: readonly MetadataSubject[]) => {
    for (const s of list) {
      if (s.kind === "node") nodes.add(s.id);
      else if (s.kind === "edge") edge(s.id);
      else tag(s.name);
    }
  };
  const masks = new Set(
    operations.flatMap((op) =>
      op.kind === "mask-contribution" && op.mask.entity.kind === "edge"
        ? [contributionKey(op.mask.source, op.mask.operationIndex)]
        : [],
    ),
  );
  const traversal = masks.size
    ? {
        ...graph,
        edges: graph.edges.filter((e) =>
          provenanceOf(graph.provenance.edges, e.id)?.some(
            (p) => !masks.has(contributionKey(p.patch, p.operationIndex)),
          ),
        ),
      }
    : graph;
  for (const op of operations) {
    if (op.kind === "edit-material") extraRoots.add(materialKey(op.material));
    if (op.kind === "add-material" || op.kind === "edit-material")
      for (const ref of op.material.dependsOn ?? []) extraRoots.add(materialKey(ref));
    if (only) continue;
    if (op.kind === "add-edge") {
      nodes.add(op.edge.from);
      nodes.add(op.edge.to);
    }
    if (op.kind === "add-material" || op.kind === "edit-material") for (const n of op.material.about) nodes.add(n);
    if (op.kind === "add-metadata-set") subjects(op.metadataSet.subjects);
    if (op.kind === "define-tag") {
      for (const n of op.tag.nodes) nodes.add(n);
      op.tag.edges.forEach(edge);
      for (const id of op.tag.metadataSets) subjects(graph.metadataSets.find((s) => s.id === id)?.subjects ?? []);
    }
  }
  if (!only) {
    const reachable = coneFragment(
      traversal,
      graph.nodes.filter((n) => nodes.has(n.id)).map((n) => n.id),
    );
    nodes.clear();
    for (const n of reachable.nodes) nodes.add(n);
    if (typeof take === "object" && take.kind === "needed" && take.include) {
      const inc = evaluate(graph, take.include, undefined, traversal);
      for (const n of inc.nodes) nodes.add(n);
      for (const t of inc.tags) tagNames.add(t);
    }
  }
  return selectedGraph(
    graph,
    {
      nodes,
      edges: new Set(only?.edges ?? graph.edges.map((e) => e.id)),
      metadataSets: new Set(only?.metadataSets ?? graph.metadataSets.map((s) => s.id)),
      tags: tagNames,
    },
    only?.materials && new Set(only.materials.map(materialKey)),
    extraRoots,
    only?.tagSubjects && new Set(only.tagSubjects),
  );
}

/** Select a valid attributed subgraph through the restricted tag algebra. */
export function selectGraph(graph: ResolvedGraph, query?: GraphQuery, tags?: TagIndex): SelectedGraph {
  if (query === undefined) return graph;
  return selectedGraph(graph, evaluate(graph, parseGraphQuery(query), tags));
}
