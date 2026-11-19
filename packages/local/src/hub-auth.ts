import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { credentialsPath } from "./directory.js";
import type { HubOptions } from "./host.js";

const scopes = "patches publish learn";
const defaultHub = "https://co.mmon.co/ncept";

export function hubBaseUrl(value = defaultHub): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Hub URL must use HTTPS (or loopback HTTP)");
  return url.href.replace(/\/$/, "");
}

export async function hasHubCredentials(options: HubOptions): Promise<boolean> {
  return Boolean((await HubAuth.open(hubBaseUrl(options.url) + "/mcp", options)).tokens());
}

export async function beginHubBrowserSignIn(options: HubOptions): Promise<HubBrowserSignIn> {
  return (await HubAuth.open(hubBaseUrl(options.url) + "/mcp", options)).beginBrowserSignIn();
}

export class HubSignInRequired extends Error {
  constructor() {
    super("Sign in to Common Concept first");
  }
}

export interface HubBrowserSignIn {
  readonly url: string;
  readonly expiresAt: number;
  /** True once consent has been exchanged for locally stored Hub credentials. */
  poll(): Promise<boolean>;
}
interface Credentials {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  redirect?: string;
  discovery?: OAuthDiscoveryState;
}
interface StoredCredentials {
  readonly [resource: string]: Credentials;
}
async function load(path: string): Promise<StoredCredentials> {
  try {
    const stored: StoredCredentials = JSON.parse(await readFile(path, "utf8"));
    return stored;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}
async function browser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, (error) =>
      error ? reject(new Error("Cannot open the sign-in browser; supply hub.openUrl")) : resolve(),
    );
  });
}

/** SDK owns discovery, issuer/resource binding, dynamic registration, PKCE and refresh. */
export class HubAuth implements OAuthClientProvider {
  private credentials: Credentials = {};
  private verifier?: string;
  private authorize?: (url: URL) => Promise<void>;
  private nonce = "";
  private transient = false;
  private constructor(
    readonly resource: string,
    private readonly path: string,
    private readonly openUrl: (url: string) => Promise<void>,
    readonly clientMetadataUrl?: string,
  ) {}
  static async open(resource: string, options: HubOptions): Promise<HubAuth> {
    const provider = new HubAuth(
      resource,
      options.credentialsFile ?? credentialsPath(),
      options.openUrl ?? browser,
      options.clientMetadataUrl,
    );
    provider.credentials = (await load(provider.path))[resource] ?? {};
    return provider;
  }
  get redirectUrl() {
    return this.credentials.redirect;
  }
  get clientMetadata() {
    return {
      client_name: "Common Concept local",
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: scopes,
    };
  }
  state() {
    return this.nonce;
  }
  clientInformation() {
    return this.credentials.client;
  }
  async saveClientInformation(client: OAuthClientInformationMixed) {
    await this.save({ client });
  }
  tokens() {
    return this.credentials.tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    // Some issuers rotate refresh tokens; others omit one on refresh.
    await this.save({
      tokens: {
        ...tokens,
        refresh_token:
          tokens.refresh_token ??
          (tokens.issuer === this.credentials.tokens?.issuer ? this.credentials.tokens?.refresh_token : undefined),
      },
    });
  }
  discoveryState() {
    return this.credentials.discovery;
  }
  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    await this.save({ discovery });
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error("No sign-in is in progress");
    return this.verifier;
  }
  async redirectToAuthorization(url: URL) {
    if (!this.authorize) throw new UnauthorizedError("Sign in to Common Concept first");
    await this.authorize(url);
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all") this.credentials = {};
    else if (scope !== "verifier") delete this.credentials[scope];
    await this.save({});
  }
  private async save(change: Partial<Credentials>) {
    this.credentials = { ...this.credentials, ...change };
    if (this.transient) return;
    const all = { ...(await load(this.path)), [this.resource]: this.credentials };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(all) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
  }
  /** The browser can be on another machine. Keep the PKCE verifier and claim secret in this process. */
  async beginBrowserSignIn(): Promise<HubBrowserSignIn> {
    const path = this.resource.replace(/\/mcp$/, "/bb-sign-in");
    const attempt = new HubAuth(this.resource, this.path, this.openUrl);
    attempt.transient = true;
    const state = (attempt.nonce = randomBytes(32).toString("base64url"));
    const secret = randomBytes(32).toString("base64url");
    const claimHash = createHash("sha256").update(secret).digest("hex");
    const send = (body: { secret: string } | { claimHash: string }) =>
      fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, ...body }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    const startedAt = Date.now();
    const started = await send({ claimHash });
    if (!started.ok) throw new Error("Common Concept sign-in is unavailable");
    const config: unknown = await started.json();
    if (
      !config ||
      typeof config !== "object" ||
      !("clientId" in config) ||
      typeof config.clientId !== "string" ||
      !("redirect" in config) ||
      config.redirect !== path ||
      !path.startsWith("https://") ||
      !("expiresIn" in config) ||
      typeof config.expiresIn !== "number"
    )
      throw new Error("Invalid Common Concept sign-in configuration");
    attempt.credentials = { client: { client_id: config.clientId }, redirect: config.redirect };
    let url: string | undefined;
    attempt.authorize = async (authorization) => {
      url = authorization.href;
    };
    const settings = {
      serverUrl: this.resource,
      resourceMetadataUrl: new URL(this.resource.replace(/\/mcp$/, "/.well-known/oauth-protected-resource")),
      scope: scopes + " offline_access",
      fetchFn: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    };
    await auth(attempt, settings);
    if (!url) throw new Error("Common Concept did not open sign-in");
    const expiresAt = startedAt + config.expiresIn;
    return {
      url,
      expiresAt,
      poll: async () => {
        const response = await send({ secret });
        if (response.status === 410) throw new Error("Sign-in expired. Try again.");
        if (!response.ok) throw new Error("Common Concept sign-in is unavailable");
        const result: unknown = await response.json();
        if (!result || typeof result !== "object") throw new Error("Invalid Common Concept sign-in response");
        if (!("code" in result)) return false;
        if (typeof result.code !== "string") throw new Error("Sign-in declined");
        await auth(attempt, { ...settings, authorizationCode: result.code });
        attempt.transient = false;
        await attempt.save({});
        return true;
      },
    };
  }

  async signIn(): Promise<void> {
    this.nonce = randomBytes(32).toString("base64url");
    let accept!: (code: string) => void;
    let refuse!: (reason: Error) => void;
    const callback = new Promise<string>((resolve, reject) => {
      accept = resolve;
      refuse = reject;
    });
    // The callback can arrive while discovery/openUrl is still pending.
    void callback.catch(() => {});
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== this.nonce) {
        response.writeHead(400).end("Invalid sign-in callback");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      response
        .writeHead(code && !error ? 200 : 400, { "Content-Type": "text/plain", "Cache-Control": "no-store" })
        .end(code && !error ? "Signed in. You can close this window." : "Sign-in was refused.");
      if (code && !error) accept(code);
      else refuse(new Error("Sign-in refused: " + (error ?? "missing authorization code")));
    });
    const timeout = setTimeout(() => refuse(new Error("Sign-in timed out after five minutes")), 5 * 60_000);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Cannot start sign-in callback");
      const redirect = "http://127.0.0.1:" + address.port + "/callback";
      // A fresh ephemeral callback must be registered, not silently reuse another redirect URI.
      await this.save({ redirect, client: undefined, tokens: undefined });
      this.authorize = (url) => this.openUrl(url.href);
      const metadata = new URL(this.resource.replace(/\/mcp$/, "/.well-known/oauth-protected-resource"));
      const result = await auth(this, { serverUrl: this.resource, resourceMetadataUrl: metadata, scope: scopes });
      if (result === "REDIRECT")
        await auth(this, { serverUrl: this.resource, authorizationCode: await callback, scope: scopes });
    } finally {
      clearTimeout(timeout);
      this.authorize = undefined;
      this.verifier = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
