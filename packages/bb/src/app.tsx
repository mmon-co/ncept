import { useEffect, useSyncExternalStore, useState } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery,
  experimental_usePluginId,
  useRpc,
  useBbNavigate,
  experimental_ThreadContextCardRow as ContextRow,
  type PluginNavPanelProps,
  type ExperimentalThreadContextCardProps,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./contract";
import type { entrySchema } from "./entries";
import type { z } from "zod";
import { Button } from "./ui/button";
import { MissionPage } from "./mission-page";
import { LearnMap } from "./map";

const listeners = new Set<() => void>();
function useLearn(poll = false) {
  const pluginId = experimental_usePluginId();
  const key = pluginId + ":profile";
  const selected = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      window.addEventListener("storage", callback);
      return () => {
        listeners.delete(callback);
        window.removeEventListener("storage", callback);
      };
    },
    () => localStorage.getItem(key),
  );
  const profiles = experimental_useRpcQuery({ contract: rpcContract, method: "profiles", input: {} });
  const choices = profiles.data ?? [];
  const choice = choices.find((item) => item.projectId === selected) ?? choices[0];
  const reading = experimental_useRpcQuery({
    contract: rpcContract,
    method: "reading",
    input: { projectId: choice?.projectId ?? "" },
    enabled: Boolean(choice),
  });
  useEffect(() => {
    void profiles.refetch();
    if (choice) void reading.refetch();
    const refresh = () => {
      void profiles.refetch();
      if (choice) void reading.refetch();
    };
    window.addEventListener("focus", refresh);
    const timer = poll ? window.setInterval(refresh, 10000) : undefined;
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [choice?.projectId, poll]);
  function select(projectId: string) {
    localStorage.setItem(key, projectId);
    for (const listener of listeners) listener();
  }
  return { choices, choice, select, reading, profiles };
}

function ProfilePicker() {
  const { choices, choice, select } = useLearn();
  const navigate = useBbNavigate();
  if (!choice) return null;
  return (
    <select
      aria-label="Profile"
      className="bg-transparent text-muted-foreground text-xs max-w-full rounded-md px-2 py-1"
      value={choice.projectId}
      onChange={(event) => {
        select(event.target.value);
        navigate.toPluginPanel("learn");
      }}
    >
      {choices.map((item) => (
        <option key={item.projectId} value={item.projectId}>
          {item.directory}
        </option>
      ))}
    </select>
  );
}

export function LearnPanel({ subPath }: PluginNavPanelProps) {
  const { choice, reading, profiles } = useLearn();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function open(intent: z.infer<typeof entrySchema>) {
    if (!choice) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await rpc.call("open", { projectId: choice.projectId, intent });
      navigate.toThread(result.threadId);
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(false);
    }
  }
  const data = reading.data;
  if (!choice)
    return (
      <div className="p-6 text-muted-foreground">
        {profiles.error
          ? profiles.error.message
          : profiles.isLoading
            ? "Loading Profiles…"
            : "No Profiles yet. Create one with bb concept init."}
      </div>
    );
  if (!data) return <div className="p-6 text-muted-foreground">{reading.error?.message ?? "Loading…"}</div>;
  if (subPath === "map" || subPath.startsWith("map/"))
    return (
      <LearnMap
        key={choice.projectId + subPath}
        projectId={choice.projectId}
        {...(subPath.length > 4 ? { mission: decodeURIComponent(subPath.slice(4)) } : {})}
        dock
      />
    );
  const missionId = subPath.startsWith("missions/") ? decodeURIComponent(subPath.slice(9)) : undefined;
  return (
    <div className="concept-learn h-full overflow-auto bg-background text-foreground">
      <main className="mx-auto max-w-3xl p-6 space-y-8">
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {reading.error && <p role="alert">{reading.error.message}</p>}
        {missionId ? (
          <MissionPage
            key={choice.projectId + missionId}
            projectId={choice.projectId}
            missionId={missionId}
            sessions={data.sessions}
            pending={pending}
            open={open}
            refreshed={() => void reading.refetch()}
          />
        ) : (
          <>
            {data.missions.filter((item) => !item.retired).length ? (
              <section>
                <h2 className="text-xs text-muted-foreground mb-3">Missions</h2>
                <div className="rounded-xl border border-border divide-y divide-border overflow-hidden">
                  {data.missions
                    .filter((item) => !item.retired)
                    .map((item) => (
                      <div key={item.id} className="p-4 flex gap-4 items-center">
                        <button
                          className="flex-1 min-w-0 text-left"
                          onClick={() =>
                            navigate.toPluginPanel("learn", { subPath: "missions/" + encodeURIComponent(item.id) })
                          }
                        >
                          <div className="font-medium">{item.statement}</div>
                          <div className="text-xs text-muted-foreground mt-2">
                            {item.nodes} {item.nodes === 1 ? "Node" : "Nodes"}
                            {item.next ? " · next " + item.next : ""}
                          </div>
                        </button>
                        <Button
                          variant={item.active ? "default" : "outline"}
                          disabled={pending}
                          onClick={() => void open({ kind: "continue", missionId: item.id })}
                        >
                          {item.active ? "Continue →" : "Start →"}
                        </Button>
                      </div>
                    ))}
                  <button
                    className="w-full text-left px-4 py-3 text-muted-foreground hover:bg-accent"
                    disabled={pending}
                    onClick={() => void open({ kind: "new-mission" })}
                  >
                    + New Mission
                  </button>
                </div>
              </section>
            ) : (
              <section className="rounded-xl border border-border p-8 text-center">
                <p className="mb-5 text-muted-foreground">
                  No Missions yet. Say what you want to learn in a new thread, or
                </p>
                <Button disabled={pending} onClick={() => void open({ kind: "new-mission" })}>
                  + New Mission
                </Button>
              </section>
            )}
            {data.missions.some((item) => item.retired) && (
              <section className="space-y-3">
                <h2 className="text-xs text-muted-foreground">Retired</h2>
                {data.missions
                  .filter((item) => item.retired)
                  .map((item) => (
                    <button
                      key={item.id}
                      className="block text-left text-sm hover:underline"
                      onClick={() =>
                        navigate.toPluginPanel("learn", { subPath: "missions/" + encodeURIComponent(item.id) })
                      }
                    >
                      {item.statement}
                    </button>
                  ))}
              </section>
            )}
            {data.dueReview.length > 0 && (
              <section>
                <h2 className="text-xs text-muted-foreground mb-3">Today</h2>
                <p>
                  {data.dueReview.length} {data.dueReview.length === 1 ? "Node" : "Nodes"} due
                  <span className="text-muted-foreground text-sm">
                    {" "}
                    · {data.dueReview.map((item) => item.label).join(", ")}
                  </span>
                </p>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Sessions() {
  const { reading } = useLearn();
  const navigate = useBbNavigate();
  const sessions = reading.data?.sessions.filter((item) => item.threadId) ?? [];
  return (
    <div className="p-2 text-sm">
      {[false, true].map((closed) => (
        <section key={String(closed)}>
          <h2 className="px-2 py-3 text-xs text-muted-foreground">{closed ? "Closed" : "Open Sessions"}</h2>
          {sessions
            .filter((item) => item.closed === closed)
            .map((item) => (
              <button
                key={item.id}
                className={
                  "block w-full rounded-md px-2 py-2 text-left truncate hover:bg-accent " +
                  (item.parent ? "pl-5 " : "") +
                  (closed ? "text-muted-foreground" : "")
                }
                onClick={() => navigate.toThread(item.threadId ?? "")}
              >
                {item.title}
              </button>
            ))}
        </section>
      ))}
      {!sessions.length && <p className="px-2 text-muted-foreground">No Sessions yet.</p>}
    </div>
  );
}

function SessionContext({ threadId }: ExperimentalThreadContextCardProps) {
  const result = experimental_useRpcQuery({ contract: rpcContract, method: "context", input: { threadId } });
  useEffect(() => {
    const timer = window.setInterval(() => void result.refetch(), 10000);
    return () => window.clearInterval(timer);
  }, [threadId]);
  const session = result.data;
  if (!session) return null;
  return (
    <>
      <ContextRow
        icon="BookOpen"
        label={session.mode.charAt(0).toUpperCase() + session.mode.slice(1)}
        title="Session mode"
      />
      {session.mission && <ContextRow label={session.missionLabel ?? session.mission} title="Mission" />}
      {session.nodes.length > 0 && (
        <ContextRow label={session.nodes.map((node) => node.label).join(", ")} title="Node" />
      )}
    </>
  );
}
function useBadge() {
  const { reading } = useLearn(true);
  const count = reading.data?.dueReview.length ?? 0;
  return count ? { count, label: count + (count === 1 ? " card due" : " cards due") } : null;
}
function useLearnThread({ threadId }: { threadId: string }) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "threadProject", input: { threadId } }).data ?? null;
}
function ThreadMap({ threadId }: { threadId: string }) {
  const projectId = useLearnThread({ threadId });
  const context = experimental_useRpcQuery({ contract: rpcContract, method: "context", input: { threadId } });
  if (!projectId || context.isLoading) return null;
  const session = context.data;
  return (
    <LearnMap
      key={session?.id}
      projectId={projectId}
      {...(session?.nodes.length || session?.mission
        ? {
            session: {
              nodes: session.nodes.map((node) => node.id),
              ...(session.mission ? { mission: session.mission } : {}),
            },
          }
        : {})}
    />
  );
}
function Header({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const onMap = subPath === "map" || subPath.startsWith("map/");
  const tab = (label: string, on: boolean, to: string) => (
    <button
      aria-current={on ? "page" : undefined}
      className={"rounded px-2.5 py-0.5 " + (on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}
      onClick={() => navigate.toPluginPanel("learn", { subPath: to })}
    >
      {label}
    </button>
  );
  return (
    <div className="flex min-w-0 items-center gap-3">
      <nav aria-label="Learn" className="inline-flex rounded-md bg-accent p-0.5 text-xs">
        {tab("Overview", !onMap, "")}
        {tab("Map", onMap, "map")}
      </nav>
      <ProfilePicker />
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "learn",
    path: "learn",
    title: "Learn",
    icon: "BookOpen",
    component: LearnPanel,
    experimental_sidebar: Sessions,
    headerContent: Header,
    experimental_useBadge: useBadge,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "map",
    title: "Map",
    icon: "Network",
    layout: "flush",
    useVisible: (props) => useLearnThread(props) !== null,
    component: ThreadMap,
  });
  app.slots.experimental_threadContextCardRow({ id: "session", group: "1_context", component: SessionContext });
});
