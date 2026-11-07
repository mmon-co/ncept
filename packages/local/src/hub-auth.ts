import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { credentialsPath } from "./directory.js";
import type { HubOptions } from "./host.js";

const scopes = "patches publish learn";
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
  private constructor(
    readonly resource: string,
    private readonly path: string,
    private readonly openUrl: (url: string) => Promise<void>,
  ) {}
  static async open(resource: string, options: HubOptions): Promise<HubAuth> {
    const provider = new HubAuth(resource, options.credentialsFile ?? credentialsPath(), options.openUrl ?? browser);
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
    if (!this.authorize) throw new Error("Sign in first with host.hub.signIn()");
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
    const all = { ...(await load(this.path)), [this.resource]: this.credentials };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(all) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
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
