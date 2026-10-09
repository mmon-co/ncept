import { lastMetadataContribution, NODE_ELABORATE_PROPERTY, route, type NodeId, type ResolvedGraph } from "../../patch";
import { LESSON_TAG_PREFIX, type Lesson, type MissionPath } from "../theory";

/** Default-theory authoring metadata, not Core graph vocabulary. */
export function pathProperty(graph: ResolvedGraph, node: NodeId, key: string): unknown {
  return lastMetadataContribution(
    graph,
    graph.metadataSets.flatMap((set) => {
      if (!set.subjects.some((subject) => subject.kind === "node" && subject.id === node)) return [];
      const source = graph.provenance.metadataProperties[set.id]?.[key]?.at(-1);
      return source === undefined ? [] : [{ value: set.properties[key], source }];
    }),
  )?.value;
}

/** A topological schedule with atomic lesson groups wherever their external blockers allow it.
 * If contraction would create a cycle, emit a ready prefix and leave the rest for after the
 * outside blocker. Overlapping tags remain separate lessons; coverage is claimed by section,
 * not by lesson, so a Node may be taught in more than one group.
 */
export function pathDefault(graph: ResolvedGraph, targets: readonly NodeId[]): MissionPath {
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
  const sequence = (id: NodeId) => {
    const value = pathProperty(graph, id, "pedagogy:sequence");
    return typeof value === "number" ? value : Infinity;
  };
  const compare = (a: NodeId, b: NodeId) =>
    (sequence(a) < sequence(b) ? -1 : sequence(a) > sequence(b) ? 1 : 0) || (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
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
    // sections follow the Mission's target order; sequence hints order Nodes within a section.
    ready.sort(
      (a, b) => Number(targetSet.has(a)) - Number(targetSet.has(b)) || (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
    );
    const next = ready[0];
    if (next === undefined) throw new Error("Milestone dependency cycle");
    pendingMilestones.delete(next);
    orderedMilestones.push(next);
  }
  const milestoneSet = new Set(milestones);
  const groups = graph.tags.filter((tag) => tag.name.startsWith(LESSON_TAG_PREFIX));
  const warnings = new Map<string, MissionPath["warnings"][number]>();
  const warn = (name: string, nodes: readonly NodeId[]) => {
    warnings.set(name, { kind: "lesson-split", name: name.slice(LESSON_TAG_PREFIX.length), nodes });
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
    const units: { name?: string; nodes: NodeId[] }[] = groups.flatMap((group) => {
      const nodes = group.nodes.filter((id) => sectionOf.get(id) === index && !milestoneSet.has(id));
      return nodes.length ? [{ name: group.name.slice(LESSON_TAG_PREFIX.length), nodes: [...new Set(nodes)] }] : [];
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
      if (prefix.length !== unit.nodes.length && unit.name !== undefined)
        warn(
          LESSON_TAG_PREFIX + unit.name,
          groups.find((tag) => tag.name === LESSON_TAG_PREFIX + unit.name)?.nodes ?? unit.nodes,
        );
      section.lessons.push({ ...(unit.name === undefined ? {} : { name: unit.name }), nodes: prefix });
      for (const id of prefix) emitted.add(id);
      unit.nodes = unit.nodes.filter((id) => !prefix.includes(id));
      if (!unit.nodes.length) units.splice(units.indexOf(unit), 1);
    }
  }
  for (const [index, section] of sections.entries()) {
    const next = sections[index + 1];
    const required =
      next?.lessons.some((lesson) =>
        lesson.nodes.some((node) => pathProperty(graph, node, NODE_ELABORATE_PROPERTY) === true),
      ) ?? false;
    section.lessons.push({ nodes: [section.milestone], checkpoint: { milestone: section.milestone, required } });
  }
  return { sections, warnings: [...warnings.values()] };
}
