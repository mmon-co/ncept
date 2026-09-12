import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensureDataDir, type DataDir } from "./datadir";
import {
  assertPlatformRetraction,
  parseRecord,
  serializeRecord,
  validateRecordJson,
  isRecordTimestamp,
  type Record as LogRecord,
  type RecordId,
  type RecordValidationContext,
  type TrailSnapshot,
} from "./observations";
import { contentDigest, isContentDigest } from "../digest";
import type { ExactPedagogyRelease } from "../pedagogy/release";
import type { ParameterOverride, ParameterOverrideId } from "../pedagogy/theory";
import { parseGraphQuery } from "../patch";
import {
  parseSpacedReviewCard,
  parseSpacedReviewGrade,
  type SpacedReviewCard,
  type SpacedReviewCardId,
  type SpacedReviewGrade,
} from "./spaced-review/playground";
import type { ProfileScope } from "./scope";
import type { CoreStores } from "./storage";
import type { View, ViewId } from "../patch/view";

function component(value: string, label: string): string {
  if (value.length === 0 || value === "." || value === "..") throw new Error(`${label} is invalid`);
  return encodeURIComponent(value);
}

function profileRoot(dd: DataDir, scope: ProfileScope): string {
  return join(dd.profilesDir, component(scope.principal, "principal"), component(scope.profile, "Profile"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isParameterOverride(value: unknown): value is ParameterOverride {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.startsWith("parameter-override-") &&
    isRecordTimestamp(value.createdAt) &&
    isContentDigest(value.digest) &&
    isRecord(value.theory) &&
    isExactPedagogyRelease(value.theory.origin) &&
    isContentDigest(value.theory.digest) &&
    isRecord(value.parameters) &&
    value.digest === contentDigest({ theory: value.theory, parameters: value.parameters })
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

function readJson<Value>(path: string, accepts: (value: unknown) => value is Value, label: string): Value {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!accepts(value)) throw new Error(`${path}: invalid ${label}`);
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

  private recordJson(scope: ProfileScope): string[] {
    const path = join(profileRoot(this.dataDir, scope), "records.jsonl");
    if (!existsSync(path)) return [];
    // Each physical line wraps the original JSON string, so even multiline payloads stay verbatim.
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line, index) => {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "string") throw new Error(`${path}:${index + 1}: invalid Record JSON`);
        parseRecord(value);
        return value;
      });
  }

  async appendRecord(scope: ProfileScope, record: LogRecord, context: RecordValidationContext): Promise<void> {
    await this.appendRecordJson(scope, serializeRecord(record), context);
  }

  async appendRecordJson(scope: ProfileScope, serialized: string, context: RecordValidationContext): Promise<void> {
    const record = validateRecordJson(serialized, context);
    const prior = this.recordJson(scope).map(parseRecord);
    if (prior.some(({ envelope }) => envelope.id === record.envelope.id))
      throw new Error(`Record ${record.envelope.id} already exists`);
    assertPlatformRetraction(record, prior);
    const path = join(profileRoot(this.dataDir, scope), "records.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(serialized)}\n`);
  }

  async readRecordJson(scope: ProfileScope, id: RecordId): Promise<string | undefined> {
    return this.recordJson(scope).find((serialized) => parseRecord(serialized).envelope.id === id);
  }

  async readTrail(scope: ProfileScope): Promise<TrailSnapshot> {
    const serialized = this.recordJson(scope);
    return { records: serialized.map(parseRecord), revision: contentDigest(serialized) };
  }

  async saveParameterOverride(scope: ProfileScope, override: ParameterOverride): Promise<void> {
    if (!isParameterOverride(override)) throw new Error("Invalid parameter override");
    immutableJson(this.parameterOverridePath(scope, override.id), override);
  }

  private parameterOverridePath(scope: ProfileScope, id: ParameterOverrideId): string {
    return join(
      profileRoot(this.dataDir, scope),
      "parameter-overrides",
      `${component(id, "Parameter override id")}.json`,
    );
  }

  async readParameterOverride(scope: ProfileScope, id: ParameterOverrideId): Promise<ParameterOverride | undefined> {
    const path = this.parameterOverridePath(scope, id);
    return existsSync(path) ? readJson(path, isParameterOverride, "parameter override") : undefined;
  }

  async currentParameterOverride(scope: ProfileScope): Promise<ParameterOverride | undefined> {
    const path = join(profileRoot(this.dataDir, scope), "parameter-overrides", "current.json");
    if (!existsSync(path)) return undefined;
    const id = readJson(
      path,
      (value): value is ParameterOverrideId => typeof value === "string" && /^parameter-override-.+/.test(value),
      "parameter override pointer",
    );
    const override = await this.readParameterOverride(scope, id);
    if (override === undefined) throw new Error(`Current parameter override ${id} is unavailable`);
    return override;
  }

  async setCurrentParameterOverride(scope: ProfileScope, id: ParameterOverrideId): Promise<void> {
    if ((await this.readParameterOverride(scope, id)) === undefined)
      throw new Error(`Parameter override ${id} is unavailable`);
    atomicJson(join(profileRoot(this.dataDir, scope), "parameter-overrides", "current.json"), id);
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
    return existsSync(path) ? readJson(path, isExactPedagogyRelease, "Pedagogy selection") : undefined;
  }

  async saveSpacedReviewCard(scope: ProfileScope, card: SpacedReviewCard): Promise<void> {
    const parsed = parseSpacedReviewCard(card);
    atomicJson(spacedReviewCardPath(this.dataDir, scope, parsed.id), parsed);
  }

  async readSpacedReviewCard(scope: ProfileScope, id: SpacedReviewCardId): Promise<SpacedReviewCard | undefined> {
    const path = spacedReviewCardPath(this.dataDir, scope, id);
    if (!existsSync(path)) return undefined;
    return parseSpacedReviewCard(JSON.parse(readFileSync(path, "utf8")));
  }

  async deleteSpacedReviewCard(scope: ProfileScope, id: SpacedReviewCardId): Promise<void> {
    rmSync(spacedReviewCardPath(this.dataDir, scope, id), { force: true });
  }

  async listSpacedReviewCards(scope: ProfileScope): Promise<readonly SpacedReviewCard[]> {
    const root = join(spacedReviewRoot(this.dataDir, scope), "cards");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => name.endsWith(".json"))
      .map((name) => parseSpacedReviewCard(JSON.parse(readFileSync(join(root, name), "utf8"))))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
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
