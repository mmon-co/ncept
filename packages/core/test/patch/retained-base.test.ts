import { expect, test } from "bun:test";
import {
  candidateRevision,
  reifySparseView,
  sparseStoreFromContents,
  reifyView,
  resolvePatchBundle,
  selectGraph,
  type GraphQuery,
} from "../../src/patch";

test("retained Views use needed for a closed slice, only for cuts, and masks for suppressed properties on kept sets", async () => {
  const metadata = { properties: {}, citations: [] };
  const a = candidateRevision("patch-a", {
    metadata,
    bases: [],
    delta: {
      operations: [
        { kind: "add-node", node: { id: "node-p" } },
        { kind: "add-node", node: { id: "node-q" } },
        { kind: "add-node", node: { id: "node-x" } },
        { kind: "add-edge", edge: { id: "edge-pq", from: "node-p", to: "node-q" } },
        { kind: "define-tag", tag: { name: "empty", nodes: [], edges: [], metadataSets: [] } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-m",
            subjects: [
              { kind: "node", id: "node-q" },
              { kind: "tag", name: "empty" },
            ],
            properties: { color: "red", note: "keep" },
          },
        },
      ],
    },
  });
  const mask = {
    source: a.ref,
    operationIndex: 5,
    entity: { kind: "metadata-set", id: "metadata-m" },
    property: "color",
  } as const;
  const b = candidateRevision("patch-b", {
    metadata,
    bases: [a.ref],
    delta: {
      operations: [
        { kind: "define-tag", tag: { name: "Q", nodes: ["node-q"], edges: [], metadataSets: [] } },
        { kind: "define-tag", tag: { name: "both", nodes: ["node-p", "node-q"], edges: [], metadataSets: [] } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-label",
            subjects: [{ kind: "node", id: "node-q" }],
            properties: { "display:label": "Q" },
          },
        },
        { kind: "mask-contribution", mask },
      ],
    },
  });
  const bundle = { terminal: b.ref, revisions: [a, b] };
  const source = resolvePatchBundle(bundle);
  const q = { cone: { targets: ["node-q"] } } as const;
  for (const [query, mode] of [
    [{ cone: { targets: ["node-p"] } }, "needed"],
    [{ tag: "Q" }, "only"],
    [{ tag: "both" }, "only"],
    [{ difference: [q, { tag: "empty" }] }, "only"],
  ] satisfies [GraphQuery, "needed" | "only"][]) {
    const view = selectGraph(source, query),
      capture = candidateRevision("patch-c", reifyView(view, { metadata }, { bundle, bases: [a.ref] }));
    expect(
      await reifySparseView(
        view,
        { metadata },
        { bundle: { terminal: b.ref, store: sparseStoreFromContents(bundle.revisions) }, bases: [a.ref] },
      ),
    ).toEqual(reifyView(view, { metadata }, { bundle, bases: [a.ref] }));
    const take = capture.bases[0]?.take;
    expect(typeof take === "object" ? take.kind : take).toBe(mode);
    const masks = capture.delta.operations.flatMap((op) => (op.kind === "mask-contribution" ? [op.mask] : []));
    expect(masks).toEqual(view.metadataSets.some((s) => s.id === "metadata-m") ? [mask] : []);
    const book = candidateRevision("patch-book", { metadata, bases: [capture.ref, a.ref], delta: { operations: [] } });
    const full = resolvePatchBundle({ terminal: book.ref, revisions: [book, capture, a] });
    expect(full.nodes).toEqual(source.nodes);
    expect(full.edges).toEqual(source.edges);
    expect(full.metadataSets.find((s) => s.id === "metadata-m")?.subjects).toHaveLength(2);
    const slice = resolvePatchBundle({ terminal: capture.ref, revisions: [capture, a] });
    expect([slice.nodes, slice.edges, slice.metadataSets, slice.tags]).toEqual([
      view.nodes,
      view.edges,
      view.metadataSets,
      view.tags,
    ]);
  }
});
