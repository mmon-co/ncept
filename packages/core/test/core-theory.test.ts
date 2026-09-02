import { expect, test } from "bun:test";
import {
  PLATFORM_PEDAGOGY_RELEASE,
  V1_PEDAGOGICAL_THEORY,
  acceptParameterOverride,
  assessLearnerStateStaleness,
  contentDigest,
  currentExperiences,
  evaluateView,
  foldLearnerState,
  interpretObservation,
  pedagogicalTheoryDigest,
  resolvePedagogy,
  spacedReviewPlayground,
  sessionPedagogyMetadata,
  type AssociationCommit,
  type ExactPedagogyRelease,
  type Observation,
  type LearnerState,
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
  let liveState: LearnerState | undefined;
  const playground = spacedReviewPlayground({
    scope,
    trail: store,
    store,
    instruments: {
      competency: () => required(liveState, "live competency"),
      trail: (node) => ({ kind: "missing-node", node }),
      content: (node) => ({
        node,
        label: "Target",
        content: "Differentiate a polynomial",
        contentSource: patchRef,
        inspectorRef: "core-story",
      }),
    },
    injectContext: ({ content }) => injected.push(content),
  });
  for (const card of [
    {
      id: "srs-card-derivative" as const,
      category: "calculus",
      front: "d/dx x³",
      back: "3x²",
    },
    {
      id: "srs-card-integral" as const,
      category: "calculus",
      front: "integral of 3x²",
      back: "x³ + C",
    },
    {
      id: "srs-card-linearity" as const,
      category: "algebra",
      front: "expand 3(x + 1)",
      back: "3x + 3",
    },
  ]) {
    playground.proposeCard({
      ...card,
      createdAt: "2026-09-01T12:00:00.000Z",
      status: "pending",
      format: "recall",
      associations: [{ patch: patchRef, node: "node-target" }],
    });
    playground.approveCard(card.id);
  }
  playground.proposeCard({
    id: "srs-card-pending",
    createdAt: "2026-09-01T12:00:00.000Z",
    status: "pending",
    format: "application",
    category: "calculus",
    front: "Apply the power rule",
    back: "A worked transfer",
    associations: [{ patch: patchRef, node: "node-target" }],
  });
  expect(playground.dueQueue("2026-09-01T12:30:00.000Z", 3).map(({ card }) => card.id)).toEqual([
    "srs-card-linearity",
    "srs-card-derivative",
    "srs-card-integral",
  ]);

  const review = observation(
    "observation-review",
    "2026-09-01T12:30:00.000Z",
    {
      kind: "srs",
      vocabularyVersion: 1,
      cardId: "srs-card-derivative",
      answer: "3x²",
      latencyMs: 1200,
      grade: "good",
    },
    resolved.theory,
  );
  const grade = {
    id: "srs-grade-derivative-one" as const,
    cardId: "srs-card-derivative" as const,
    gradedAt: review.envelope.observedAt,
    answer: "3x²",
    latencyMs: 1200,
    grade: "good" as const,
  };
  playground.appendGrade(grade);
  playground.appendObservation(review);
  expect(() => playground.appendGrade(grade)).toThrow("already exists");
  playground.injectContext({ mode: "append", content: "review complete" });
  expect(playground.grades()).toEqual([grade]);
  expect(store.listSpacedReviewCards({ ...scope, profile: "profile-scratch" })).toEqual([]);
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
  liveState = firstState;
  expect(playground.instruments.competency()).toBe(firstState);
  expect(playground.instruments.content("node-target").contentSource).toEqual(patchRef);

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

test("an accepted Profile parameter override creates a distinguishable refold without rewriting history", () => {
  const store = new LocalDirectoryCoreStore(tempDataDir());
  const resolved = resolvePedagogy(
    pedagogySource([PLATFORM_PEDAGOGY_RELEASE]),
    PLATFORM_PEDAGOGY_RELEASE.ref,
  );
  const lesson = observation(
    "observation-override-lesson",
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
  store.appendObservation(scope, lesson);
  const original = association("association-before-override", resolved.theory, [lesson]);
  store.commitAssociation(scope, original);
  store.setCurrentAssociation(scope, original.id);
  const trailBefore = store.readTrail(scope);
  const before = foldLearnerState({
    graph,
    trail: trailBefore,
    association: original,
    theory: resolved.theory,
    evaluatedAt: "2026-09-02T12:00:00.000Z",
  });

  const accepted = acceptParameterOverride(store, scope, {
    associationId: "association-after-override",
    overrideId: "parameter-override-slower-evidence",
    createdAt: "2026-09-02T13:00:00.000Z",
    parameters: { evidence: { used: { delta: 0.05 } } },
  });
  const after = foldLearnerState({
    graph,
    trail: store.readTrail(scope),
    association: accepted,
    theory: resolved.theory,
    evaluatedAt: "2026-09-02T12:00:00.000Z",
  });

  expect(accepted).toMatchObject({
    parent: original.id,
    theory: original.theory,
    associations: original.associations,
    parameterOverride: {
      id: "parameter-override-slower-evidence",
      parameters: { evidence: { used: { delta: 0.05 } } },
      digest: contentDigest({ evidence: { used: { delta: 0.05 } } }),
    },
  });
  expect(store.currentAssociation(scope)?.id).toBe(accepted.id);
  expect(
    store.currentAssociation({ principal: scope.principal, profile: "profile-other" }),
  ).toBeUndefined();
  expect(store.readAssociation(scope, original.id)).toEqual(original);
  expect(store.readTrail(scope)).toEqual(trailBefore);
  expect(after.inputs.theoryDigest).toBe(before.inputs.theoryDigest);
  expect(after.inputs.associationCommit).not.toBe(before.inputs.associationCommit);
  expect(after.nodes["node-target"]?.estimate).not.toBe(before.nodes["node-target"]?.estimate);
  expect(after.nodes["node-target"]?.uncertainty).toBe(before.nodes["node-target"]?.uncertainty);
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
