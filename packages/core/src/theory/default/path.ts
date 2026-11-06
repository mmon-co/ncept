import {
  lastMetadataContribution,
  metadataSetsForEntity,
  NODE_ELABORATE_PROPERTY,
  nodeCascadedProperty,
  route,
  unscopedCopyTagName,
  type NodeId,
  type ResolvedGraph,
} from "../../patch";
import { dependentCones } from "./dependent-cone";
import {
  LESSON_TAG_PREFIX,
  tagIndex,
  type Lesson,
  type MissionPath,
  type MissionFuture,
  type PathContext,
} from "../theory";
import { prepareEstimateDefault, progressDefault } from "./reading";

/** Default-theory authoring metadata, not Core graph vocabulary. */
export function pathProperty(graph: ResolvedGraph, node: NodeId, key: string): unknown {
  return lastMetadataContribution(
    graph,
    metadataSetsForEntity(graph, { kind: "node", id: node }).flatMap((set) => {
      const source = graph.provenance.metadataProperties[set.id]?.[key]?.at(-1);
      return source === undefined ? [] : [{ value: set.properties[key], source }];
    }),
  )?.value;
}

/** Default-theory hint: an absolute integer, higher first, inherited from tags. */
export function nodePriority(graph: ResolvedGraph, node: NodeId): number {
  const value = nodeCascadedProperty(graph, node, "pedagogy:priority");
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

/** A topological schedule with atomic lesson groups wherever their external blockers allow it.
 * If contraction would create a cycle, emit a ready prefix and leave the rest for after the
 * outside blocker. Overlapping tags remain separate lessons; coverage is claimed by section,
 * not by lesson, so a Node may be taught in more than one group.
 */
export function teachingPath(graph: ResolvedGraph, targets: readonly NodeId[]): MissionPath {
  const stable: NodeId[] = [];
  const cones = new Map<NodeId, readonly NodeId[]>();
  const cone = (id: NodeId) => {
    let held = cones.get(id);
    if (held === undefined) {
      const result = route(graph, id);
      held = result.kind === "found" ? result.nodes.map(({ id }) => id) : [];
      cones.set(id, held);
    }
    return held;
  };
  for (const target of targets) for (const id of cone(target)) if (!stable.includes(id)) stable.push(id);
  const rank = new Map(stable.map((id, index) => [id, index]));
  const dependents = dependentCones(graph);
  const priority = new Map(stable.map((id) => [id, nodePriority(graph, id)]));
  const importance = new Map(stable.map((id) => [id, dependents(id).filter((node) => rank.has(node)).length]));
  const compare = (a: NodeId, b: NodeId) =>
    (priority.get(b) ?? 0) - (priority.get(a) ?? 0) ||
    (importance.get(b) ?? 0) - (importance.get(a) ?? 0) ||
    (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  const prerequisites = new Map<NodeId, NodeId[]>(stable.map((id) => [id, []]));
  for (const edge of graph.edges) prerequisites.get(edge.to)?.push(edge.from);
  const targetSet = new Set(targets);
  const milestones = stable.filter((id) => targetSet.has(id) || pathProperty(graph, id, "pedagogy:milestone") === true);
  const pendingMilestones = new Set(milestones);
  const orderedMilestones: NodeId[] = [];
  while (pendingMilestones.size) {
    const ready = [...pendingMilestones].filter((id) =>
      cone(id).every((prerequisite) => prerequisite === id || !pendingMilestones.has(prerequisite)),
    );
    // Targets are the final milestones unless another target depends on them. Independent
    // sections follow the Mission's target order; independent non-target milestones use priority.
    ready.sort(
      (a, b) =>
        Number(targetSet.has(a)) - Number(targetSet.has(b)) ||
        (targetSet.has(a) && targetSet.has(b) ? (rank.get(a) ?? 0) - (rank.get(b) ?? 0) : compare(a, b)),
    );
    const next = ready[0];
    if (next === undefined) throw new Error("Milestone dependency cycle");
    pendingMilestones.delete(next);
    orderedMilestones.push(next);
  }
  const milestoneSet = new Set(milestones);
  const groups = graph.tags.filter((tag) => unscopedCopyTagName(tag.name).startsWith(LESSON_TAG_PREFIX));
  const warnings = new Map<string, MissionPath["warnings"][number]>();
  const warn = (name: string, nodes: readonly NodeId[]) => {
    warnings.set(name, {
      kind: "lesson-split",
      name: unscopedCopyTagName(name).slice(LESSON_TAG_PREFIX.length),
      nodes,
    });
  };
  const claimed = new Set<NodeId>();
  const sections: { milestone: NodeId; lessons: Lesson[] }[] = [];
  const sectionOf = new Map<NodeId, number>();
  for (const milestone of orderedMilestones) {
    const members = cone(milestone).filter((id) => !claimed.has(id));
    for (const id of members) {
      claimed.add(id);
      sectionOf.set(id, sections.length);
    }
    sections.push({ milestone, lessons: [] });
  }
  for (const group of groups) {
    const members = group.nodes.filter((id) => sectionOf.has(id));
    if (
      new Set(members.map((id) => sectionOf.get(id))).size > 1 ||
      (members.some((id) => milestoneSet.has(id)) && members.length > 1)
    )
      warn(group.name, members);
  }
  const emitted = new Set<NodeId>();
  for (const [index, section] of sections.entries()) {
    const members = stable.filter((id) => sectionOf.get(id) === index);
    const units: { name?: string; groupKey?: string; nodes: NodeId[] }[] = groups.flatMap((group) => {
      const nodes = group.nodes.filter((id) => sectionOf.get(id) === index && !milestoneSet.has(id));
      return nodes.length
        ? [
            {
              name: unscopedCopyTagName(group.name).slice(LESSON_TAG_PREFIX.length),
              groupKey: group.name,
              nodes: [...new Set(nodes)],
            },
          ]
        : [];
    });
    const grouped = new Set(units.flatMap(({ nodes }) => nodes));
    for (const id of members) if (!grouped.has(id)) units.push({ nodes: [id] });
    const readyPrefix = (unit: (typeof units)[number]) => {
      const remaining = new Set(unit.nodes);
      const local = new Set(emitted);
      const prefix: NodeId[] = [];
      while (remaining.size) {
        const next = [...remaining]
          .filter((id) => (prerequisites.get(id) ?? []).every((prerequisite) => local.has(prerequisite)))
          .sort(compare)[0];
        if (next === undefined) break;
        remaining.delete(next);
        local.add(next);
        prefix.push(next);
      }
      return prefix;
    };

    while (units.length) {
      const candidates = units.map((unit) => ({ unit, prefix: readyPrefix(unit) }));
      const whole = candidates.filter(({ unit, prefix }) => prefix.length === unit.nodes.length);
      const available = whole.length ? whole : candidates.filter(({ prefix }) => prefix.length);
      available.sort((a, b) => {
        const left = a.prefix[0],
          right = b.prefix[0];
        return left === undefined || right === undefined ? 0 : compare(left, right);
      });
      const chosen = available[0];
      if (chosen === undefined) throw new Error("Lesson dependency cycle");
      const { unit, prefix } = chosen;
      if (prefix.length !== unit.nodes.length && unit.groupKey !== undefined)
        warn(unit.groupKey, groups.find((tag) => tag.name === unit.groupKey)?.nodes ?? unit.nodes);
      section.lessons.push({
        kind: "lesson",
        numbered: true,
        ...(unit.name === undefined ? {} : { name: unit.name, tag: unit.name }),
        nodes: prefix,
      });
      for (const id of prefix) emitted.add(id);
      unit.nodes = unit.nodes.filter((id) => !prefix.includes(id));
      if (!unit.nodes.length) units.splice(units.indexOf(unit), 1);
    }
  }
  for (const [index, section] of sections.entries()) {
    const next = sections[index + 1];
    const required =
      next === undefined ||
      next.lessons.some((lesson) =>
        lesson.nodes.some((node) => pathProperty(graph, node, NODE_ELABORATE_PROPERTY) === true),
      );
    section.lessons.push({
      kind: "checkpoint",
      numbered: false,
      milestone: section.milestone,
      nodes: [section.milestone],
      checkpoint: { milestone: section.milestone, required, ...(next === undefined ? { final: true } : {}) },
    });
  }
  // Nothing precedes the first span, so its check-in has no milestone and is due only while the span is coarse.
  const first = sections[0];
  if (
    first?.lessons.some((lesson) =>
      lesson.nodes.some((node) => pathProperty(graph, node, NODE_ELABORATE_PROPERTY) === true),
    )
  )
    first.lessons.unshift({ kind: "checkpoint", numbered: false, nodes: [], checkpoint: { required: true } });
  return { sections, warnings: [...warnings.values()] };
}

/** Most overdue first, with deterministic ties independent of projection assembly order. */
function ranked(nodes: readonly NodeId[], context: PathContext): NodeId[] {
  const rank = (id: NodeId) => context.projection.nodes[id]?.find((tag) => tag.tag === "review:due")?.rank ?? 0;
  return [...nodes].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
}

/** Nodes are indivisible: an over-budget first Node must still make progress. */
function packed(candidates: readonly NodeId[], context: PathContext): NodeId[] {
  const estimate = prepareEstimateDefault(context);
  const nodes: NodeId[] = [];
  for (const node of ranked(candidates, context)) {
    if (
      nodes.length &&
      estimate([{ kind: "review", numbered: false, nodes: [...nodes, node] }]).minutes > context.minutes
    )
      break;
    nodes.push(node);
  }
  return nodes;
}

/** Retention ranks vary continuously. A projected reading alone cannot promise the next
 * membership or rank crossing, so a retention-dependent future expires at the next clock
 * millisecond, not at the (possibly much later) completion expiry. Evidence-free previews
 * can retain the projection's own boundary. No timer or host polling preference lives here.
 */
function pathValidity(context: PathContext): Pick<MissionPath, "validUntil"> {
  const retention = Object.values(context.projection.nodes).some((tags) =>
    tags.some(({ tag }) => tag === "demonstrated" || tag === "probably-known" || tag.startsWith("review:")),
  );
  const boundaries = [
    context.projection.validUntil,
    ...(retention ? [new Date(Date.parse(context.now) + 1).toISOString()] : []),
  ].filter((at) => at !== undefined);
  const validUntil = boundaries.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return validUntil === undefined ? {} : { validUntil };
}

/** The syllabus stays addressable as progress changes; only the future is upcoming.
 * A trailing unnumbered review is maintenance; a review with numberOffset 1 blocks the
 * following teaching stop. A graph-wide reading has only maintenance, and no Mission.
 */
export function pathDefault(context: PathContext): MissionFuture {
  if (context.retired?.outcome === "abandoned") return { sections: [], warnings: [], future: [] };
  const { graph, targets, projection } = context;
  const path = teachingPath(graph, targets ?? []);
  const tags = tagIndex(projection);
  const scope =
    targets === undefined
      ? new Set(graph.nodes.map(({ id }) => id))
      : new Set(path.sections.flatMap(({ lessons }) => lessons.flatMap(({ nodes }) => nodes)));
  const due = packed(
    graph.nodes.map(({ id }) => id).filter((id) => scope.has(id) && tags("review:due").has(id)),
    context,
  );
  const maintenance: Lesson[] = due.length ? [{ kind: "review", numbered: false, nodes: due }] : [];
  if (context.retired?.outcome === "achieved" || targets === undefined)
    return { ...path, ...pathValidity(context), future: maintenance };

  const progress = progressDefault(graph, projection, [...scope]);
  const next = path.sections
    .flatMap(({ lessons }) => lessons)
    .find((lesson) => lesson.numbered && lesson.nodes.some((id) => progress[id]?.status === "open"));
  const cone = new Set(
    next?.nodes.flatMap((id) => {
      const result = route(graph, id);
      return result.kind === "found" ? result.nodes.map(({ id }) => id) : [];
    }) ?? [],
  );
  const fading = packed(
    graph.nodes
      .map(({ id }) => id)
      .filter((id) => cone.has(id) && !next?.nodes.includes(id) && tags("review:fading").has(id)),
    context,
  );
  const sections = path.sections.map((section) => ({
    ...section,
    lessons: section.lessons.flatMap((lesson) =>
      lesson === next && fading.length
        ? [{ kind: "review", numbered: false, numberOffset: 1, nodes: fading }, lesson]
        : [lesson],
    ),
  }));
  return {
    ...path,
    ...pathValidity(context),
    sections,
    future: [
      ...sections
        .flatMap(({ lessons }) => lessons)
        .filter((lesson) => !lesson.numbered || lesson.nodes.some((id) => progress[id]?.status === "open")),
      ...maintenance,
    ],
  };
}
