import { expect, test } from "bun:test";
import {
  PLATFORM_PEDAGOGY_RELEASE,
  V1_PEDAGOGICAL_THEORY,
  assessLearnerStateStaleness,
  contentDigest,
  currentExperiences,
  evaluateView,
  foldLearnerState,
  interpretObservation,
  pedagogicalTheoryDigest,
  playgroundContract,
  resolvePedagogy,
  sessionPedagogyMetadata,
  type AssociationCommit,
  type ExactPedagogyRelease,
  type Observation,
  type PedagogicalTheory,
  type PedagogyRelease,
  type ProfileScope,
  type ResolvedTheory,
  type View,
} from "../src";
import { LocalDirectoryCoreStore } from "../src/local-directory";
import { resolvePatchBundle, type ExactPatchRef, type PatchRevision } from "../src/patch";
import { tempDataDir } from "./helpers";

const patchRef: ExactPatchRef = {
  identity: "patch-core-story",
  version: "1.0.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  digest: `sha256:${"a".repeat(64)}`,
};

const patch: PatchRevision = {
  ref: patchRef,
  bases: [],
  lock: { entries: [] },
  metadata: { properties: { "patch:title": "Core story" }, citations: [] },
  delta: {
    operations: [
      { kind: "add-node", node: { id: "node-prerequisite" } },
      { kind: "add-node", node: { id: "node-target" } },
      {
        kind: "add-edge",
        edge: { id: "edge-dependency", from: "node-prerequisite", to: "node-target" },
      },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-target",
          subjects: [{ kind: "node", id: "node-target" }],
          properties: { "display:label": "Target" },
        },
      },
      {
        kind: "add-metadata-set",
        metadataSet: {
          id: "metadata-edge",
          subjects: [{ kind: "edge", id: "edge-dependency" }],
          properties: { "graph:strength": 0.8 },
        },
      },
    ],
  },
};

const graph = resolvePatchBundle({ terminal: patchRef, revisions: [patch] });
const scope: ProfileScope = { principal: "principal-alice", profile: "profile-main" };

function required<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) throw new Error(`${label} is unavailable`);
  return value;
}

function pedagogySource(releases: readonly PedagogyRelease[]) {
  return {
    get(ref: ExactPedagogyRelease): PedagogyRelease | undefined {
      return releases.find(
        ({ ref: candidate }) =>
          candidate.identity === ref.identity &&
          candidate.version === ref.version &&
          candidate.digest === ref.digest,
      );
    },
  };
}

function observation(
  id: `observation-${string}`,
  observedAt: string,
  payload: Observation["payload"],
  theory: ResolvedTheory,
  supersedes?: Observation["supersedes"],
): Observation {
  return interpretObservation(
    {
      id,
      observedAt,
      source: { kind: "session", sessionId: "session-one" },
      subject:
        payload.kind === "mission" || payload.kind === "preferences"
          ? { kind: "experience", scope: "profile" }
          : {
              kind: "node",
              node: "node-target",
              effectiveProvenance: patchRef,
            },
    },
    payload,
    theory,
    supersedes,
  );
}

function association(
  id: `association-${string}`,
  theory: ResolvedTheory,
  observations: readonly Observation[],
  parent?: `association-${string}`,
): AssociationCommit {
  return {
    id,
    ...(parent === undefined ? {} : { parent }),
    createdAt: "2026-09-01T13:00:00.000Z",
    patchRevision: patchRef,
    theory: { origin: theory.origin, digest: theory.digest },
    associations: observations.map((record) => ({
      observation: record.envelope.id,
      targets: [{ patch: patchRef, node: "node-target" }],
    })),
  };
}

test("Core stories 1-5 compose through the local principal/Profile store", () => {
  const store = new LocalDirectoryCoreStore(tempDataDir());
  const resolved = resolvePedagogy(
    pedagogySource([PLATFORM_PEDAGOGY_RELEASE]),
    PLATFORM_PEDAGOGY_RELEASE.ref,
  );
  store.selectPedagogy(scope, resolved.release);
  expect(store.selectedPedagogy(scope)).toEqual(resolved.release);
  expect(sessionPedagogyMetadata(resolved)).toEqual({
    pedagogyRelease: resolved.release,
    theoryDigest: resolved.theory.digest,
    skillCatalogDigest: resolved.skillCatalogDigest,
  });

  const view: View = {
    id: "view-mission",
    name: "Mission dependency cone",
    createdAt: "2026-09-01T09:00:00.000Z",
    query: {
      intersection: [{ cone: { targets: ["node-target"] } }, { provenance: patchRef }],
    },
    metadata: {},
  };
  store.saveView(scope, view);
  expect(evaluateView(graph, required(store.readView(scope, view.id), "saved View"))).toMatchObject(
    {
      nodes: [{ id: "node-prerequisite" }, { id: "node-target" }],
      edges: [{ id: "edge-dependency" }],
    },
  );

  const firstMission = observation(
    "observation-mission-one",
    "2026-09-01T10:00:00.000Z",
    {
      kind: "mission",
      vocabularyVersion: 1,
      missionId: "calculus",
      statement: "Understand derivatives",
      viewId: view.id,
      targetNodes: ["node-target"],
      priority: 1,
    },
    resolved.theory,
  );
  const currentMission = observation(
    "observation-mission-two",
    "2026-09-01T11:00:00.000Z",
    {
      kind: "mission",
      vocabularyVersion: 1,
      missionId: "calculus",
      statement: "Apply derivatives",
      viewId: view.id,
      targetNodes: ["node-target"],
      priority: 2,
    },
    resolved.theory,
    firstMission.envelope.id,
  );
  const preferences = observation(
    "observation-preferences",
    "2026-09-01T11:30:00.000Z",
    { kind: "preferences", vocabularyVersion: 1, values: { pace: "deliberate" } },
    resolved.theory,
  );
  const lesson = observation(
    "observation-lesson",
    "2026-09-01T12:00:00.000Z",
    {
      kind: "lesson",
      vocabularyVersion: 1,
      criterion: "differentiate a polynomial",
      response: "3x²",
      result: "demonstrated",
      assistance: "none",
    },
    resolved.theory,
  );
  for (const record of [firstMission, currentMission, preferences, lesson])
    store.appendObservation(scope, record);

  const injected: string[] = [];
  const playground = playgroundContract({
    scope,
    namespace: "spaced-review",
    trail: store,
    playground: store,
    instruments: { competency: () => "live" },
    injectContext: ({ content }) => injected.push(content),
  });
  playground.store.put("card-one", { front: "d/dx x³", back: "3x²" });
  const review = observation(
    "observation-review",
    "2026-09-01T12:30:00.000Z",
    {
      kind: "srs",
      vocabularyVersion: 1,
      cardId: "card-one",
      answer: "3x²",
      latencyMs: 1200,
      grade: "good",
    },
    resolved.theory,
  );
  playground.appendObservation(review);
  playground.injectContext({ mode: "append", content: "review complete" });
  expect(playground.store.get("card-one")).toEqual({ front: "d/dx x³", back: "3x²" });
  expect(injected).toEqual(["review complete"]);

  expect(
    currentExperiences(store.readTrail(scope).observations).map(({ envelope }) => envelope.id),
  ).toEqual(["observation-mission-two", "observation-preferences"]);
  expect(
    store.readTrail({ principal: "principal-alice", profile: "profile-scratch" }).observations,
  ).toHaveLength(0);

  const firstAssociation = association("association-first", resolved.theory, [lesson, review]);
  store.commitAssociation(scope, firstAssociation);
  store.setCurrentAssociation(scope, firstAssociation.id);
  expect(() => store.commitAssociation(scope, firstAssociation)).toThrow();
  const firstState = foldLearnerState({
    graph,
    trail: store.readTrail(scope),
    association: required(store.currentAssociation(scope), "current Association"),
    theory: resolved.theory,
    evaluatedAt: "2026-09-02T12:30:00.000Z",
  });
  expect(firstState.nodes["node-target"]?.estimate).toBeGreaterThan(0.5);

  const changedTheory: PedagogicalTheory = {
    ...V1_PEDAGOGICAL_THEORY,
    parameters: {
      ...V1_PEDAGOGICAL_THEORY.parameters,
      evidence: {
        ...V1_PEDAGOGICAL_THEORY.parameters.evidence,
        used: { delta: 0.3, information: 2 },
      },
    },
  };
  const changedRelease: PedagogyRelease = {
    form: "root",
    ref: {
      identity: "pedagogy-changed",
      version: "1.0.0",
      digest: contentDigest("changed release"),
    },
    theory: { kind: "contained", theory: changedTheory },
    basePrompt: "changed",
    skillCatalog: { digest: resolved.skillCatalogDigest },
  };
  const changed = resolvePedagogy(pedagogySource([changedRelease]), changedRelease.ref);
  expect(changed.theory.digest).toBe(pedagogicalTheoryDigest(changedTheory));
  const refoldCommit = association(
    "association-refold",
    changed.theory,
    [lesson, review],
    firstAssociation.id,
  );
  store.commitAssociation(scope, refoldCommit);
  store.setCurrentAssociation(scope, refoldCommit.id);
  const refolded = foldLearnerState({
    graph,
    trail: store.readTrail(scope),
    association: refoldCommit,
    theory: changed.theory,
    evaluatedAt: "2026-09-02T12:30:00.000Z",
  });
  expect(refolded.nodes["node-target"]?.estimate).toBeGreaterThan(
    required(firstState.nodes["node-target"], "first target state").estimate,
  );
  expect(
    assessLearnerStateStaleness(firstState, {
      patchRevision: patchRef,
      associationCommit: refoldCommit.id,
      theoryDigest: changed.theory.digest,
      trailRevision: store.readTrail(scope).revision,
    }).staleness,
  ).toEqual({ stale: true, reasons: ["association", "theory"] });
});

test("the fold replays chronological evidence, propagates through dependencies, and ages uncertainty", () => {
  const theory: ResolvedTheory = {
    origin: PLATFORM_PEDAGOGY_RELEASE.ref,
    digest: pedagogicalTheoryDigest(V1_PEDAGOGICAL_THEORY),
    theory: V1_PEDAGOGICAL_THEORY,
  };
  const failed = observation(
    "observation-failed",
    "2026-08-01T10:00:00.000Z",
    {
      kind: "quiz",
      vocabularyVersion: 1,
      itemId: "item-one",
      response: "wrong",
      correct: false,
      assistance: "none",
      mistake: "bug",
    },
    theory,
  );
  const succeeded = observation(
    "observation-succeeded",
    "2026-08-02T10:00:00.000Z",
    {
      kind: "quiz",
      vocabularyVersion: 1,
      itemId: "item-two",
      response: "right",
      correct: true,
      assistance: "none",
    },
    theory,
  );
  const trail = {
    observations: [succeeded, failed],
    revision: contentDigest([succeeded, failed]),
  };
  const commit = association("association-order", theory, [succeeded, failed]);
  const fresh = foldLearnerState({
    graph,
    trail,
    association: commit,
    theory,
    evaluatedAt: "2026-08-02T10:00:00.000Z",
  });
  const aged = foldLearnerState({
    graph,
    trail,
    association: commit,
    theory,
    evaluatedAt: "2027-08-02T10:00:00.000Z",
  });
  expect(fresh.nodes["node-target"]?.evidence).toEqual([
    "observation-failed",
    "observation-succeeded",
  ]);
  expect(fresh.nodes["node-prerequisite"]?.estimate).not.toBe(0.5);
  expect(required(aged.nodes["node-target"], "aged target state").uncertainty).toBeGreaterThan(
    required(fresh.nodes["node-target"], "fresh target state").uncertainty,
  );
});
