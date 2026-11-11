import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyGraphDiff,
  attachmentDigest,
  compileGraphDiff,
  composePatch,
  isMaterialMeta,
  isMission,
  isNodeId,
  nodeCascadedProperty,
  parseGraphQuery,
  revisionContent,
  projectVisualGraph,
  sameExactPatchRef,
  selectGraph,
  tagIndex,
  type ExactPatchRef,
  type HostCapability,
  type JsonSchema,
  type Material,
  type NodeId,
  type PatchContent,
  type Skill,
} from "@mmon-co/ncept-core";
import type { HostTool, HostToolResult, ModeSwitch } from "./host.js";
import type { LearningHost } from "./learning.js";
import { localPayload, platform, sessionStates, transcript, type LocalSession } from "./runtime.js";
import { mechanics } from "./mechanics.js";
import { object } from "./sessions.js";
import { citations, exactRef, metadataProperties, modeEntry, operations, strings } from "./inputs.js";

function args(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error("Expected an object");
  return value;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected " + name);
  return value;
}
function nodes(value: unknown): readonly NodeId[] {
  if (!Array.isArray(value) || !value.every(isNodeId)) throw new Error("Expected Node identities");
  return value;
}
function safeName(value: unknown): string {
  const name = text(value, "filename");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error("Expected a plain filename or identity");
  return name;
}
const string = { type: "string" };
const nodeList = { type: "array", items: { type: "string", pattern: "^node-" } };
const graphProperties = {
  operations: {
    type: "array",
    description:
      'Core operations use kind, not op. Create a Node with {"kind":"add-node","node":{"id":"node-example"}}; its label and criterion are separate: {"kind":"add-metadata-set","metadataSet":{"id":"metadata-example","subjects":[{"kind":"node","id":"node-example"}],"properties":{"display:label":"Example","pedagogy:criterion":"Observable success","pedagogy:knowledge-type":"conceptual"}}}. A prerequisite edge is {"kind":"add-edge","edge":{"id":"edge-example","from":"node-prerequisite","to":"node-example"}}. Other kinds: define-tag {tag:{name,nodes,edges,metadataSets}}, add-material/edit-material {material:{playground,type,id,about,content:{kind:"blob",hash,mediaType},meta}}, remove-material {playground,id}, mask-contribution {mask:{source:{identity,digest},operationIndex,entity:{kind,id},property?}}. Prefer the material tool for local files. Metadata properties belong to metadata sets, never directly on Nodes.',
    items: { type: "object" },
  },
  targets: nodeList,
  citations: { type: "array", items: { type: "object" } },
  retractions: { type: "array", items: string },
};
function schema(properties: Record<string, unknown>, required: readonly string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
async function acceptContent<S>(
  host: LearningHost<S>,
  session: LocalSession,
  from: ExactPatchRef,
  content: PatchContent,
  about: readonly NodeId[] = session.about,
) {
  const view = await host.runtime.snapshot();
  if (!sameExactPatchRef(view.graph.terminal, from)) throw new Error("Personal Patch changed; read and propose again");
  const destination = await host.runtime.prospective(content);
  const to = destination.graph.terminal;
  const event = await host.runtime.prepare(
    destination.theory.event({ kind: "patch.changed", from, to }, destination),
    session,
    destination,
  );
  await host.runtime.profile.addRevision(from.identity, content);
  await host.runtime.profile.setPersonal(to);
  await host.runtime.profile.appendLog([
    ...event.entries,
    platform({ kind: "local.patch", from, to }, session.surface),
    platform(
      {
        kind: "local.session",
        session: { ...session, about: about.filter((id) => destination.graph.nodes.some((node) => node.id === id)) },
      },
      session.surface,
    ),
  ]);
  return to;
}
function graphDiff<S>(host: LearningHost<S>, input: Record<string, unknown>, session: LocalSession) {
  return host.runtime.snapshot().then(async (view) => {
    if (!Array.isArray(input.operations)) throw new Error("Expected graph operations");
    const compiled = compileGraphDiff(
      view.bundle,
      operations(input.operations),
      input.targets === undefined ? session.about : nodes(input.targets),
      citations(input.citations),
      input.retractions === undefined ? [] : strings(input.retractions),
    );
    return { view, compiled, content: applyGraphDiff(await host.runtime.content(), compiled) };
  });
}
function page(items: readonly unknown[], input: Record<string, unknown>) {
  const start = input.cursor === undefined ? 0 : Number(input.cursor);
  const limit = input.limit === undefined ? 20 : Number(input.limit);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid page cursor or limit (1–100)");
  const next = start + limit;
  return {
    page: items.slice(start, next),
    isDone: next >= items.length,
    continueCursor: next >= items.length ? null : String(next),
  };
}
export function hostTools<S>(
  host: LearningHost<S>,
  opened: LocalSession,
  capabilities: readonly HostCapability[],
  skills: readonly Skill[],
  metadataKeys: readonly string[],
): readonly HostTool[] {
  const tools: HostTool[] = [];
  function mount(
    name: string,
    description: string,
    definition: JsonSchema,
    run: (input: Record<string, unknown>, session: LocalSession) => Promise<HostToolResult>,
  ) {
    tools.push({
      name,
      description,
      schema: definition,
      run: (raw) =>
        host.serial(async () => {
          const session = await host.current(opened);
          if (session.closed || session.mode !== opened.mode)
            throw new Error("Tool belongs to an inactive Session mode");
          const result = await run(args(raw), session);
          if (!object(result.content) || result.content.status !== "refused") {
            const feature = await host.runtime.event(
              {
                kind: "feature.used",
                operation: name,
                at: new Date().toISOString(),
                about: session.about,
              },
              session,
            );
            await host.runtime.profile.appendLog(feature.entries);
          }
          return result;
        }),
    });
  }
  if (capabilities.includes("reads")) {
    mount(
      "query",
      "Find Profile nodes, Missions, Sessions, observations or Materials. Paginated lists use cursor and limit (1–100).",
      schema(
        {
          resource: { enum: ["profile", "session", "material"] },
          op: { enum: ["search", "list", "find"] },
          input: { type: "object", properties: { kind: string, query: string } },
          cursor: string,
          limit: { type: "integer" },
        },
        ["resource", "op"],
      ),
      async (raw) => {
        const view = await host.runtime.snapshot();
        const input = raw.input === undefined ? {} : args(raw.input);
        const resource = text(raw.resource, "resource");
        let items: readonly unknown[];
        if (resource === "session") items = sessionStates(view.profile);
        else if (resource === "material") items = view.graph.materials;
        else if (resource === "profile") {
          switch (input.kind ?? "node") {
            case "mission":
              items = await host.missionReadings();
              break;
            case "observation":
              items = view.observations;
              break;
            case "node":
              items = projectVisualGraph({
                graph: view.graph,
                annotations: {},
                tags: view.theory.project(view.graph, view.state),
              }).nodes;
              break;
            default:
              throw new Error("Profile kind accepts node, mission or observation");
          }
        } else throw new Error("Unsupported local resource");
        if (typeof input.query === "string") {
          const query = input.query.toLowerCase();
          items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(query));
        }
        return { content: page(items, raw) };
      },
    );
    mount(
      "read",
      "Read the current graph (including criteria and guidance), a Session transcript, a Patch revision, or a Material's saved bytes and working-copy path.",
      schema({ resource: { enum: ["graph", "session", "material", "patch"] }, input: { type: "object" } }),
      async (raw, session) => {
        const input = raw.input === undefined ? {} : args(raw.input);
        const view = await host.runtime.snapshot();
        switch (raw.resource ?? "graph") {
          case "graph": {
            const graph =
              input.query === undefined
                ? view.graph
                : selectGraph(
                    view.graph,
                    parseGraphQuery(input.query),
                    tagIndex(view.theory.project(view.graph, view.state)),
                  );
            const selected = input.nodes === undefined ? undefined : nodes(input.nodes);
            return {
              content: {
                ...graph,
                nodes: graph.nodes
                  .filter(({ id }) => !selected || selected.includes(id))
                  .map(({ id }) => ({
                    id,
                    label: nodeCascadedProperty(graph, id, "display:label"),
                    criterion: nodeCascadedProperty(graph, id, "pedagogy:criterion"),
                    guidance: nodeCascadedProperty(graph, id, "pedagogy:guidance"),
                    assessment: nodeCascadedProperty(graph, id, "pedagogy:assessment"),
                  })),
                projection: view.theory.project(graph, view.state),
              },
            };
          }
          case "patch": {
            const patch = input.ref === undefined ? view : await host.runtime.snapshot(exactRef(input.ref));
            return { content: patch.bundle };
          }
          case "session": {
            const id = input.id === undefined ? session.id : text(input.id, "Session id");
            const selected = sessionStates(view.profile).find((item) => item.id === id);
            if (!selected) throw new Error("Unknown Session");
            return { content: { session: selected, transcript: transcript(view.profile, selected.surface) } };
          }
          case "material": {
            const material = view.graph.materials.find(
              (item) =>
                item.id === input.id && (input.playground === undefined || item.playground === input.playground),
            );
            if (!material) throw new Error("Unknown Material");
            const bytes = view.profile.blobs.get(material.content.hash);
            if (!bytes) throw new Error("Missing Material bytes");
            const path = material.playground === "local" ? workingPath(host.runtime.profile.dir, material) : undefined;
            return {
              content: {
                material,
                ...(path ? { path } : {}),
                ...(material.content.mediaType.startsWith("text/") || material.content.mediaType === "application/json"
                  ? { text: new TextDecoder().decode(bytes) }
                  : { base64: Buffer.from(bytes).toString("base64") }),
                ...(path
                  ? { workingCopy: await readFile(path, "utf8").catch(() => null) }
                  : { runner: "unavailable on this host" }),
              },
            };
          }
          default:
            throw new Error("Unsupported local read resource");
        }
      },
    );
  }
  if (capabilities.includes("graph-draft")) {
    mount(
      "edit_graph_draft",
      "Compile graph operations against the personal Patch. This replaces the unsaved draft, not the Profile. Propose graph-diff to ask the learner to accept it.",
      schema(graphProperties, ["operations"]),
      async (raw, session) => {
        const prepared = await graphDiff(host, raw, session);
        host.drafts.set(session.id, { base: prepared.view.graph.terminal.digest, content: prepared.content });
        return { content: { status: "draft", report: prepared.compiled.report, graph: prepared.compiled.graph } };
      },
    );
  }
  mount(
    "propose",
    'Ask approval for a Mission, graph-diff/revision, or preferences. For mission, input.mission is {id,statement,targets:[{node,provenance:{identity,digest}}],priority}; the same id revises an existing Mission. A Mission may start with targets:[] before charting; after graph acceptance, use mission again to attach its targets with exact provenance from read graph. For graph-diff/revision, input:{} submits the current edit_graph_draft; input.targets optionally selects Node ids. For preferences, input.text is the new text. For mode, input is {mode,then,entry}; choose an allowed switch from context. Entry shapes: {kind:"goal",text}, {kind:"mission",id}, {kind:"target",node}, {kind:"review",nodes}, or {kind:"lesson",opening:{missionId,number}} (omit number for the next uncleared Lesson). Call mission without scope to include Missions not yet targeted; its path supplies Lesson numbers after targets are attached. No proposed Profile change is applied before confirm.',
    schema(
      {
        op: { enum: ["mission", "graph-diff", "revision", "preferences", "settings", "mode"] },
        input: {
          type: "object",
          properties: {
            mission: schema(
              {
                id: string,
                statement: string,
                targets: {
                  type: "array",
                  items: schema(
                    {
                      node: string,
                      provenance: schema({ identity: string, digest: string }, ["identity", "digest"]),
                    },
                    ["node", "provenance"],
                  ),
                },
                priority: { type: "number" },
                guidance: { type: "array", items: { type: "object" } },
                assessment: { type: "array", items: { type: "object" } },
              },
              ["id", "statement", "targets", "priority"],
            ),
            mode: string,
            then: { enum: ["here", "next", "aside"] },
            entry: {
              type: "object",
              properties: {
                kind: { enum: ["goal", "mission", "target", "review", "lesson", "checkpoint"] },
                text: string,
                id: string,
                node: string,
                nodes: nodeList,
                opening: schema({ missionId: string, number: { type: "integer", minimum: 1 } }, ["missionId"]),
              },
              description:
                "For a Lesson use {kind:'lesson',opening:{missionId,number}}; omit number for the next uncleared Lesson. The host resolves the complete snapshot.",
            },
            ...graphProperties,
            text: string,
          },
        },
        title: string,
        description: string,
      },
      ["op", "input"],
    ),
    async (raw, session) => {
      const op = text(raw.op, "proposal operation");
      const input = args(raw.input);
      if (op === "mode") {
        const view = await host.runtime.snapshot();
        const mode = text(input.mode, "mode");
        const selected = host.mode(view.theory, session.mode, session.entry);
        const allowed = selected?.switches.find(
          (item) => item.mode === mode && (input.then === undefined || item.then === input.then),
        );
        if (!allowed)
          throw new Error("Mode switch is not allowed. Allowed: " + JSON.stringify(selected?.switches ?? []));
        let entry;
        if (object(input.entry) && input.entry.kind === "lesson" && object(input.entry.opening)) {
          const { missionId, number } = input.entry.opening;
          if (number !== undefined && (typeof number !== "number" || !Number.isSafeInteger(number)))
            throw new Error("Lesson number must be an integer");
          entry = await host.lessonEntry(text(missionId, "Mission id"), number);
        } else entry = input.entry === undefined ? undefined : modeEntry(input.entry);
        const to: ModeSwitch = { ...allowed, ...(entry === undefined ? {} : { entry }) };
        await host.switchMode(session, to);
        return { content: { status: "switching" }, switch: to };
      }
      let detail: unknown = input;
      let apply: () => Promise<unknown>;
      if (op === "graph-diff" || op === "revision") {
        if (!capabilities.includes("graph-draft")) throw new Error("This mode cannot propose graph changes");
        const view = await host.runtime.snapshot();
        const draft = input.operations === undefined ? host.drafts.get(session.id) : undefined;
        if (draft && draft.base !== view.graph.terminal.digest) throw new Error("Draft is stale; compile again");
        const content = draft?.content ?? (await graphDiff(host, input, session)).content;
        detail = { from: view.graph.terminal, before: await host.runtime.content(), after: content };
        apply = async () => {
          const targets = input.targets === undefined ? session.about : nodes(input.targets);
          const about = targets.length
            ? targets
            : content.delta.operations.flatMap((op) => (op.kind === "add-node" ? [op.node.id] : []));
          const ref = await acceptContent(host, session, view.graph.terminal, content, about);
          host.drafts.delete(session.id);
          return ref;
        };
      } else if (op === "mission") {
        if (!isMission(input.mission))
          throw new Error(
            "input.mission must be a Core Mission (id, statement, targets:[{node,provenance:{identity,digest}}], priority:number)",
          );
        const mission = input.mission;
        const existing = (await host.missionReadings()).some((reading) => reading.mission.id === mission.id);
        apply = () => host.reviseMission(mission, !existing);
      } else if (op === "preferences") {
        const preferences = text(input.text, "preferences text");
        apply = async () =>
          host.runtime.profile.appendLog([
            platform({
              kind: "local.config",
              timezone: host.runtime.timezone,
              preferences,
            }),
          ]);
      } else if (op === "settings") {
        const current = await host.config();
        const config = { ...current, ...input };
        apply = () => host.configure(config);
      } else throw new Error("Unsupported proposal operation");
      const accepted = await host.confirm({
        kind: op,
        title: typeof raw.title === "string" ? raw.title : op,
        description: typeof raw.description === "string" ? raw.description : "Apply this change to your Profile?",
        detail,
      });
      if (!accepted) return { content: { status: "refused" } };
      const result = await apply();
      return { content: { status: "accepted", result } };
    },
  );
  if (capabilities.includes("materials")) {
    mount(
      "material",
      "Store or open a Material as a local file. add/edit input: id, about (Node ids), filename, mediaType, and text or base64 bytes, optional type and meta. Bytes and Material enter the Profile; the learner's working copy is under materials/<node>/. command records input.outcome through the Theory; bash and applet execution belong to the front end.",
      schema({ op: { enum: ["add", "edit", "open", "remove", "command"] }, input: { type: "object" } }, [
        "op",
        "input",
      ]),
      async (raw, session) => {
        const input = args(raw.input);
        const id = safeName(input.id);
        const view = await host.runtime.snapshot();
        const previous = view.graph.materials.find((item) => item.id === id && item.playground === "local");
        if (raw.op === "command") {
          if (!previous) throw new Error("Unknown local Material");
          const event = await host.runtime.event(
            {
              kind: "outcome",
              material: { playground: previous.playground, id },
              surface: session.surface,
              at: view.now,
              about: previous.about,
              payload: input.outcome,
            },
            session,
          );
          await host.runtime.profile.appendLog(event.entries);
          return { content: { status: "recorded" } };
        }
        if (raw.op === "open") {
          const material = previous ?? view.graph.materials.find((item) => item.id === id);
          if (!material) throw new Error("Unknown Material");
          const bytes = view.profile.blobs.get(material.content.hash);
          if (!bytes) throw new Error("Missing Material bytes");
          const path =
            material.playground === "local" ? await checkout(host.runtime.profile.dir, material, bytes) : undefined;
          await host.runtime.profile.appendLog([
            platform({
              kind: "local.material",
              surface: session.surface,
              material,
              object: "object-" + crypto.randomUUID(),
            }),
          ]);
          return { content: { material, ...(path ? { path } : { runner: "unavailable on this host" }) } };
        }
        if (raw.op === "remove") {
          if (!previous) throw new Error("Unknown local Material");
          const content = composePatch(await host.runtime.content(), [
            { kind: "remove-material", playground: "local", id },
          ]);
          await acceptContent(host, session, view.graph.terminal, content);
          return { content: { status: "removed", id } };
        }
        if (raw.op !== "add" && raw.op !== "edit") throw new Error("Unsupported Material operation");
        if ((raw.op === "add" && previous) || (raw.op === "edit" && !previous))
          throw new Error("Material already exists or is missing");
        const about = nodes(input.about);
        for (const node of about)
          if (!view.graph.nodes.some(({ id }) => id === node)) throw new Error("Missing Node " + node);
        const filename = safeName(input.filename);
        const mediaType = text(input.mediaType, "media type");
        if ((typeof input.text === "string") === (typeof input.base64 === "string"))
          throw new Error("Supply either text or base64 bytes");
        const bytes =
          typeof input.text === "string"
            ? new TextEncoder().encode(input.text)
            : Buffer.from(text(input.base64, "base64"), "base64");
        if (input.meta !== undefined && !isMaterialMeta(input.meta)) throw new Error("Invalid Material metadata");
        const hash = await host.runtime.profile.addBlob(bytes);
        const material: Material = {
          playground: "local",
          type: typeof input.type === "string" ? input.type : "file",
          id,
          about,
          content: { kind: "blob", hash, mediaType },
          meta: { ...(isMaterialMeta(input.meta) ? input.meta : {}), filename },
        };
        const content = composePatch(await host.runtime.content(), [
          { kind: raw.op === "add" ? "add-material" : "edit-material", material },
        ]);
        await acceptContent(host, session, view.graph.terminal, content);
        const path = await checkout(host.runtime.profile.dir, material, bytes, previous);
        await host.runtime.profile.appendLog([
          platform({
            kind: "local.material",
            surface: session.surface,
            material,
            object: "object-" + crypto.randomUUID(),
          }),
        ]);
        const event = await host.runtime.event(
          {
            kind: "object.put",
            object: `object-${crypto.randomUUID()}`,
            meta: { name: filename, mime: mediaType, bytes: bytes.length },
            surface: session.surface,
          },
          session,
        );
        await host.runtime.profile.appendLog(event.entries);
        return { content: { status: "available", material, path } };
      },
    );
  }
  if (metadataKeys.length) {
    mount(
      "edit_metadata",
      "Edit this mode's authorized metadata keys on existing Nodes: " + metadataKeys.join(", "),
      schema({ nodes: nodeList, properties: { type: "object" } }, ["nodes", "properties"]),
      async (raw, session) => {
        const attached = nodes(raw.nodes);
        const properties = metadataProperties(raw.properties);
        if (Object.keys(properties).some((key) => !metadataKeys.includes(key)))
          throw new Error("Metadata key is not editable in this mode");
        const view = await host.runtime.snapshot();
        for (const node of attached)
          if (!view.graph.nodes.some(({ id }) => id === node)) throw new Error("Missing Node " + node);
        const content = composePatch(await host.runtime.content(), [
          {
            kind: "add-metadata-set",
            metadataSet: {
              id: `metadata-${crypto.randomUUID()}`,
              subjects: attached.map((id) => ({ kind: "node" as const, id })),
              properties,
            },
          },
        ]);
        return { content: { patch: await acceptContent(host, session, view.graph.terminal, content) } };
      },
    );
  }
  if (capabilities.includes("graph-draft") || capabilities.includes("materials")) {
    mount(
      "undo",
      "Discard this Session's draft, or restore the prior personal Patch for its most recent accepted edit. Evidence is immutable; correct it with the Theory's retraction tools.",
      schema({}),
      async (_raw, session) => {
        if (host.drafts.delete(session.id)) return { content: { status: "draft-discarded" } };
        const view = await host.runtime.snapshot();
        const entry = view.profile.log
          .filter((entry) => "surface" in entry && entry.surface === session.surface)
          .map((entry) => localPayload(entry, "local.patch"))
          .filter((entry) => entry !== undefined)
          .at(-1);
        if (!entry || !object(entry.from) || !object(entry.to) || entry.to.digest !== view.graph.terminal.digest)
          throw new Error("No current Session edit to undo");
        const before = await host.runtime.snapshot(exactRef(entry.from));
        const revision = before.bundle.revisions.find(({ ref }) => sameExactPatchRef(ref, before.bundle.terminal));
        if (!revision) throw new Error("Undo revision is missing");
        return {
          content: {
            status: "restored",
            patch: await acceptContent(host, session, view.graph.terminal, revisionContent(revision)),
          },
        };
      },
    );
  }
  mount(
    "skill",
    "Read a mounted pedagogy or local-host Skill, or one of its named relative resources.",
    schema({ name: string, resource: string }, ["name"]),
    async (raw) => {
      const skill = [...skills, mechanics].find(({ name }) => name === raw.name);
      if (!skill) throw new Error("Unknown Skill");
      if (raw.resource === undefined)
        return {
          content: { name: skill.name, body: skill.body, resources: skill.resources?.map(({ path }) => path) ?? [] },
        };
      const resource = skill.resources?.find(({ path }) => path === raw.resource);
      if (!resource) throw new Error("Unknown Skill resource");
      return { content: resource.content };
    },
  );
  return tools;
}
function workingPath(dir: string, material: Material): string {
  return join(
    dir,
    "materials",
    safeName(material.about[0] ?? "unscoped"),
    safeName(material.id),
    safeName(material.meta.filename),
  );
}
async function checkout(dir: string, material: Material, bytes: Uint8Array, previous?: Material): Promise<string> {
  const path = workingPath(dir, material);
  await mkdir(join(path, ".."), { recursive: true });
  const existing = previous ? await readFile(path).catch(() => undefined) : undefined;
  const unchanged = existing && previous && attachmentDigest(existing) === previous.content.hash;
  try {
    await writeFile(path, bytes, { flag: unchanged ? "w" : "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  return path;
}
