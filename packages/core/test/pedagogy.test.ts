import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  LocalDirectoryCoreStore,
  contentDigest,
  parameterOverride,
  pedagogicalTheoryDigest,
  resolvePedagogy,
  resolveTheoryParameters,
  sessionPedagogyMetadata,
  type PedagogyRelease,
  type ProjectionContext,
} from "../src";
import { tempDataDir } from "./helpers";
import {
  graph,
  rootRelease,
  sampleRecord,
  sampleSchema,
  sampleTheory,
  scope,
  source,
  type Sample,
  type SampleState,
  type SampleToolContext,
} from "./record-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a non-default numeric stub fills the complete PedagogicalTheory slot with explicit time and parameters", () => {
  const theory = sampleTheory();
  const context: ProjectionContext = {
    at: "2026-09-07T12:00:00.000Z",
    parameters: theory.parameters,
    theoryDigest: pedagogicalTheoryDigest(theory),
  };
  const projected = theory.project([sampleRecord()], graph, context);
  expect(projected).toMatchObject({
    patchRevision: graph.terminal,
    theoryDigest: context.theoryDigest,
    nodes: { "node-sample": { total: 7, at: context.at } },
  });
  expect(theory.project([sampleRecord()], graph, { ...context, scope: [] }).nodes).toEqual({});
  expect(theory.update(projected, graph, graph, [sampleRecord()], context)).toEqual(projected);
  const node = graph.nodes[0];
  if (node === undefined) throw new Error("Missing fixture Node");
  expect(theory.display(node, projected)).toMatchObject({
    label: "sample",
    citations: [],
    style: { color: "blue" },
  });
  expect(theory.display({ id: "edge-test", from: node.id, to: node.id }, projected).label).toBe(
    "sample",
  );
  expect(theory.queryTokens.sampled?.(projected, graph)).toEqual(new Set(["node-sample"]));
  expect(theory.tools).toHaveLength(1);
  expect(theory.skills.bundles[0]?.name).toBe("sample");
  expect(theory.indicators(projected, graph)).toEqual([]);
  expect(theory.convert?.([])).toEqual([]);
});

test("package resolution preserves invocable typed host ports and session metadata", () => {
  const root = rootRelease();
  const resolved = resolvePedagogy(source([root]), root.ref);
  const factory = resolved.theory.theory.tools[0];
  if (factory === undefined) throw new Error("Missing fixture tool factory");
  const reads: number[] = [];
  expect(factory({ onRead: (value) => reads.push(value) })).toEqual({});
  expect(reads).toEqual([7]);
  // @ts-expect-error The resolved factory still requires the package's typed host port.
  const incompatible: Parameters<typeof factory>[0] = { onRead: "not callable" };
  expect(typeof incompatible.onRead).toBe("string");
  expect(sessionPedagogyMetadata(resolved)).toEqual({
    pedagogyRelease: root.ref,
    theoryDigest: resolved.theory.digest,
    skillCatalogDigest: resolved.skillCatalogDigest,
  });
});

test("theory digests cover artifact, schema identities and effective parameters, never Skill-only content", () => {
  const theory = sampleTheory();
  const digest = pedagogicalTheoryDigest(theory);
  expect(
    pedagogicalTheoryDigest({ ...theory, implementationDigest: contentDigest("artifact v2") }),
  ).not.toBe(digest);
  expect(
    pedagogicalTheoryDigest({
      ...theory,
      schemas: [
        { ...sampleSchema, ref: { ...sampleSchema.ref, digest: contentDigest("schema v2") } },
      ],
    }),
  ).not.toBe(digest);
  expect(pedagogicalTheoryDigest({ ...theory, parameters: { weight: 2 } })).not.toBe(digest);
  expect(pedagogicalTheoryDigest(theory, { weight: 2 })).toBe(
    pedagogicalTheoryDigest({ ...theory, parameters: { weight: 2 } }),
  );
  expect(pedagogicalTheoryDigest({ ...theory, basePrompt: "new", skills: { bundles: [] } })).toBe(
    digest,
  );
  expect(() => pedagogicalTheoryDigest({ ...theory, parameters: { unknown: 2 } })).toThrow(
    "Invalid theory parameters",
  );
  expect(() =>
    pedagogicalTheoryDigest({ ...theory, schemas: [sampleSchema, sampleSchema] }),
  ).toThrow("Invalid theory schema");
});

test("exact release references preserve the containing theory origin and root-only Skill overlays", () => {
  const root = rootRelease();
  const replacement = { name: "sample", content: "Replacement sample Skill" };
  const addition = { name: "extra", content: "Extra Skill" };
  const contained: PedagogyRelease<Sample, SampleState, SampleToolContext> = {
    form: "overlay",
    ref: { identity: "pedagogy-contained", version: "1.0.0", digest: contentDigest("contained") },
    platformRoot: root.ref,
    theory: { kind: "contained", theory: sampleTheory() },
    skillOverlay: [{ kind: "add", bundle: addition }],
  };
  const overlay: PedagogyRelease<Sample, SampleState, SampleToolContext> = {
    form: "overlay",
    ref: { identity: "pedagogy-selected", version: "7.0.0", digest: contentDigest("selected") },
    platformRoot: root.ref,
    theory: { kind: "reference", release: contained.ref },
    basePrompt: "Complete new prompt",
    skillOverlay: [{ kind: "replace", target: "sample", bundle: replacement }],
  };
  const resolvedRoot = resolvePedagogy(source([root]), root.ref);
  const resolved = resolvePedagogy(source([root, contained, overlay]), overlay.ref);
  expect(resolved.theory.origin).toEqual(contained.ref);
  expect(resolved.theory.digest).toBe(resolvedRoot.theory.digest);
  expect(resolved.skillCatalog.bundles).toEqual([replacement]);
  expect(resolved.skillCatalogDigest).not.toBe(resolvedRoot.skillCatalogDigest);
  expect(resolved.basePromptDigest).toBe(contentDigest("Complete new prompt"));
  expect(resolved.skillCatalogDigest).toBe(contentDigest([replacement]));
  const inherited = resolvePedagogy(
    source([
      root,
      { ...overlay, theory: undefined, skillOverlay: undefined, basePrompt: undefined },
    ]),
    overlay.ref,
  );
  expect(inherited.theory.origin).toEqual(root.ref);
  expect(inherited.skillCatalog).toEqual(resolvedRoot.skillCatalog);
  const disabled = resolvePedagogy(
    source([
      root,
      {
        ...overlay,
        theory: undefined,
        skillOverlay: [
          { kind: "disable", target: "sample" },
          { kind: "add", bundle: addition },
        ],
      },
    ]),
    overlay.ref,
  );
  expect(disabled.skillCatalog.bundles).toEqual([addition]);
});

test("package resolution rejects missing exact releases, cycles and invalid Skill overlays", () => {
  const root = rootRelease();
  const overlay: PedagogyRelease<Sample, SampleState, SampleToolContext> = {
    form: "overlay",
    ref: { identity: "pedagogy-cycle", version: "1.0.0", digest: contentDigest("cycle") },
    platformRoot: root.ref,
  };
  const cycle = { ...overlay, theory: { kind: "reference" as const, release: overlay.ref } };
  expect(() => resolvePedagogy(source([root, cycle]), cycle.ref)).toThrow("cycle");
  expect(() =>
    resolvePedagogy(source([root]), { ...root.ref, digest: contentDigest("wrong exact release") }),
  ).toThrow("unavailable");
  expect(() =>
    resolvePedagogy(
      source([root, { ...overlay, skillOverlay: [{ kind: "disable", target: "missing" }] }]),
      overlay.ref,
    ),
  ).toThrow("missing root Skill");
  expect(() =>
    resolvePedagogy(
      source([
        root,
        {
          ...overlay,
          skillOverlay: [{ kind: "add", bundle: { name: "sample", content: "duplicate" } }],
        },
      ]),
      overlay.ref,
    ),
  ).toThrow("existing Skill");
  expect(() =>
    resolvePedagogy(
      source([
        root,
        {
          ...overlay,
          skillOverlay: [
            { kind: "disable", target: "sample" },
            { kind: "disable", target: "sample" },
          ],
        },
      ]),
      overlay.ref,
    ),
  ).toThrow("more than once");
});

test("theory-scoped accepted parameters persist independently of the log and change projection identity only", async () => {
  const root = rootRelease();
  const theory = resolvePedagogy(source([root]), root.ref).theory;
  const proposal = { weight: 2 };
  const override = parameterOverride(theory, {
    id: "parameter-override-weight",
    createdAt: "2026-09-07T13:00:00.000Z",
    parameters: proposal,
  });
  proposal.weight = 9;
  expect(override.parameters).toEqual({ weight: 2 });
  const parameters = resolveTheoryParameters(theory, override);
  expect(resolveTheoryParameters(theory)).toEqual({ weight: 1 });
  expect(pedagogicalTheoryDigest(theory.theory, parameters)).not.toBe(theory.digest);
  const projected = theory.theory.project([sampleRecord()], graph, {
    at: override.createdAt,
    parameters,
    theoryDigest: pedagogicalTheoryDigest(theory.theory, parameters),
  });
  expect(projected.nodes["node-sample"]?.total).toBe(14);
  const dataDir = tempDataDir();
  roots.push(dataDir.root);
  const store = new LocalDirectoryCoreStore(dataDir);
  const trail = await store.readTrail(scope);
  await store.saveParameterOverride(scope, override);
  await store.setCurrentParameterOverride(scope, override.id);
  expect(await store.currentParameterOverride(scope)).toEqual(override);
  expect(await store.readParameterOverride(scope, override.id)).toEqual(override);
  expect(
    await store.currentParameterOverride({ ...scope, profile: "profile-other" }),
  ).toBeUndefined();
  expect(await store.readTrail(scope)).toEqual(trail);
  expect(store.saveParameterOverride(scope, override)).rejects.toThrow();
  expect(store.setCurrentParameterOverride(scope, "parameter-override-missing")).rejects.toThrow(
    "unavailable",
  );
  expect(() =>
    resolveTheoryParameters(
      { ...theory, origin: { ...theory.origin, identity: "pedagogy-other" } },
      override,
    ),
  ).toThrow("different Pedagogical theory");
  expect(() =>
    resolveTheoryParameters({ ...theory, digest: contentDigest("changed theory") }, override),
  ).toThrow("different Pedagogical theory");
  expect(() => resolveTheoryParameters(theory, { ...override, parameters: { weight: 3 } })).toThrow(
    "Invalid parameter override digest",
  );
  expect(() =>
    parameterOverride(theory, { ...override, parameters: { implementationDigest: "no" } }),
  ).toThrow("Invalid theory parameters");
  expect(() => parameterOverride(theory, { ...override, createdAt: "bad" })).toThrow(
    "ISO timestamp",
  );
});
