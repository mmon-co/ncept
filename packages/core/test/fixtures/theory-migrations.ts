import { bundleForRevision, candidateRevision, emptyPatch, sameExactPatchRef, type Profile } from "../../src/index.js";
import { type Theory, type TheoryMigration, type TheoryRequirement } from "../../src/theory/index.js";

const id = "synthetic-migration-theory";

function advance(from: number, to: number): TheoryMigration {
  return {
    from: `1.${from}`,
    to: `1.${to}`,
    migrate(profile) {
      const head = profile.patches.revisions.find((revision) =>
        sameExactPatchRef(revision.ref, profile.patches.terminal),
      );
      if (!head || head.metadata.properties["toy:generation"] !== from)
        throw new Error(`Expected synthetic generation ${from}`);
      const next = candidateRevision(head.ref.identity, {
        ...head,
        metadata: { ...head.metadata, properties: { ...head.metadata.properties, "toy:generation": to } },
      });
      const contents = new Map(profile.patches.revisions.map((revision) => [revision.ref.digest, revision]));
      contents.set(next.ref.digest, next);
      return {
        patches: bundleForRevision(next.ref, contents),
        log: profile.log.map((entry) => {
          if ("by" in entry && entry.by !== "platform" && entry.by.theory === id)
            return { ...entry, payload: { kind: "progress", generation: to } };
          if ("kind" in entry && entry.kind === "mission.revised")
            return {
              ...entry,
              mission: {
                ...entry.mission,
                targets: entry.mission.targets.map((target) => ({
                  ...target,
                  provenance: sameExactPatchRef(target.provenance, head.ref) ? next.ref : target.provenance,
                })),
              },
            };
          return entry;
        }),
      };
    },
  };
}

/** A host-independent executable with two real data rewrites, not a default Theory release. */
export const syntheticMigrationTheory: Theory<void> = {
  id,
  version: "1.2.3+fixture",
  migrations: [advance(0, 1), advance(1, 2)],
  initState: () => ({ step() {}, read() {} }),
  project: () => ({ nodes: {}, edges: {}, learner: [] }),
  progress: (_graph, _projection, nodes) => Object.fromEntries(nodes.map((node) => [node, { status: "open" }])),
  estimate: () => ({ minutes: 0, rough: false }),
  tags: [],
  outcomes: {},
  *event() {},
};

/** Fresh 1.0 values for a disk-open, exchange-import or deployment-migration encounter. */
export function syntheticOldProfile(): { requirement: TheoryRequirement; profile: Profile } {
  const base = candidateRevision("patch-synthetic-base", {
    ...emptyPatch(),
    delta: {
      operations: [
        { kind: "add-node", node: { id: "node-base" } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-base",
            subjects: [{ kind: "node", id: "node-base" }],
            properties: { "display:label": "Shared base" },
          },
        },
      ],
    },
  });
  const head = candidateRevision("patch-personal", {
    bases: [base.ref],
    delta: {
      operations: [
        { kind: "add-node", node: { id: "node-learning" } },
        {
          kind: "add-metadata-set",
          metadataSet: {
            id: "metadata-learning",
            subjects: [{ kind: "node", id: "node-learning" }],
            properties: { "display:label": "Learning" },
          },
        },
      ],
    },
    metadata: { properties: { "toy:generation": 0 }, citations: [] },
  });
  return {
    requirement: { theory: id, range: "~1.0" },
    profile: {
      patches: { terminal: head.ref, revisions: [base, head] },
      log: [
        {
          id: "obs-synthetic-progress",
          at: "2026-11-07T00:00:00.000Z",
          by: { theory: id, version: "1.0.0" },
          nodes: ["node-learning"],
          payload: { kind: "progress", generation: 0 },
        },
        {
          kind: "mission.revised",
          id: "synthetic-mission-revision",
          at: "2026-11-07T00:00:00.000Z",
          mission: {
            id: "synthetic-mission",
            statement: "Continue learning after a Theory release",
            targets: [{ node: "node-learning", provenance: head.ref }],
            priority: 1,
          },
        },
      ],
    },
  };
}
