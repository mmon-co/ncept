import { tryParse } from "std-semver";
import {
  candidateRevision,
  resolveNotebookRevision,
  type ResolvedGraph,
  exactPatchRefKey,
  notebookSelection,
  resolvePatchBundle,
  revisionContent,
  revisionDigest,
  type ClosedPatchBundle,
  type ExactPatchRef,
  type PatchContent,
  type PatchRevision,
} from "../patch/index.js";
import type { Profile } from "../profile.js";
import type { Theory, TheoryRequirement } from "./theory.js";

/** A stored-data generation; patch releases and build metadata do not change it. */
export type TheoryDataVersion = `${number}.${number}`;

/** A content rewrite may depend on effective metadata inherited from bases. Resolve lazily:
 * without a candidate this reads the authored closure; with one it reads the migrated bases. */
type MigrationGraphs = { basesChanged: boolean; resolve: (candidate?: PatchContent) => ResolvedGraph };

/**
 * Pure forward rewrite from one minor to the next within the same major. A step with no
 * rewrite keeps every stored shape and changes only what the Theory derives from it, such as
 * tag membership: hosts move the pin and discard derived state without reading the Profile.
 */
export type TheoryMigration = Readonly<{
  from: TheoryDataVersion;
  to: TheoryDataVersion;
  /** Rewrite one Patch's content without mutating it; identity and revision minting belong to the caller. */
  migratePatch?(content: PatchContent, graphs?: MigrationGraphs): PatchContent;
  /**
   * Apply migratePatch to live heads and rewrite Profile.log without mutating the input.
   * Changed content gets new exact references; hosts retain old revisions as unread history.
   * Observations are in Profile.log, not a separate host-specific collection.
   */
  migrate?(profile: Profile): Profile;
  /** Hosts retaining source events rewrite their live payloads in the same transaction as the Profile. */
  migrateOutcome?(payload: unknown, profile: Profile): unknown;
}>;

/** The installed pin when no step from the stored pin rewrites stored data, else undefined. */
export function theoryPinMigration(
  theory: MigrationTheory,
  requirement: TheoryRequirement,
): TheoryRequirement | undefined {
  const plan = planTheoryMigration(theory, requirement);
  const rewrites = plan.steps.some((step) => step.migratePatch || step.migrate || step.migrateOutcome);
  return rewrites ? undefined : plan.requirement;
}

export type TheoryProfileMigrationResult = Readonly<{
  profile: Profile;
  requirement: TheoryRequirement;
}>;

type MigrationTheory = Pick<Theory<unknown>, "id" | "version" | "migrations">;

/**
 * Compose pure Patch rewrites from a release's Theory range to the installed Theory.
 * Refuse an invalid path before executing any step. The caller mints a new revision
 * when content changes and keeps the immutable release revision as history.
 * A same-minor range returns the input content unchanged.
 */
export function migrateTheoryPatchContent(
  theory: MigrationTheory,
  requirement: TheoryRequirement,
  content: PatchContent,
  graphs?: MigrationGraphs,
): PatchContent {
  const { steps } = planTheoryMigration(theory, requirement);
  let migrated = content;
  for (const step of steps) if (step.migratePatch) migrated = step.migratePatch(migrated, graphs);
  return migrated;
}

/**
 * Migrate every revision a closed bundle reaches, relinking bases to their migrated references.
 * A revision uses its own declaration from `declared`, else the one of the revision that
 * reached it; the terminal falls back to `root`. Returns every migrated revision (unchanged
 * content keeps its reference) and the migrated terminal.
 */
export function migrateTheoryPatchClosure(
  theory: MigrationTheory,
  bundle: ClosedPatchBundle,
  root: TheoryRequirement,
  declared: ReadonlyMap<string, TheoryRequirement> = new Map(),
): Readonly<{ terminal: PatchRevision; revisions: readonly PatchRevision[] }> {
  const revisions = new Map(bundle.revisions.map((revision) => [exactPatchRefKey(revision.ref), revision]));
  const migrated = new Map<string, PatchRevision>();
  const contents = new Map(bundle.revisions.map((revision) => [revision.ref.digest, revisionContent(revision)]));
  const visit = (ref: ExactPatchRef, inherited: TheoryRequirement): PatchRevision => {
    const key = exactPatchRefKey(ref);
    const held = migrated.get(key);
    if (held) return held;
    const revision = revisions.get(key);
    if (!revision) throw new Error("Incomplete Patch closure");
    const pin = declared.get(key) ?? inherited;
    const authoredBases = revision.bases;
    const bases = authoredBases.map((base) => visit(base, pin).ref);
    const basesChanged = bases.some((base, i) => base.digest !== revision.bases[i]?.digest);
    function relink(content: PatchContent): PatchContent {
      const pointers = content.bases === authoredBases ? bases : content.bases.map((base) => visit(base, pin).ref);
      if (pointers.every((base, i) => base.digest === content.bases[i]?.digest)) return content;
      return {
        ...content,
        bases: pointers,
        delta: {
          operations: content.delta.operations.map((op) => {
            if (op.kind !== "mask-contribution") return op;
            const source = migrated.get(exactPatchRefKey(op.mask.source))?.ref;
            return source ? { ...op, mask: { ...op.mask, source } } : op;
          }),
        },
      };
    }
    const content = migrateTheoryPatchContent(theory, pin, revisionContent(revision), {
      basesChanged,
      resolve(candidate) {
        const at = candidate ? candidateRevision(ref.identity, relink(candidate)) : revision;
        contents.set(at.ref.digest, revisionContent(at));
        return resolveNotebookRevision(at.ref, contents).graph;
      },
    });
    const next = candidateRevision(ref.identity, relink(content));
    contents.set(next.ref.digest, revisionContent(next));
    migrated.set(key, next);
    return next;
  };
  const terminal = visit(bundle.terminal, root);
  return { terminal, revisions: [...migrated.values()] };
}

/**
 * Compose the steps from a Profile's stored minor pin to the supplied Theory, refusing
 * missing steps, newer data and different majors. Hosts persist data and the returned
 * pin together before resolving the Theory for ordinary reads.
 */
export function migrateTheoryProfile(
  theory: MigrationTheory,
  requirement: TheoryRequirement,
  profile: Profile,
): TheoryProfileMigrationResult {
  const { steps, requirement: migratedRequirement } = planTheoryMigration(theory, requirement);
  validateLiveBundle(profile);
  let migrated = profile;
  for (const step of steps) {
    if (!step.migrate) continue;
    migrated = step.migrate(migrated);
    validateLiveBundle(migrated);
  }
  return { profile: migrated, requirement: migratedRequirement };
}

/** Source journals are host-owned; compose the same validated path used for portable Profile data. */
export function migrateTheoryOutcomes(
  theory: MigrationTheory,
  requirement: TheoryRequirement,
  payloads: readonly unknown[],
  profile: Profile,
): readonly unknown[] {
  const { steps } = planTheoryMigration(theory, requirement);
  let migrated = payloads;
  let current = profile;
  for (const step of steps) {
    migrated = migrated.map((payload) => (step.migrateOutcome ? step.migrateOutcome(payload, current) : payload));
    if (step.migrate) current = step.migrate(current);
  }
  return migrated;
}

function planTheoryMigration(theory: MigrationTheory, requirement: TheoryRequirement) {
  const installed = tryParse(theory.version);
  const pin = /^~(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(requirement.range);
  if (!theory.id.trim() || installed === undefined || pin === null)
    throw new Error("Theory migration needs a valid release and a ~major.minor stored pin");
  if (requirement.theory !== theory.id) throw new Error("Cannot migrate a different Theory");
  const major = Number(pin[1]);
  const minor = Number(pin[2]);
  if (major !== installed.major) throw new Error("Cannot migrate across Theory majors");
  if (minor > installed.minor) throw new Error("Stored Theory data is newer than the installed release");

  // Find the whole path before running a rewrite, so a gap never executes a partial migration.
  const steps: TheoryMigration[] = [];
  for (let current = minor; current < installed.minor; current++) {
    const from: TheoryDataVersion = `${major}.${current}`;
    const to: TheoryDataVersion = `${major}.${current + 1}`;
    const matches = (theory.migrations ?? []).filter((step) => step.from === from);
    const step = matches[0];
    if (matches.length > 1) throw new Error(`Ambiguous Theory migration from ${from} to ${to}`);
    if (step === undefined || step.to !== to) throw new Error(`Missing Theory migration from ${from} to ${to}`);
    steps.push(step);
  }

  return { steps, requirement: { theory: theory.id, range: `~${major}.${installed.minor}` } };
}

function validateLiveBundle(profile: Profile): void {
  for (const revision of profile.patches.revisions) {
    if (revisionDigest(revision) !== revision.ref.digest)
      throw new Error(`Theory migration Patch content does not match ${revision.ref.identity}@${revision.ref.digest}`);
  }
  // Resolution checks the exact closure, including duplicate/unused revisions and base conflicts.
  resolvePatchBundle(profile.patches, undefined, notebookSelection(profile.patches));
}
