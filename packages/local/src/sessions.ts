/** The exchange subset of pi 1.5's version-3 session format. Provider metadata is retained. */
export interface PiSessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  [key: string]: unknown;
}
export type PiContent =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: "image"; data: string; mimeType: string; [key: string]: unknown }
  | { type: "thinking"; thinking: string; [key: string]: unknown }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; [key: string]: unknown };
export type PiMessage =
  | { role: "user"; content: string | readonly PiContent[]; timestamp: number; [key: string]: unknown }
  | {
      role: "assistant";
      content: readonly PiContent[];
      api: string;
      provider: string;
      model: string;
      usage: Readonly<Record<string, unknown>>;
      stopReason: string;
      timestamp: number;
      [key: string]: unknown;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: readonly PiContent[];
      isError: boolean;
      timestamp: number;
      [key: string]: unknown;
    };
export interface PiSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  /** Present on message entries; other pi entries are kept opaque, not discarded. */
  message?: PiMessage;
  [key: string]: unknown;
}
export interface PiMessageEntry extends PiSessionEntry {
  type: "message";
  message: PiMessage;
}
export interface PiSession {
  header: PiSessionHeader;
  entries: readonly PiSessionEntry[];
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function timestamp(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}
function content(value: unknown): value is PiContent {
  if (!object(value)) return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
      return typeof value.data === "string" && text(value.mimeType);
    case "thinking":
      return typeof value.thinking === "string";
    case "toolCall":
      return text(value.id) && text(value.name) && object(value.arguments);
    default:
      return false;
  }
}
function exchangeMessage(value: unknown): boolean {
  return !object(value) || value.role === "user" || value.role === "assistant" || value.role === "toolResult";
}
function message(value: unknown): value is PiMessage {
  if (!object(value) || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return false;
  if (value.role === "user" && typeof value.content === "string") return true;
  if (!Array.isArray(value.content) || !value.content.every(content)) return false;
  if (value.role === "user") return true;
  if (value.role === "assistant")
    return (
      text(value.api) && text(value.provider) && text(value.model) && object(value.usage) && text(value.stopReason)
    );
  return (
    value.role === "toolResult" && text(value.toolCallId) && text(value.toolName) && typeof value.isError === "boolean"
  );
}
export function parsePiSession(source: string): PiSession {
  const lines = source.trimEnd().split("\n");
  const values: unknown[] = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error("Invalid pi session JSON at line " + (index + 1));
    }
  });
  const header = values.shift();
  if (
    !object(header) ||
    header.type !== "session" ||
    header.version !== 3 ||
    !text(header.id) ||
    !timestamp(header.timestamp) ||
    !text(header.cwd)
  )
    throw new Error("Invalid pi session header (expected version 3)");
  const entries: PiSessionEntry[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    if (
      !object(value) ||
      !text(value.type) ||
      value.type === "session" ||
      !text(value.id) ||
      !(value.parentId === null || text(value.parentId)) ||
      !timestamp(value.timestamp)
    )
      throw new Error("Invalid pi session entry at line " + (entries.length + 2));
    if (ids.has(value.id)) throw new Error("Duplicate pi session entry: " + value.id);
    // pi also stores bashExecution and similar roles in message entries; only the exchange's roles are typed.
    if (value.type === "message" && exchangeMessage(value.message) && !message(value.message))
      throw new Error("Invalid pi message at line " + (entries.length + 2));
    ids.add(value.id);
    // Narrow through the same entry guard, without coercing provider-specific fields.
    const entry: PiSessionEntry = {
      ...value,
      type: value.type,
      id: value.id,
      parentId: value.parentId,
      timestamp: value.timestamp,
      ...(value.type === "message" && message(value.message) ? { message: value.message } : {}),
    };
    entries.push(entry);
  }
  return {
    header: { ...header, type: "session", version: 3, id: header.id, timestamp: header.timestamp, cwd: header.cwd },
    entries,
  };
}
export function serializePiSession(session: PiSession): string {
  const source = [session.header, ...session.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  parsePiSession(source);
  return source;
}
export function relocatePiSession(source: string, cwd: string): string {
  const session = parsePiSession(source);
  return serializePiSession({ ...session, header: { ...session.header, cwd } });
}
/** pi, not the surface id, chooses this filename. Persist its association in profile.json. */
export function piSessionFilename(header: PiSessionHeader): string {
  if (!/^[a-zA-Z0-9-]+$/.test(header.id) || !timestamp(header.timestamp))
    throw new Error("Invalid pi session identity");
  return header.timestamp.replace(/[:.]/g, "-") + "_" + header.id + ".jsonl";
}
