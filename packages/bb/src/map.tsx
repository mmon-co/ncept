import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Handle,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./map.css";
import { edgeCurve, taperPath } from "@concept/design/graph";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useRpcQuery,
  useBbNavigate,
  useComposer,
  useComposers,
  useSdk,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./contract";
import { stateName } from "./reading";
import { Button } from "./ui/button";

const RADIUS = 14;
type Point = { x: number; y: number };
type Mark = Node<{ label: string; state: string; out: boolean; sel: boolean }, "mark">;
type Trail = Edge<{ from: Point; to: Point; kind: "gate" | "known" | "dash"; out: boolean }, "trail">;
type Selection = { kind: "node"; id: string } | { kind: "edge"; from: string; to: string };

function MarkNode({ data }: NodeProps<Mark>) {
  return (
    <div className={"ncept-mark" + (data.out ? " out" : "") + (data.sel ? " sel" : "")} data-state={data.state}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Top} isConnectable={false} />
      <i className="ncept-tok" />
      <div className="ncept-lab">
        <span>{data.label}</span>
        <small>{data.state}</small>
      </div>
    </div>
  );
}

function TrailEdge({ data, selected }: EdgeProps<Trail>) {
  const curve = data && edgeCurve(data.from, data.to, RADIUS);
  if (!data || !curve) return null;
  const start = curve.at(curve.start);
  const end = curve.at(curve.end);
  const line = `M${start.x},${start.y} Q${curve.control.x},${curve.control.y} ${end.x},${end.y}`;
  return (
    <g className={"ncept-edge " + data.kind + (data.out ? " out" : "") + (selected ? " sel" : "")}>
      {data.kind === "dash" ? (
        <path className="dash" d={line} />
      ) : (
        <path className="fill" d={taperPath(data.from, data.to, RADIUS)} />
      )}
      <path className="react-flow__edge-interaction" d={line} fill="none" strokeOpacity={0} strokeWidth={18} />
    </g>
  );
}
const nodeTypes = { mark: MarkNode };
const edgeTypes = { trail: TrailEdge };

/** Refits when the map's box changes: the docked composer and bb's panels settle after the first fit. */
function Refit({ padding }: { padding: number }) {
  const flow = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  useEffect(() => {
    void flow.fitView({ padding, maxZoom: 1.25 });
  }, [flow, padding, width, height]);
  return null;
}

function Zoom() {
  const flow = useReactFlow();
  const button = "px-2.5 py-1 hover:bg-state-hover";
  return (
    <div className="inline-flex rounded-md border border-border bg-background text-xs divide-x divide-border">
      <button aria-label="Zoom out" className={button} onClick={() => void flow.zoomOut()}>
        −
      </button>
      <button aria-label="Zoom in" className={button} onClick={() => void flow.zoomIn()}>
        +
      </button>
      <button className={button} onClick={() => void flow.fitView({ padding: 0.2, maxZoom: 1.25 })}>
        Fit
      </button>
    </div>
  );
}

/** bb's new-thread composer under the map, on the Profile's project. Its own component with a stable `onSubmit`:
 * the map re-renders whenever a composer registers. */
const Dock = memo(function Dock({ projectId }: { projectId: string }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const submit = useCallback(
    async (request: NewThreadRequest) => navigate.toThread((await sdk.threads.spawn(request)).id),
    [sdk, navigate],
  );
  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-4">
      <NewThreadComposer
        defaultProjectId={projectId}
        defaultProviderId="pi"
        layout="document"
        placeholder="Ask about your map, or start something. @ mentions a Node"
        onSubmit={submit}
      />
    </div>
  );
});

/** Whether bb is drawn dark; React Flow otherwise marks its root `light`, which resets bb's tokens inside it. */
function useDark() {
  return useSyncExternalStore(
    (changed) => {
      const observer = new MutationObserver(changed);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      return () => observer.disconnect();
    },
    () => document.documentElement.classList.contains("dark"),
  );
}

/** The Profile's graph. A `session` (the thread tab) opens on that Session's Nodes and writes pills to the thread's
 * composer; `dock` (the Learn page) writes them to a new-thread composer under the map; `still` (a Mission page's
 * head) draws one Mission's cone, fitted, without pan, zoom or selection. */
export function LearnMap({
  projectId,
  mission,
  session,
  dock = false,
  still = false,
}: {
  projectId: string;
  mission?: string;
  session?: { nodes: readonly string[]; mission?: string };
  dock?: boolean;
  still?: boolean;
}) {
  const map = experimental_useRpcQuery({
    contract: rpcContract,
    method: "map",
    input: { projectId, ...(still && mission ? { missionId: mission } : {}) },
  });
  const navigate = useBbNavigate();
  const dark = useDark();
  const own = useComposer();
  const docked = useComposers();
  const [scope, setScope] = useState(session ? "session" : (mission ?? "all"));
  const [selected, setSelected] = useState<Selection>();
  const [added, setAdded] = useState<string>();
  const data = map.data;
  const drawn = useMemo(() => {
    const none: { nodes: Mark[]; edges: Trail[] } = { nodes: [], edges: [] };
    if (!data) return none;
    const coneOf = (id: string | undefined) => data.missions.find((item) => item.id === id)?.cone;
    const cone = scope === "all" ? undefined : scope === "session" ? coneOf(session?.mission) : coneOf(scope);
    const shown = new Set(cone ? [...cone, ...(session?.nodes ?? [])] : data.nodes.map((node) => node.id));
    const lit = scope === "session" && session ? new Set(session.nodes) : shown;
    const byId = new Map(data.nodes.map((node) => [node.id, node]));
    return {
      nodes: data.nodes
        .filter((node) => shown.has(node.id))
        .map<Mark>((node) => ({
          id: node.id,
          type: "mark",
          position: { x: node.x, y: node.y },
          data: {
            label: node.label,
            state: stateName(node),
            out: !lit.has(node.id),
            sel: selected?.kind === "node" && selected.id === node.id,
          },
        })),
      edges: data.edges.flatMap<Trail>((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to || !shown.has(from.id) || !shown.has(to.id)) return [];
        return [
          {
            id: edge.from + ">" + edge.to,
            type: "trail",
            source: edge.from,
            target: edge.to,
            selected: selected?.kind === "edge" && selected.from === edge.from && selected.to === edge.to,
            data: {
              from: { x: from.x, y: from.y },
              to: { x: to.x, y: to.y },
              kind: to.frontier ? "gate" : to.status === "open" ? "dash" : "known",
              out: !lit.has(from.id) || !lit.has(to.id),
            },
          },
        ];
      }),
    };
  }, [data, scope, selected, session]);
  if (!data)
    return (
      <div role={map.error ? "alert" : undefined} className="p-6 text-sm text-muted-foreground">
        {map.error?.message ?? "Loading map…"}
      </div>
    );
  if (!data.nodes.length) return <div className="p-6 text-sm text-muted-foreground">No Nodes yet.</div>;

  const label = (id: string) => data.nodes.find((node) => node.id === id)?.label ?? id;
  function add(kind: string, ids: readonly string[], name: string) {
    // The Learn page's composer is the one docked under the map; beside a thread it is that thread's.
    const composer = dock ? (docked.at(-1) ?? own) : own;
    composer.insert([{ provider: "map", id: [projectId, kind, ...ids].join("~"), label: name }, " "], { at: "end" });
    setAdded([kind, ...ids].join("~"));
  }
  const node = selected?.kind === "node" ? data.nodes.find((item) => item.id === selected.id) : undefined;
  const scoped = data.missions.find((item) => item.id === scope);
  const names = (ids: readonly string[]) =>
    ids.length ? (
      ids.map((id) => <span key={id}>{label(id)}</span>)
    ) : (
      <span className="text-muted-foreground">nothing</span>
    );
  const addButton = (kind: string, ids: readonly string[], name: string) => (
    <Button className="self-start" onClick={() => add(kind, ids, name)}>
      {added === [kind, ...ids].join("~") ? "Added ✓" : "Add to chat"}
    </Button>
  );
  return (
    <div
      className={
        "ncept-map relative flex h-full w-full flex-col bg-background text-foreground" + (still ? " still" : "")
      }
    >
      <div className="relative min-h-0 flex-1">
        <ReactFlow
          key={scope}
          colorMode={dark ? "dark" : "light"}
          nodes={drawn.nodes}
          edges={drawn.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodeOrigin={[0.5, 0.5]}
          fitView
          fitViewOptions={{ padding: still ? 0.3 : 0.25, maxZoom: 1.25 }}
          minZoom={0.1}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={!still}
          edgesFocusable={!still}
          elementsSelectable={!still}
          panOnDrag={!still}
          zoomOnScroll={!still}
          zoomOnPinch={!still}
          zoomOnDoubleClick={!still}
          preventScrolling={!still}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, item) => !still && setSelected({ kind: "node", id: item.id })}
          onEdgeClick={(_, item) => !still && setSelected({ kind: "edge", from: item.source, to: item.target })}
          onPaneClick={() => setSelected(undefined)}
        >
          <Refit padding={still ? 0.3 : 0.25} />
          {!still && (
            <Panel position="top-left" className="flex flex-col items-start gap-2">
              <div className="flex items-center gap-2">
                <select
                  aria-label="Scope"
                  className="max-w-56 rounded-md border border-border bg-background px-2 py-1 text-xs"
                  value={scope}
                  onChange={(event) => {
                    setScope(event.target.value);
                    setSelected(undefined);
                  }}
                >
                  {session && <option value="session">This Session</option>}
                  <option value="all">All Missions</option>
                  {data.missions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.statement}
                    </option>
                  ))}
                </select>
                {scoped && (
                  <Button
                    variant="outline"
                    className="h-7"
                    onClick={() => add("mission", [scoped.id], scoped.statement)}
                  >
                    {added === "mission~" + scoped.id ? "Added ✓" : "Add Mission to chat"}
                  </Button>
                )}
              </div>
              <Zoom />
            </Panel>
          )}
        </ReactFlow>
        {still && (
          <button
            className="absolute bottom-2 right-3 text-xs text-muted-foreground underline underline-offset-2"
            onClick={() => navigate.toPluginPanel("learn", { subPath: "map/" + encodeURIComponent(mission ?? "") })}
          >
            Open in Map →
          </button>
        )}
        {node && (
          <aside className="absolute right-3 top-3 flex w-60 flex-col gap-2 rounded-lg border border-border bg-background p-3 text-xs">
            <div className="text-sm font-semibold">{node.label}</div>
            <div className="line-clamp-2 text-muted-foreground">
              {[
                stateName(node),
                ...data.missions.filter((item) => item.cone.includes(node.id)).map((item) => item.statement),
              ].join(" · ")}
            </div>
            <div className="flex flex-col">
              <b className="font-medium text-muted-foreground">Needs</b>
              {names(data.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from))}
            </div>
            <div className="flex flex-col">
              <b className="font-medium text-muted-foreground">Unlocks</b>
              {names(data.edges.filter((edge) => edge.from === node.id).map((edge) => edge.to))}
            </div>
            {addButton("node", [node.id], node.label)}
          </aside>
        )}
        {selected?.kind === "edge" && (
          <aside className="absolute right-3 top-3 flex w-60 flex-col gap-2 rounded-lg border border-border bg-background p-3 text-xs">
            <div className="text-sm font-semibold">
              {label(selected.from)} → {label(selected.to)}
            </div>
            <div className="text-muted-foreground">
              {label(selected.from)} is needed for {label(selected.to)}
            </div>
            {addButton("edge", [selected.from, selected.to], label(selected.from) + " → " + label(selected.to))}
          </aside>
        )}
      </div>
      {dock && <Dock projectId={projectId} />}
    </div>
  );
}
