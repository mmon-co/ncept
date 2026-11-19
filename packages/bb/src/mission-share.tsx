import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./contract";
import { Button } from "./ui/button";

export function MissionShare({
  projectId,
  missionId,
  title,
  setTitle,
}: {
  projectId: string;
  missionId: string;
  title: string;
  setTitle: (title: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [signedIn, setSignedIn] = useState<boolean>();
  const [signInUrl, setSignInUrl] = useState<string>();
  const [phase, setPhase] = useState<"sign-in" | "publish">();
  const [shared, setShared] = useState<string>();
  const [error, setError] = useState<string>();
  const active = useRef<symbol | null>(null);

  useEffect(() => {
    let disposed = false;
    void rpc.call("shareSignedIn", { projectId }).then(
      (ready) => {
        if (!disposed) setSignedIn(ready);
      },
      (error: unknown) => {
        if (!disposed) setError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      disposed = true;
      active.current = null;
    };
  }, [projectId]);

  function cancelSignIn() {
    active.current = null;
    setPhase(undefined);
    setSignInUrl(undefined);
  }

  async function share() {
    const name = title.trim();
    if (!name || signedIn === undefined || active.current) return;
    const run = Symbol();
    active.current = run;
    const cancelled = () => active.current !== run;
    setError(undefined);
    let tab: Window | null = null;
    let opened = false;
    try {
      if (!signedIn) {
        // Reserve the tab on the click, before the Profile's RPC can outlast browser activation.
        tab = window.open("", "_blank");
        if (tab) tab.opener = null;
        setPhase("sign-in");
        const { attempt, url } = await rpc.call("shareSignIn", { projectId });
        if (cancelled()) return;
        setSignInUrl(url);
        if (tab && !tab.closed) {
          tab.location.replace(url);
          opened = true;
        } else navigate.openUrl(url);
        while (!cancelled()) {
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          if (!cancelled() && (await rpc.call("pollShareSignIn", { projectId, attempt }))) break;
        }
        if (cancelled()) return;
        setSignedIn(true);
      }
      setSignInUrl(undefined);
      setPhase("publish");
      const result = await rpc.call("share", { projectId, missionId, title: name });
      if (cancelled()) return;
      if ("url" in result) setShared(result.url);
      else setSignedIn(false);
    } catch (error) {
      if (!cancelled()) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!opened) tab?.close();
      if (!cancelled()) cancelSignIn();
    }
  }

  if (shared)
    return (
      <div className="p-2 space-y-3">
        <p className="text-sm">Anyone with this link can read the map and learn from it.</p>
        <input
          readOnly
          aria-label="Link"
          value={shared}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full rounded-md border border-input bg-background p-3 text-sm"
        />
        <Button type="button" onClick={() => void navigator.clipboard.writeText(shared)}>
          Copy link
        </Button>
      </div>
    );

  return (
    <form
      aria-label="Share Mission"
      className="p-2 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void share();
      }}
    >
      <label className="block text-sm" htmlFor="share-title">
        Title
      </label>
      <input
        id="share-title"
        autoFocus
        value={title}
        readOnly={phase !== undefined}
        onChange={(event) => setTitle(event.target.value)}
        className="w-full rounded-md border border-input bg-background p-3 text-sm"
      />
      {phase === "sign-in" ? (
        <>
          <p role="status" className="text-sm">
            Waiting for you to sign in to Common Concept.
          </p>
          <div className="flex gap-2 items-center">
            {signInUrl && (
              <a
                href={signInUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center rounded-md px-3 text-xs font-medium bg-foreground text-background hover:bg-foreground/90"
              >
                Open sign-in ↗
              </a>
            )}
            <Button type="button" variant="ghost" onClick={cancelSignIn}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <small className="block text-muted-foreground">
            Publishes this Mission’s map and Materials at an unlisted Hub link.
          </small>
          <Button disabled={!!phase || signedIn === undefined || !title.trim()} type="submit">
            {phase === "publish" ? "Sharing…" : signedIn === false ? "Sign in and share" : "Share"}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
