// Optional encounter recorder: MMON_RECORD=/private/path.jsonl pi -e /path/to/this/file.ts
// Records prompts, tools and model replies, never provider credentials.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function recordFirstUse(pi: ExtensionAPI) {
  const path = process.env.MMON_RECORD ?? "";
  if (!path) throw new Error("Set MMON_RECORD to an unused private JSONL path.");
  const recorded = new WeakSet<object>();
  function save(type: string, value: unknown) {
    appendFileSync(path, JSON.stringify({ type, value }).replaceAll(process.cwd(), "$PROFILE") + "\n");
  }
  pi.on("session_start", (_event, ctx) => {
    const registry = ctx.modelRegistry;
    if (recorded.has(registry)) return;
    recorded.add(registry);
    const original = registry.streamSimple.bind(registry);
    registry.streamSimple = (model, context, options) => {
      save("model-request", { model: model.id, context });
      const stream = original(model, context, options);
      const result = stream.result.bind(stream);
      stream.result = async () => {
        const value = await result();
        save("model-response", value);
        return value;
      };
      return stream;
    };
  });
  pi.on("context_with_system", (event) => {
    save("request", event.messages);
  });
  pi.on("message_end", (event) => {
    save("message", event.message);
  });
}
