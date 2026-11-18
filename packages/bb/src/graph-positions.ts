import { graphlib, layout } from "@dagrejs/dagre";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";

export type Position = { readonly id: string; readonly x: number; readonly y: number };

/** Settled D3-force positions over the whole universe: stable across Queries. */
export function settleGraph(universe: {
  /** `label` is read only when `labelsBeside`. */
  readonly nodes: readonly { readonly id: string; readonly label?: string }[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly direction?: "up";
  /** Names sit to the right of the marks (the skill tree), so the free layout keeps each Node's name clear of the
   * others' marks and names, not just its mark. */
  readonly labelsBeside?: boolean;
  /** Free (force) unless drawn as the spine's tree, layered or radial. */
  readonly arrangement?: "layered" | "radial";
}): readonly Position[] {
  if (universe.arrangement === "layered") return layeredTree(universe);
  if (universe.arrangement === "radial") return radialTree(universe);
  const up = universe.direction === "up";
  // Upward landscapes use input order for horizontal lanes. Co-located seeds
  // and a shared x target let collision jitter choose each branch’s side.
  const particles = universe.nodes.map((node, index) => ({
    id: node.id,
    x: up ? (index - (universe.nodes.length - 1) / 2) * 80 : 0,
    y: 0,
  }));
  const lanes = new Map(particles.map((node) => [node.id, node.x]));
  // Mission progression places each Node above every prerequisite reachable from a root
  // (longest path, bounded by one pass per Node); cycles without a root stay a settled cluster.
  const levels = new Map<string, number>();
  if (up) {
    const targets = new Set(universe.edges.map((edge) => edge.to));
    for (const node of universe.nodes) if (!targets.has(node.id)) levels.set(node.id, 0);
    for (let pass = 0; pass < universe.nodes.length; pass++)
      for (const edge of universe.edges) {
        const from = levels.get(edge.from);
        if (from !== undefined && from + 1 > (levels.get(edge.to) ?? -1)) levels.set(edge.to, from + 1);
      }
  }
  forceSimulation(particles)
    .force(
      "links",
      forceLink<(typeof particles)[number], { source: string; target: string }>(
        universe.edges.map(({ from, to }) => ({ source: from, target: to })),
      )
        .id((node) => node.id)
        .distance(up ? 200 : 142)
        .strength(up ? 0.3 : 0.45),
    )
    // Upward levels spread sideways so labels beside the marks keep a landscape, not a column.
    // The upward constants were fitted to the drawn Mission graphs (docs/design/pages/mission.html and
    // mission-phone.html): the Mission's own path climbs the middle, other Missions' branches to either side.
    .force("charge", forceManyBody().strength(up ? -200 : -210))
    // The default document labels hang below marks; Mission labels sit beside them.
    .force(
      "collision",
      universe.labelsBeside
        ? rectangleCollision(universe.nodes.map((node) => nameBox(node.label ?? "")))
        : forceCollide(up ? 80 : 100).iterations(3),
    )
    .force(
      "x",
      up
        ? forceX<(typeof particles)[number]>((node) => lanes.get(node.id) ?? 0).strength(0.5)
        : forceX().strength(0.045),
    )
    .force(
      "y",
      up
        ? forceY<(typeof particles)[number]>((node) => -(levels.get(node.id) ?? 0) * 50).strength(0.3)
        : forceY().strength(0.055),
    )
    .stop()
    .tick(300);
  if (universe.labelsBeside) {
    const bodies = bodiesOf(
      particles,
      universe.nodes.map((node) => nameBox(node.label ?? "")),
    );
    // The simulation's forces can still leave overlaps; sweeps of the same push end only when none remain.
    for (let sweep = 0; sweep < 200 && separate(bodies, 1); sweep++);
  }
  return particles;
}

/** What a Node needs clear in the skill tree, as the distance to the next Node's mark: its mark (44px with its
 * ring), its name 52px to the right (Courier 20px/1.2 wrapped at 200px, as styled in hub.css), and a gap. */
type Box = { readonly width: number; readonly height: number };
const NAME_ADVANCE = 12;
const NAME_LINE = 24;
const NAME_MAX = 200;
const NAME_GAP = { x: 20, y: 14 };

function nameBox(label: string): Box {
  const advance = (word: string) => {
    let sum = 0;
    for (const char of word) sum += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 * NAME_ADVANCE : NAME_ADVANCE;
    return sum;
  };
  let lines = 1;
  let line = 0;
  let widest = 0;
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const width = advance(word);
    if (line && line + NAME_ADVANCE + width > NAME_MAX) {
      lines++;
      line = 0;
    }
    line += (line ? NAME_ADVANCE : 0) + width;
    // A word wider than the name's column breaks across lines.
    while (line > NAME_MAX) {
      lines++;
      widest = NAME_MAX;
      line -= NAME_MAX;
    }
    widest = Math.max(widest, line);
  }
  // A wrapped name fills its column.
  return {
    width: 62 + (lines > 1 ? NAME_MAX : widest) + NAME_GAP.x,
    height: Math.max(48, lines * NAME_LINE + 6) + NAME_GAP.y,
  };
}

/** A Node's settling point and the box it keeps clear, reaching right and down from the point. */
type Body = { readonly point: { x: number; y: number }; readonly box: Box };
const bodiesOf = (points: readonly { x: number; y: number }[], boxes: readonly Box[]): Body[] =>
  points.map((point, index) => ({ point, box: boxes[index] ?? { width: 0, height: 0 } }));

/** Pushes overlapping boxes apart along the axis of least overlap; returns whether any overlapped. */
function separate(bodies: readonly Body[], share: number): boolean {
  let moved = false;
  bodies.forEach((one, index) => {
    for (const other of bodies.slice(index + 1)) {
      const [a, b] = [one.point, other.point];
      const overlapX = (a.x <= b.x ? one : other).box.width - Math.abs(a.x - b.x);
      const overlapY = (a.y <= b.y ? one : other).box.height - Math.abs(a.y - b.y);
      if (overlapX <= 0 || overlapY <= 0) continue;
      moved = true;
      const axis = overlapY <= overlapX ? "y" : "x";
      const push = ((axis === "y" ? overlapY : overlapX) / 2) * share + 0.5;
      const sign = a[axis] <= b[axis] ? 1 : -1;
      a[axis] -= sign * push;
      b[axis] += sign * push;
    }
  });
  return moved;
}

/** A d3-force body per Node shaped like its mark and name, so the name keeps clear of the marks to its right. */
function rectangleCollision(boxes: readonly Box[]) {
  let bodies: Body[] = [];
  const force = () => {
    separate(bodies, 0.5);
  };
  force.initialize = (nodes: { x: number; y: number }[]) => {
    bodies = bodiesOf(nodes, boxes);
  };
  return force;
}

type Universe = Parameters<typeof settleGraph>[0];

/** The spine as Dagre's layered tree, prerequisites first, left to right. Labels hang beside the marks, so ranks sit
 * wide apart and Nodes in a rank close together. */
function layeredTree(universe: Universe): readonly Position[] {
  const primary = spine(universe);
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 46, ranksep: 190 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of universe.nodes) graph.setNode(node.id, { width: 42, height: 42 });
  for (const edge of universe.edges) if (primary.get(edge.to) === edge.from) graph.setEdge(edge.from, edge.to);
  layout(graph);
  return universe.nodes.map((node) => {
    const { x, y } = graph.node(node.id);
    return { id: node.id, x, y };
  });
}

/** The progression spine: each Node's primary prerequisite, the one deepest along the longest path from the
 * foundations. At most one per Node, so the spine is a forest rooted at the foundations; every other Edge is a
 * cross-link. */
export function spine(universe: Pick<Universe, "nodes" | "edges">): ReadonlyMap<string, string> {
  const into = new Map<string, string[]>();
  for (const edge of universe.edges) into.set(edge.to, [...(into.get(edge.to) ?? []), edge.from]);
  const depth = new Map<string, number>();
  const deep = (id: string, seen: ReadonlySet<string> = new Set()): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    const next = new Set([...seen, id]);
    const value = Math.max(-1, ...(into.get(id) ?? []).map((from) => deep(from, next))) + 1;
    depth.set(id, value);
    return value;
  };
  const primary = new Map<string, string>();
  for (const node of universe.nodes) {
    const parents = into.get(node.id) ?? [];
    const best = parents.reduce<string | undefined>(
      (chosen, from) => (chosen === undefined || deep(from) > deep(chosen) ? from : chosen),
      undefined,
    );
    if (best !== undefined && deep(best) < deep(node.id)) primary.set(node.id, best);
  }
  return primary;
}

/** What a Node needs clear in the Map: its mark and its name beside it, two lines at most. */
const LABEL_WIDTH = 212;
const LABEL_HEIGHT = 46;

/** The spine as a radial tree: the foundations round the centre, each Node a ring further out than its primary
 * prerequisite, each subtree a wedge as wide as its leaves, so separate Missions become separate sectors. */
function radialTree(universe: Universe): readonly Position[] {
  const primary = spine(universe);
  const children = new Map<string, string[]>();
  for (const node of universe.nodes) {
    const parent = primary.get(node.id);
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), node.id]);
  }
  const leaves = new Map<string, number>();
  const count = (id: string): number => {
    const value = (children.get(id) ?? []).reduce((sum, child) => sum + count(child), 0) || 1;
    leaves.set(id, value);
    return value;
  };
  // Foundations of one connected graph sit side by side, so each unrelated Mission or Patch takes one sector, with
  // a leaf's width of empty sector between them.
  const group = new Map(universe.nodes.map((node) => [node.id, node.id]));
  const find = (id: string): string => {
    const parent = group.get(id) ?? id;
    return parent === id ? id : find(parent);
  };
  for (const edge of universe.edges) group.set(find(edge.from), find(edge.to));
  const order = new Map(universe.nodes.map((node, index) => [node.id, index]));
  const componentOrder = new Map<string, number>();
  for (const node of universe.nodes)
    if (!componentOrder.has(find(node.id))) componentOrder.set(find(node.id), componentOrder.size);
  const roots = universe.nodes
    .filter((node) => !primary.has(node.id))
    .map((node) => node.id)
    .sort(
      (a, b) =>
        (componentOrder.get(find(a)) ?? 0) - (componentOrder.get(find(b)) ?? 0) ||
        (order.get(a) ?? 0) - (order.get(b) ?? 0),
    );
  const components = componentOrder.size;
  const total = roots.reduce((sum, root) => sum + count(root), 0) + (components > 1 ? components : 0);
  const depthOf = (id: string): number =>
    (children.get(id) ?? []).reduce((most, child) => Math.max(most, 1 + depthOf(child)), 0);
  const deepest = Math.max(0, ...roots.map(depthOf));
  const single = roots.length === 1;
  // Rings sit further apart than a mark and its name are wide, so no name reaches the next ring however the two
  // angles line up; and wide enough that the outermost leaves and the innermost foundations each sit a name apart.
  const ring = Math.max(
    LABEL_WIDTH + 30,
    (total * 110) / (2 * Math.PI * (deepest + (single ? 0 : 1))),
    (roots.length * 130) / (2 * Math.PI),
  );
  const polar: { id: string; angle: number; radius: number }[] = [];
  const place = (id: string, from: number, to: number, depth: number) => {
    polar.push({ id, angle: (from + to) / 2, radius: (depth + (single ? 0 : 1)) * ring });
    let start = from;
    for (const child of children.get(id) ?? []) {
      const end = start + ((to - from) * (leaves.get(child) ?? 1)) / (leaves.get(id) ?? 1);
      place(child, start, end, depth + 1);
      start = end;
    }
  };
  let start = 0;
  roots.forEach((root, index) => {
    const previous = index ? roots.at(index - 1) : undefined;
    if (components > 1 && previous !== undefined && find(previous) !== find(root)) start += (2 * Math.PI) / total;
    const end = start + (2 * Math.PI * (leaves.get(root) ?? 1)) / total;
    place(root, start, end, 0);
    start = end;
  });
  // A foundation whose dependents all chose other primary prerequisites is a one-Node tree with a thin wedge: on
  // each ring, push crowded neighbours on round the circle until their names clear each other.
  const at = (radius: number, angle: number) => ({
    x: radius * Math.cos(angle - Math.PI / 2),
    y: radius * Math.sin(angle - Math.PI / 2),
  });
  for (const radius of new Set(polar.map((point) => point.radius))) {
    if (!radius) continue;
    const onRing = polar.filter((point) => point.radius === radius).sort((a, b) => a.angle - b.angle);
    // A second sweep lets the first neighbour clear the last one round the circle.
    for (let sweep = 0; sweep < 2 && onRing.length > 1; sweep++)
      onRing.forEach((point, index) => {
        const previous = onRing.at(index - 1);
        if (!previous || (sweep === 0 && index === 0)) return;
        const before = at(radius, previous.angle - (index ? 0 : 2 * Math.PI));
        for (let step = 0; step < 400; step++) {
          const here = at(radius, point.angle);
          if (Math.abs(here.x - before.x) >= LABEL_WIDTH || Math.abs(here.y - before.y) >= LABEL_HEIGHT) break;
          point.angle += 4 / radius;
        }
      });
  }
  return polar.map(({ id, angle, radius }) => ({ id, ...at(radius, angle) }));
}
