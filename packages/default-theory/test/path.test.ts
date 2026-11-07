import { expect, test } from "bun:test";
import { resolvePatchBundle, type NodeId, type PatchRevision, type StructureEdge } from "@mmon-co/core/patch";
import { defaultTheory } from "@mmon-co/default-theory";
import { readTheoryState } from "@mmon-co/core/theory";
const now = "2026-11-06T00:00:00.000Z";
const context = (graph: import("@mmon-co/core/patch").ResolvedGraph, targets: readonly NodeId[]) => ({
  graph,
  targets,
  past: [],
  observations: [],
  activities: [],
  now,
  minutes: 20,
  projection: defaultTheory.project(graph, readTheoryState(defaultTheory, graph, [], now)),
});

test("random grouped DAG paths preserve prerequisites, contiguous sections, cone coverage and lesson grouping", () => {
  // A fixed seed makes a failing graph reproducible without a property-testing dependency.
  let seed = 12851;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let trial = 0; trial < 500; trial++) {
    const ids = Array.from({ length: 2 + Math.floor(random() * 20) }, (_, i): NodeId => `node-${i}`);
    const operations: PatchRevision["delta"]["operations"][number][] = ids.map((id) => ({
      kind: "add-node",
      node: { id },
    }));
    const milestones = new Set<NodeId>();
    for (const [i, id] of ids.entries()) {
      const sequence = Math.floor(random() * 6);
      const milestone = random() < 0.15;
      if (milestone) milestones.add(id);
      operations.push({
        kind: "add-metadata-set",
        metadataSet: {
          id: `metadata-path-${i}`,
          subjects: [{ kind: "node", id }],
          properties: {
            "pedagogy:priority": -sequence,
            "pedagogy:milestone": milestone,
            "pedagogy:elaborate": random() < 0.1,
          },
        },
      });
    }
    const edges: StructureEdge[] = [];
    for (const [i, from] of ids.entries())
      for (const [j, to] of ids.entries())
        if (i < j && random() < 0.15) {
          const edge: StructureEdge = { id: `edge-${i}-${j}`, from, to };
          edges.push(edge);
          operations.push({ kind: "add-edge", edge });
        }
    for (let group = 0; group < 4; group++)
      operations.push({
        kind: "define-tag",
        tag: {
          name: `lesson:group-${group}`,
          nodes: ids.filter(() => random() < 0.25),
          edges: [],
          metadataSets: [],
        },
      });
    const revision: PatchRevision = {
      ref: { identity: "patch-path-test", digest: `sha256:${"a".repeat(64)}` },
      bases: [],
      metadata: { properties: {}, citations: [] },
      delta: { operations },
    };
    const graph = resolvePatchBundle({ terminal: revision.ref, revisions: [revision] });
    const sinks = ids.filter((id) => !edges.some(({ from }) => from === id));
    const selected = trial % 2 === 0 ? sinks : ids.filter(() => random() < 0.3);
    const targets = selected.length ? selected : sinks;
    for (const id of targets) milestones.add(id);
    // Independent backwards closure: no route or path implementation in the oracle.
    const cone = (roots: readonly NodeId[]) => {
      const nodes = new Set(roots);
      let changed = true;
      while (changed) {
        const size = nodes.size;
        for (const { from, to } of edges) if (nodes.has(to)) nodes.add(from);
        changed = nodes.size !== size;
      }
      return nodes;
    };
    const expected = cone(targets);
    const path = defaultTheory.path(context(graph, targets));
    const seen = new Set<NodeId>();
    const claimed = new Set<NodeId>();
    for (const section of path.sections) {
      const members = new Set(section.lessons.flatMap(({ nodes }) => nodes));
      const fresh = [...cone([section.milestone])].filter((id) => !claimed.has(id));
      expect([...members].sort(), `section ownership at trial ${trial}`).toEqual(fresh.sort());
      const opening = section.lessons.filter((lesson) => lesson.checkpoint && !lesson.checkpoint.milestone);
      if (opening.length) {
        expect(section === path.sections[0], `opening check-in belongs to section 0 at trial ${trial}`).toBe(true);
        expect(section.lessons[0], `opening check-in leads at trial ${trial}`).toBe(opening[0]);
      }
      const checkpoints = section.lessons.filter((lesson) => lesson.checkpoint?.milestone);
      expect(checkpoints.length, `one checkpoint per milestone at trial ${trial}`).toBe(1);
      expect(section.lessons.at(-1), `checkpoint follows its milestone at trial ${trial}`).toBe(checkpoints[0]);
      expect(checkpoints[0]?.nodes).toEqual([section.milestone]);
      for (const lesson of section.lessons) {
        if (lesson.checkpoint) continue;
        expect(lesson.nodes.length).toBeGreaterThan(0);
        for (const id of lesson.nodes) {
          const prerequisites = edges.filter(({ to }) => to === id).map(({ from }) => from);
          expect(
            prerequisites.every((prerequisite) => seen.has(prerequisite)),
            `${id} at trial ${trial}`,
          ).toBe(true);
          seen.add(id);
        }
        if (lesson.name === undefined) expect(lesson.nodes).toHaveLength(1);
        else {
          const tag = graph.tags.find(({ name }) => name === `lesson:${lesson.name}`);
          expect(
            lesson.nodes.every((id) => tag?.nodes.includes(id)),
            `tag membership at trial ${trial}`,
          ).toBe(true);
        }
      }
      for (const id of members) {
        expect(claimed.has(id), `section contiguity at trial ${trial}`).toBe(false);
        claimed.add(id);
      }
    }
    expect([...seen].sort(), `cone coverage at trial ${trial}`).toEqual([...expected].sort());
    const lessons = path.sections.flatMap(({ lessons }) => lessons);
    for (const tag of graph.tags) {
      const name = tag.name.slice("lesson:".length);
      if (path.warnings.some((warning) => warning.name === name)) continue;
      const members = tag.nodes.filter((id) => expected.has(id) && !milestones.has(id));
      const grouped = lessons.filter((lesson) => lesson.name === name);
      expect(grouped.length, `unsplit ${tag.name} at trial ${trial}`).toBe(members.length ? 1 : 0);
      if (members.length) expect(grouped[0]?.nodes.slice().sort()).toEqual(members.slice().sort());
    }
  }
});

test("independent target sections follow target order, not priority hints", () => {
  // Authored priority cannot move an independent target ahead of the requested target order.
  type Operation = PatchRevision["delta"]["operations"][number];
  const node = (id: NodeId, sequence: number, milestone = false): Operation[] => [
    { kind: "add-node", node: { id } },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: `metadata-${id}`,
        subjects: [{ kind: "node", id }],
        properties: { "pedagogy:priority": -sequence, "pedagogy:milestone": milestone },
      },
    },
  ];
  const edge = (from: NodeId, to: NodeId): Operation => ({
    kind: "add-edge",
    edge: { id: `edge-${from}-${to}`, from, to },
  });
  const revision: PatchRevision = {
    ref: { identity: "patch-path-order", digest: `sha256:${"b".repeat(64)}` },
    bases: [],
    metadata: { properties: {}, citations: [] },
    delta: {
      operations: [
        ...node("node-words", 1),
        ...node("node-sentences", 2),
        ...node("node-conversation", 3, true),
        edge("node-words", "node-conversation"),
        edge("node-sentences", "node-conversation"),
        ...node("node-compliments", 1),
        ...node("node-social", 2, true),
        edge("node-compliments", "node-social"),
      ],
    },
  };
  const graph = resolvePatchBundle({ terminal: revision.ref, revisions: [revision] });
  const path = defaultTheory.path(context(graph, ["node-conversation", "node-social"]));
  expect(path.sections.map(({ milestone }) => milestone)).toEqual(["node-conversation", "node-social"]);
  expect(path.sections[0]?.lessons.filter((lesson) => !lesson.checkpoint).map(({ nodes }) => nodes)).toEqual([
    ["node-words"],
    ["node-sentences"],
    ["node-conversation"],
  ]);
});
