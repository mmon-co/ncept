import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AssociationCommit, AssociationCommitId } from "./association";
import { ensureDataDir, type DataDir } from "./datadir";
import type { TrailSnapshot } from "./fold";
import type { Observation } from "./observation";
import { contentDigest, type ExactPedagogyRelease } from "./pedagogy";
import { parseGraphQuery } from "./patch";
import type { ProfileScope } from "./scope";
import type { CoreStores, JsonValue } from "./storage";
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
    isRecord(value.interpretation)
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
    Array.isArray(value.associations)
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

function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    (isRecord(value) && Object.values(value).every(isJsonValue))
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

function playgroundRoot(dd: DataDir, scope: ProfileScope, namespace: string): string {
  return join(profileRoot(dd, scope), "playgrounds", component(namespace, "Playground namespace"));
}

function playgroundPath(dd: DataDir, scope: ProfileScope, namespace: string, key: string): string {
  return join(playgroundRoot(dd, scope, namespace), `${component(key, "Playground key")}.json`);
}

/** Synchronous filesystem implementation for local harnesses and development. */
export class LocalDirectoryCoreStore implements CoreStores {
  constructor(readonly dataDir: DataDir) {
    ensureDataDir(dataDir);
  }

  appendObservation(scope: ProfileScope, observation: Observation): void {
    const trail = this.readTrail(scope);
    if (trail.observations.some(({ envelope }) => envelope.id === observation.envelope.id))
      throw new Error(`Observation ${observation.envelope.id} already exists`);
    const path = join(profileRoot(this.dataDir, scope), "trail.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(observation)}\n`);
  }

  readTrail(scope: ProfileScope): TrailSnapshot {
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

  commitAssociation(scope: ProfileScope, commit: AssociationCommit): void {
    if (Number.isNaN(Date.parse(commit.createdAt)))
      throw new Error("Association commit createdAt must be an ISO timestamp");
    if (commit.parent !== undefined && this.readAssociation(scope, commit.parent) === undefined)
      throw new Error(`Association parent ${commit.parent} is unavailable`);
    immutableJson(associationPath(this.dataDir, scope, commit.id), commit);
  }

  readAssociation(scope: ProfileScope, id: AssociationCommitId): AssociationCommit | undefined {
    const path = associationPath(this.dataDir, scope, id);
    return existsSync(path) ? readJson(path, isAssociationCommit, "Association commit") : undefined;
  }

  currentAssociation(scope: ProfileScope): AssociationCommit | undefined {
    const pointer = join(profileRoot(this.dataDir, scope), "associations", "current");
    if (!existsSync(pointer)) return undefined;
    const id = associationId(readFileSync(pointer, "utf8").trim());
    const commit = this.readAssociation(scope, id);
    if (commit === undefined) throw new Error(`Current Association ${id} is unavailable`);
    return commit;
  }

  setCurrentAssociation(scope: ProfileScope, id: AssociationCommitId): void {
    if (this.readAssociation(scope, id) === undefined)
      throw new Error(`Association ${id} is unavailable`);
    const pointer = join(profileRoot(this.dataDir, scope), "associations", "current");
    mkdirSync(dirname(pointer), { recursive: true });
    const temporary = `${pointer}.tmp-${process.pid}`;
    writeFileSync(temporary, `${id}\n`, { flag: "wx" });
    renameSync(temporary, pointer);
  }

  saveView(scope: ProfileScope, view: View): void {
    if (view.name.trim() === "" || Number.isNaN(Date.parse(view.createdAt)))
      throw new Error("View requires a name and ISO creation timestamp");
    parseGraphQuery(view.query);
    immutableJson(viewPath(this.dataDir, scope, view.id), view);
  }

  readView(scope: ProfileScope, id: ViewId): View | undefined {
    const path = viewPath(this.dataDir, scope, id);
    return existsSync(path) ? readJson(path, isView, "View") : undefined;
  }

  listViews(scope: ProfileScope): readonly View[] {
    const root = join(profileRoot(this.dataDir, scope), "views");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson(join(root, name), isView, "View"))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  selectPedagogy(scope: ProfileScope, release: ExactPedagogyRelease): void {
    atomicJson(join(profileRoot(this.dataDir, scope), "pedagogy.json"), release);
  }

  selectedPedagogy(scope: ProfileScope): ExactPedagogyRelease | undefined {
    const path = join(profileRoot(this.dataDir, scope), "pedagogy.json");
    return existsSync(path)
      ? readJson(path, isExactPedagogyRelease, "Pedagogy selection")
      : undefined;
  }

  putPlaygroundRecord(scope: ProfileScope, namespace: string, key: string, value: JsonValue): void {
    atomicJson(playgroundPath(this.dataDir, scope, namespace, key), value);
  }

  getPlaygroundRecord(scope: ProfileScope, namespace: string, key: string): JsonValue | undefined {
    const path = playgroundPath(this.dataDir, scope, namespace, key);
    return existsSync(path) ? readJson(path, isJsonValue, "Playground record") : undefined;
  }

  listPlaygroundRecords(
    scope: ProfileScope,
    namespace: string,
  ): Readonly<Record<string, JsonValue>> {
    const root = playgroundRoot(this.dataDir, scope, namespace);
    if (!existsSync(root)) return {};
    return Object.fromEntries(
      readdirSync(root)
        .filter((name) => name.endsWith(".json"))
        .map((name) => [
          decodeURIComponent(name.slice(0, -".json".length)),
          readJson(join(root, name), isJsonValue, "Playground record"),
        ]),
    );
  }

  deletePlaygroundRecord(scope: ProfileScope, namespace: string, key: string): void {
    const path = playgroundPath(this.dataDir, scope, namespace, key);
    if (existsSync(path)) unlinkSync(path);
  }
}
