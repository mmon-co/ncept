import { useEffect, useState, type ButtonHTMLAttributes } from "react";
import { experimental_useRpcQuery, useRpc, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./contract";
import type { entrySchema } from "./entries";
import type { learningReading } from "./reading";
import type { z } from "zod";
import { Button } from "./ui/button";
import { LearnMap } from "./map";
import { MissionShare } from "./mission-share";

function MenuItem({
  hint,
  children,
  ...props
}: { hint?: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  return (
    <button
      {...props}
      className="block w-full cursor-pointer rounded-md px-3 py-2 text-left text-xs hover:bg-state-hover disabled:pointer-events-none disabled:opacity-50"
    >
      <span className="block font-medium">{children}</span>
      {hint && <small className="block text-muted-foreground">{hint}</small>}
    </button>
  );
}

export function MissionPage({
  projectId,
  missionId,
  sessions,
  pending,
  open,
  refreshed,
}: {
  projectId: string;
  missionId: string;
  sessions: z.infer<typeof learningReading>["sessions"];
  pending: boolean;
  refreshed: () => void;
  open: (intent: z.infer<typeof entrySchema>) => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const reading = experimental_useRpcQuery({
    contract: rpcContract,
    method: "mission",
    input: { projectId, missionId },
  });
  const [menu, setMenu] = useState<"skip" | "revise" | "share">();
  const [shareTitle, setShareTitle] = useState("");
  const [picking, setPicking] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [outcome, setOutcome] = useState<"achieved" | "abandoned">("achieved");
  const [telling, setTelling] = useState(false);
  const [request, setRequest] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    void reading.refetch();
    const refresh = () => {
      void reading.refetch();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [projectId, missionId]);
  async function visit(session: string) {
    setError(undefined);
    try {
      const result = await rpc.call("thread", { projectId, session });
      if (!result.threadId) throw new Error("No thread found for this Session");
      navigate.toThread(result.threadId);
    } catch (error) {
      setError(String(error));
    }
  }
  async function retire() {
    setRetiring(true);
    setError(undefined);
    try {
      await rpc.call("retire", { projectId, missionId, outcome });
      setFinishing(false);
      setMenu(undefined);
      await reading.refetch();
      refreshed();
    } catch (error) {
      setError(String(error));
    } finally {
      setRetiring(false);
    }
  }
  const data = reading.data;
  if (!data) return <p role={reading.error ? "alert" : undefined}>{reading.error?.message ?? "Loading Mission…"}</p>;
  const stops = data.sections.flatMap((section) => section.lessons);
  const here = stops.findIndex((stop) => stop.numbered && !stop.checkpoint && !stop.cleared);
  const later = stops.filter((stop, index) => here >= 0 && index > here && !stop.cleared);
  const currentSection =
    data.sections.find((section) => section.lessons.some((stop) => stop.active)) ??
    data.sections.find((section) => section.lessons.some((stop) => !stop.cleared));
  const asides = sessions.filter((session) => data.asides.includes(session.id));
  const history = data.history.filter(
    (entry) => entry.session !== data.active && !data.asides.includes(entry.session ?? ""),
  );
  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground flex gap-2 flex-wrap">
        <button onClick={() => navigate.toPluginPanel("learn")}>Learn</button>
        <span>/</span>
        <button onClick={() => navigate.toPluginPanel("learn")}>Missions</button>
        <span>/</span>
        <span className="text-foreground">{data.statement}</span>
      </nav>
      <header className="space-y-4">
        <h1 className="text-xl">{data.statement}</h1>
        {data.retired && <p className="text-sm text-muted-foreground">Retired</p>}
        <div className="flex flex-wrap gap-4">
          <Button disabled={pending || data.retired} onClick={() => void open({ kind: "continue", missionId })}>
            {data.active ? "Continue" : "Start"}
            {data.next ? " · " + data.next : ""} →
          </Button>
          <Button
            variant="outline"
            aria-expanded={menu === "skip"}
            onClick={() => {
              setMenu(menu === "skip" ? undefined : "skip");
              setTelling(false);
            }}
          >
            Skip…
          </Button>
          <Button
            variant="outline"
            aria-expanded={menu === "revise"}
            onClick={() => {
              setMenu(menu === "revise" ? undefined : "revise");
              setTelling(false);
            }}
          >
            Revise…
          </Button>
          <Button
            variant="outline"
            aria-expanded={menu === "share"}
            onClick={() => {
              setMenu(menu === "share" ? undefined : "share");
              setTelling(false);
              setShareTitle(shareTitle || data.statement.replace(/\s+/g, " ").slice(0, 80));
            }}
          >
            Share…
          </Button>
        </div>
        {menu && (
          <section
            aria-label={menu === "skip" ? "Skip" : menu === "revise" ? "Revise" : "Share"}
            className="rounded-lg border border-border p-2 max-w-sm bg-popover text-popover-foreground space-y-1"
          >
            {menu === "skip" ? (
              <>
                <MenuItem
                  disabled={pending || data.retired || !later.length}
                  onClick={() => void open({ kind: "skip-lesson", missionId })}
                >
                  Just this lesson
                </MenuItem>
                <MenuItem
                  disabled={pending || data.retired || !later.length}
                  onClick={() => setPicking(!picking)}
                  hint="Lessons in between are marked probably known."
                >
                  Skip to…
                </MenuItem>
                <MenuItem
                  disabled={pending || data.retired}
                  hint="Opens a thread with what you already know."
                  onClick={() => setTelling(true)}
                >
                  Tell the tutor
                </MenuItem>
              </>
            ) : menu === "revise" ? (
              <>
                <MenuItem
                  disabled={pending || !data.canReviseLesson || data.retired}
                  hint="Too hard, too easy or off target: the tutor reworks it with you."
                  onClick={() => void open({ kind: "revise-lesson", missionId })}
                >
                  This lesson
                </MenuItem>
                <MenuItem
                  disabled={pending || data.retired}
                  hint="Opens a thread to rework the Mission's path."
                  onClick={() => void open({ kind: "revise-route", missionId })}
                >
                  The route
                </MenuItem>
                <MenuItem
                  disabled={pending || data.retired}
                  onClick={() => setFinishing(!finishing)}
                  hint="As achieved or abandoned."
                >
                  Finish…
                </MenuItem>
              </>
            ) : null}
            {menu === "skip" && picking && (
              <section aria-label="Skip to" className="p-2 space-y-1">
                {later.map((stop, index) => (
                  <MenuItem
                    key={index}
                    disabled={pending || data.retired}
                    onClick={() => void open({ kind: "skip-to", missionId, stop: stop.skip })}
                  >
                    {stop.checkpoint ? "Checkpoint: " : stop.number + " · "}
                    {stop.name}
                  </MenuItem>
                ))}
              </section>
            )}
            {menu === "revise" && finishing && (
              <form
                aria-label="Finish Mission"
                className="p-2 space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void retire();
                }}
              >
                <p className="text-sm">Finish this Mission?</p>
                {(["achieved", "abandoned"] as const).map((value) => (
                  <label key={value} className="flex gap-2 text-sm">
                    <input
                      type="radio"
                      name="outcome"
                      checked={outcome === value}
                      disabled={retiring}
                      onChange={() => setOutcome(value)}
                    />
                    {value === "achieved" ? "Achieved" : "Abandoned"}
                  </label>
                ))}
                <div className="flex gap-4">
                  <Button type="submit" disabled={retiring || data.retired}>
                    Finish Mission
                  </Button>
                  <Button type="button" variant="ghost" disabled={retiring} onClick={() => setFinishing(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {menu === "share" && (
              <MissionShare projectId={projectId} missionId={missionId} title={shareTitle} setTitle={setShareTitle} />
            )}
            {telling && (
              <form
                className="p-2 space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (request.trim()) void open({ kind: "tell-tutor", missionId, request: request.trim() });
                }}
              >
                <label className="block text-sm" htmlFor="tutor-request">
                  Tell the tutor
                </label>
                <textarea
                  id="tutor-request"
                  autoFocus
                  value={request}
                  onChange={(event) => setRequest(event.target.value)}
                  placeholder="What do you already know?"
                  className="w-full min-h-24 rounded-md border border-input bg-background p-3 text-sm"
                />
                <Button disabled={pending || !request.trim()} type="submit">
                  Open thread →
                </Button>
              </form>
            )}
          </section>
        )}
      </header>
      <div className="h-56 overflow-hidden rounded-xl border border-border">
        <LearnMap projectId={projectId} mission={missionId} still />
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {data.active && !data.sections.some((section) => section.lessons.some((stop) => stop.active)) && (
        <p className="text-sm">Open · {sessions.find((session) => session.id === data.active)?.title ?? "Session"}</p>
      )}
      <section
        aria-label="Itinerary"
        className="rounded-xl border border-border overflow-hidden divide-y divide-border"
      >
        {data.sections.map((section) => (
          <div key={section.number}>
            <h2 className="px-4 py-3 bg-muted flex flex-wrap justify-between gap-2 text-sm">
              <span>
                Milestone {section.number} · {section.label}
                {!data.retired && section === currentSection ? " · you are here" : ""}
              </span>
              <span className="text-muted-foreground">
                {section.lessons.length
                  ? section.lessons.filter((stop) => stop.numbered && stop.cleared).length +
                    " of " +
                    section.lessons.filter((stop) => stop.numbered).length +
                    " lessons"
                  : "not planned yet"}
              </span>
            </h2>
            {section.lessons.map((stop, index) => {
              const active = stop.active;
              return (
                <div key={index} className={"px-4 py-3 text-sm " + (active ? "bg-accent" : "")}>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">
                      {stop.cleared ? "✓" : stop.checkpoint ? "◇" : stop.number}
                    </span>
                    <span className="flex-1">
                      {stop.checkpoint ? "Checkpoint: " : stop.kind === "review" ? "Review: " : ""}
                      {stop.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {active
                        ? "open"
                        : stop.cleared
                          ? stop.probablyKnown
                            ? "probably known"
                            : "cleared"
                          : stop.minutes === undefined
                            ? ""
                            : "about " + Math.round(stop.minutes) + " min"}
                    </span>
                  </div>
                  {active &&
                    asides.map((aside) => (
                      <div key={aside.id} className="pl-6 pt-3 flex items-center gap-3">
                        <span className="flex-1 text-muted-foreground">↳ Aside · {aside.title}</span>
                        <Button variant="ghost" onClick={() => void visit(aside.id)}>
                          Resume
                        </Button>
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        ))}
        {!data.sections.length && <p className="p-4 text-muted-foreground">No stops planned yet</p>}
      </section>
      {!!asides.length && !data.sections.some((section) => section.lessons.some((stop) => stop.active)) && (
        <section className="space-y-3">
          <h2 className="text-sm text-muted-foreground">Kept asides</h2>
          {asides.map((aside) => (
            <div key={aside.id} className="flex items-center gap-3 text-sm">
              <span className="flex-1">{aside.title}</span>
              <Button variant="outline" onClick={() => void visit(aside.id)}>
                Resume
              </Button>
            </div>
          ))}
        </section>
      )}
      <section className="space-y-3">
        <h2 className="text-sm text-muted-foreground">History</h2>
        {!history.length && <p className="text-sm text-muted-foreground">No past Sessions yet</p>}
        {history.map((entry, index) => (
          <div key={index} className="border-b border-border py-3 text-sm">
            {entry.session ? (
              <button
                className="text-left hover:underline"
                onClick={() => {
                  if (entry.session) void visit(entry.session);
                }}
              >
                {entry.parent ? "↳ Aside · " : ""}
                {entry.label}
              </button>
            ) : (
              <span>{entry.label}</span>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              {entry.session
                ? sessions.find((session) => session.id === entry.session)?.closed
                  ? "closed · "
                  : "open · "
                : ""}
              {new Date(entry.at).toLocaleDateString()}
            </p>
          </div>
        ))}
      </section>
    </>
  );
}
