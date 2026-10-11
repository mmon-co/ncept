/** The terminal reply of a mode declaring `reply: "in-character-and-aside"`. Both fields are Markdown. */
export type SceneReply = Readonly<{ inCharacter: string; aside: string }>;
export const SCENE_REPLY_TOOL = "scene_reply";
export const SCENE_REPLY_RECEIPT = "Scene reply delivered.";

export function sceneReply(value: unknown): SceneReply | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const inCharacter: unknown = Reflect.get(value, "inCharacter");
  const aside: unknown = Reflect.get(value, "aside");
  return typeof inCharacter === "string" && inCharacter.trim() !== "" && typeof aside === "string"
    ? { inCharacter, aside }
    : undefined;
}

/** Stored model tool-call parts keep the words in the call, not a duplicate result. */
export function sceneReplyPart(part: unknown): SceneReply | undefined {
  if (typeof part !== "object" || part === null || Reflect.get(part, "toolName") !== SCENE_REPLY_TOOL) return undefined;
  return sceneReply(Reflect.get(part, "input") ?? Reflect.get(part, "args"));
}

/** Plain transcript/Copy projection: dialogue first; role names remain explicit even for an empty aside. */
export function sceneReplyText(reply: SceneReply, labels = { inCharacter: "In character", aside: "Aside" }): string {
  return `${labels.inCharacter}:\n${reply.inCharacter}\n\n${labels.aside}:\n${reply.aside}`;
}
