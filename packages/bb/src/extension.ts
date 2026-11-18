import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ADOPT_SESSION,
  BEGIN_SESSION,
  OPEN_SESSION,
  type AdoptSession,
  type BeginSession,
  type OpenSession,
} from "@mmon-co/ncept-pi/events";
import { entrySchema } from "./entries";

function isHandoff(value: unknown): value is OpenSession {
  return (
    !!value &&
    typeof value === "object" &&
    "session" in value &&
    typeof value.session === "string" &&
    "mode" in value &&
    typeof value.mode === "string" &&
    "aside" in value &&
    typeof value.aside === "boolean" &&
    "claim" in value &&
    typeof value.claim === "function"
  );
}

export default function nceptBb(pi: ExtensionAPI) {
  if (!process.env.BB_THREAD_ID) return;

  async function command(args: string[]) {
    const result = await pi.exec(process.env.BB_CLI || "bb", ["concept", ...args]);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "bb concept failed");
    return JSON.parse(result.stdout);
  }

  pi.registerCommand("ncept-kickoff", {
    description: "Begin a tutor-led Session from host context",
    handler: async (instruction) => {
      pi.sendMessage(
        {
          customType: "ncept.opening",
          content: "Tutor-led Session opening (host context, not learner speech). " + instruction,
          display: false,
        },
        { triggerTurn: true },
      );
    },
  });

  let refusal: string | undefined;
  let associated: string | undefined;
  async function associate(ctx: ExtensionContext) {
    const entry = ctx.sessionManager
      .getBranch()
      .findLast((item) => item.type === "custom" && item.customType === "ncept.session");
    const data = entry?.type === "custom" ? entry.data : undefined;
    const session =
      data && typeof data === "object" && "id" in data && typeof data.id === "string" ? data.id : undefined;
    if (!session || session === associated) return;
    await command(["associate", "--session", session]);
    associated = session;
  }

  // session_start errors are reported by pi but do not stop the first prompt.
  // Consume input before ncept-pi can prepare an ordinary empty Session instead.
  pi.on("input", (_event, ctx) => {
    if (!refusal) return;
    // bb reports an exited pi process, including stderr, as a failed turn.
    // A handled prompt alone leaves its bridge waiting for agent_end.
    console.error(refusal);
    ctx.shutdown();
    return { action: "handled" };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    await associate(ctx);
  });
  pi.on("session_start", async (_event, ctx) => {
    const rejected = ctx.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === "ncept.entry-refused");
    refusal = rejected?.type === "custom" && typeof rejected.data === "string" ? rejected.data : undefined;
    if (refusal) return;
    const stored = ctx.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === "ncept.session");
    if (!stored && process.env.NCEPT_BB_ENTRY) {
      try {
        const intent = entrySchema.parse(JSON.parse(process.env.NCEPT_BB_ENTRY));
        let begin: (() => ReturnType<Parameters<BeginSession["claim"]>[0]>) | undefined;
        pi.events.emit(BEGIN_SESSION, {
          intent,
          claim: (open) => {
            begin = open;
          },
        } satisfies BeginSession);
        if (!begin) throw new Error("The tutoring extension did not accept the Session entry");
        await begin();
      } catch (error) {
        refusal = "Could not start this learning Session: " + (error instanceof Error ? error.message : String(error));
        pi.appendEntry("ncept.entry-refused", refusal);
        return;
      }
      await associate(ctx);
      return;
    }
    const session = process.env.NCEPT_BB_SESSION;
    // A restarted pi process must keep the existing conversation and carry.
    if (!session || stored) {
      await associate(ctx);
      return;
    }
    const carry = process.env.NCEPT_BB_CARRY_REF
      ? (await command(["carry", "--thread", process.env.NCEPT_BB_CARRY_REF])).carry
      : process.env.NCEPT_BB_CARRY;
    pi.events.emit(ADOPT_SESSION, { session, ...(carry ? { carry } : {}) } satisfies AdoptSession);
    await associate(ctx);
  });

  pi.events.on(OPEN_SESSION, (data) => {
    if (!isHandoff(data)) return;
    const handoff = data;
    handoff.claim(async () => {
      const directory = await mkdtemp(join(tmpdir(), "ncept-bb-"));
      try {
        const path = join(directory, "handoff.json");
        await writeFile(
          path,
          JSON.stringify({
            session: handoff.session,
            mode: handoff.mode,
            kickoff: handoff.kickoff,
            learnerKickoff: handoff.learnerKickoff,
            carry: handoff.carry,
            aside: handoff.aside,
          }),
          { mode: 0o600 },
        );
        const result = await command(["spawn", "--request-file", path]);
        return "Continue in @thread:" + result.threadId;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
}
