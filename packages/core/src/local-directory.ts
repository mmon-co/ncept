import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AssociationCommit, AssociationCommitId, ParameterOverride } from "./association";
import { ensureDataDir, type DataDir } from "./datadir";
import type { TrailSnapshot } from "./fold";
import type { Observation } from "./observation";
import { contentDigest, type ExactPedagogyRelease } from "./pedagogy";
import { parseGraphQuery } from "./patch";
import {
  parseSpacedReviewCard,
  parseSpacedReviewGrade,
  type SpacedReviewCard,
  type SpacedReviewCardId,
  type SpacedReviewGrade,
} from "./playground";
import type { ProfileScope } from "./scope";
import type { CoreStores } from "./storage";
import type { View, ViewId } from "./view";

function component(value: string, label: string): string {
  if (value.length === 0 || value === "." || value === "..") throw new Error(`${label} is invalid`);
  return encodeURIComponent(value);
}

function profileRoot(dd: DataDir, scope: ProfileScope): string {
  return join(
    dd.profilesDir,
    component(scope.principal, "principal"),
    component(scope.profile, "Profile"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObservation(value: unknown): value is Observation {
  return (
    isRecord(value) &&
    isRecord(value.envelope) &&
    typeof value.envelope.id === "string" &&
    value.envelope.id.startsWith("observation-") &&
    isRecord(value.payload) &&
    (value.interpretation === undefined || isRecord(value.interpretation))
  );
}

function isParameterOverride(value: unknown): value is ParameterOverride {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.startsWith("parameter-override-") &&
    typeof value.createdAt === "string" &&
    typeof value.digest === "string" &&
    value.digest.startsWith("sha256:") &&
    isRecord(value.parameters)
  );
}

function isAssociationCommit(value: unknown): value is AssociationCommit {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.startsWith("association-") &&
    (value.parent === undefined ||
      (typeof value.parent === "string" && value.parent.startsWith("association-"))) &&
    typeof value.createdAt === "string" &&
    isRecord(value.patchRevision) &&
    isRecord(value.theory) &&
    (value.parameterOverride === undefined || isParameterOverride(value.parameterOverride)) &&
    Array.isArray(value.associations) &&
    Array.isArray(value.interpretations)
  );
}

function isView(value: unknown): value is View {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id.startsWith("view-") ||
    typeof value.name !== "string" ||
    typeof value.createdAt !== "string" ||
    !isRecord(value.metadata)
  )
    return false;
  try {
    parseGraphQuery(value.query);
    return true;
  } catch {
    return false;
  }
}

function isExactPedagogyRelease(value: unknown): value is ExactPedagogyRelease {
  return (
    isRecord(value) &&
    typeof value.identity === "string" &&
    value.identity.startsWith("pedagogy-") &&
    typeof value.version === "string" &&
    typeof value.digest === "string" &&
    value.digest.startsWith("sha256:")
  );
}

function readJson<Value>(
  path: string,
  accepts: (value: unknown) => value is Value,
  label: string,
): Value {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!accepts(value)) throw new Error(`${path}: invalid ${label}`);
  return value;
}

function isAssociationId(value: string): value is AssociationCommitId {
  return value.startsWith("association-");
}

function associationId(value: string): AssociationCommitId {
  if (!isAssociationId(value)) throw new Error("invalid Association pointer");
  return value;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
}

function immutableJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function associationPath(dd: DataDir, scope: ProfileScope, id: AssociationCommitId): string {
  return join(profileRoot(dd, scope), "associations", `${component(id, "Association id")}.json`);
}

function viewPath(dd: DataDir, scope: ProfileScope, id: ViewId): string {
  return join(profileRoot(dd, scope), "views", `${component(id, "View id")}.json`);
}

function spacedReviewRoot(dd: DataDir, scope: ProfileScope): string {
  return join(profileRoot(dd, scope), "playgrounds", "spaced-review");
}

function spacedReviewCardPath(dd: DataDir, scope: ProfileScope, id: SpacedReviewCardId): string {
  return join(spacedReviewRoot(dd, scope), "cards", `${component(id, "card id")}.json`);
}

function spacedReviewGradeLog(dd: DataDir, scope: ProfileScope): string {
  return join(spacedReviewRoot(dd, scope), "grades.jsonl");
}

/** Filesystem implementation of the asynchronous ports for local harnesses and development. */
export class LocalDirectoryCoreStore implements CoreStores {
  constructor(readonly dataDir: DataDir) {
    ensureDataDir(dataDir);
  }

  async appendObservation(scope: ProfileScope, observation: Observation): Promise<void> {
    const trail = await this.readTrail(scope);
    if (trail.observations.some(({ envelope }) => envelope.id === observation.envelope.id))
      throw new Error(`Observation ${observation.envelope.id} already exists`);
    const path = join(profileRoot(this.dataDir, scope), "trail.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(observation)}\n`);
  }

  async readTrail(scope: ProfileScope): Promise<TrailSnapshot> {
    const path = join(profileRoot(this.dataDir, scope), "trail.jsonl");
    const observations = !existsSync(path)
      ? []
      : readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line, index) => {
            const value: unknown = JSON.parse(line);
            if (!isObservation(value)) throw new Error(`${path}:${index + 1}: invalid Observation`);
            return value;
          });
    return { observations, revision: contentDigest(observations) };
  }

  async commitAssociation(scope: ProfileScope, commit: AssociationCommit): Promise<void> {
    if (Number.isNaN(Date.parse(commit.createdAt)))
      throw new Error("Association commit createdAt must be an ISO timestamp");
    if (
      commit.parent !== undefined &&
      (await this.readAssociation(scope, commit.parent)) === undefined
    )
      throw new Error(`Association parent ${commit.parent} is unavailable`);
    immutableJson(associationPath(this.dataDir, scope, commit.id), commit);
  }

  async readAssociation(
    scope: ProfileScope,
    id: AssociationCommitId,
  ): Promise<AssociationCommit | undefined> {
    const path = associationPath(this.dataDir, scope, id);
    return existsSync(path) ? readJson(path, isAssociationCommit, "Association commit") : undefined;
  }

  async currentAssociation(scope: ProfileScope): Promise<AssociationCommit | undefined> {
    const pointer = join(profileRoot(this.dataDir, scope), "associations", "current");
    if (!existsSync(pointer)) return undefined;
    const id = associationId(readFileSync(pointer, "utf8").trim());
    const commit = await this.readAssociation(scope, id);
    if (commit === undefined) throw new Error(`Current Association ${id} is unavailable`);
    return commit;
  }

  async setCurrentAssociation(scope: ProfileScope, id: AssociationCommitId): Promise<void> {
    if ((await this.readAssociation(scope, id)) === undefined)
      throw new Error(`Association ${id} is unavailable`);
    const pointer = join(profileRoot(this.dataDir, scope), "associations", "current");
    mkdirSync(dirname(pointer), { recursive: true });
    const temporary = `${pointer}.tmp-${process.pid}`;
    writeFileSync(temporary, `${id}\n`, { flag: "wx" });
    renameSync(temporary, pointer);
  }

  async saveView(scope: ProfileScope, view: View): Promise<void> {
    if (view.name.trim() === "" || Number.isNaN(Date.parse(view.createdAt)))
      throw new Error("View requires a name and ISO creation timestamp");
    parseGraphQuery(view.query);
    immutableJson(viewPath(this.dataDir, scope, view.id), view);
  }

  async readView(scope: ProfileScope, id: ViewId): Promise<View | undefined> {
    const path = viewPath(this.dataDir, scope, id);
    return existsSync(path) ? readJson(path, isView, "View") : undefined;
  }

  async listViews(scope: ProfileScope): Promise<readonly View[]> {
    const root = join(profileRoot(this.dataDir, scope), "views");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson(join(root, name), isView, "View"))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async selectPedagogy(scope: ProfileScope, release: ExactPedagogyRelease): Promise<void> {
    atomicJson(join(profileRoot(this.dataDir, scope), "pedagogy.json"), release);
  }

  async selectedPedagogy(scope: ProfileScope): Promise<ExactPedagogyRelease | undefined> {
    const path = join(profileRoot(this.dataDir, scope), "pedagogy.json");
    return existsSync(path)
      ? readJson(path, isExactPedagogyRelease, "Pedagogy selection")
      : undefined;
  }

  async saveSpacedReviewCard(scope: ProfileScope, card: SpacedReviewCard): Promise<void> {
    const parsed = parseSpacedReviewCard(card);
    atomicJson(spacedReviewCardPath(this.dataDir, scope, parsed.id), parsed);
  }

  async readSpacedReviewCard(
    scope: ProfileScope,
    id: SpacedReviewCardId,
  ): Promise<SpacedReviewCard | undefined> {
    const path = spacedReviewCardPath(this.dataDir, scope, id);
    if (!existsSync(path)) return undefined;
    return parseSpacedReviewCard(JSON.parse(readFileSync(path, "utf8")));
  }

  async listSpacedReviewCards(scope: ProfileScope): Promise<readonly SpacedReviewCard[]> {
    const root = join(spacedReviewRoot(this.dataDir, scope), "cards");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => name.endsWith(".json"))
      .map((name) => parseSpacedReviewCard(JSON.parse(readFileSync(join(root, name), "utf8"))))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
  }

  async appendSpacedReviewGrade(scope: ProfileScope, grade: SpacedReviewGrade): Promise<void> {
    const parsed = parseSpacedReviewGrade(grade);
    if ((await this.readSpacedReviewGrades(scope)).some(({ id }) => id === parsed.id))
      throw new Error(`spaced-review grade ${parsed.id} already exists`);
    const path = spacedReviewGradeLog(this.dataDir, scope);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(parsed)}\n`);
  }

  async readSpacedReviewGrades(scope: ProfileScope): Promise<readonly SpacedReviewGrade[]> {
    const path = spacedReviewGradeLog(this.dataDir, scope);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => parseSpacedReviewGrade(JSON.parse(line)));
  }
}
