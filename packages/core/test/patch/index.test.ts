import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

/** Bundling for the browser polyfills Node built-ins instead of failing, so the resolved
 * specifiers are the evidence, not the build's success. Entries resolve from Core's own
 * package directory, so `@concept/core/patch` is the published export rather than a guessed
 * file; resolution and build run in their own process because `bun test` resolves a workspace
 * package's own files through its `exports` map. */
const CORE_PACKAGE = fileURLToPath(new URL("../../", import.meta.url));

const RECORD_NODE_BUILTINS = `
const builtins = [];
await Bun.build({
  entrypoints: [Bun.resolveSync(process.env.PATCH_ENTRY, process.env.CORE_PACKAGE)],
  target: "browser",
  plugins: [
    {
      name: "record-node-builtins",
      setup(build) {
        build.onResolve({ filter: /^node:/ }, ({ path }) => {
          builtins.push(path);
          return undefined;
        });
      },
    },
  ],
});
console.log(JSON.stringify([...new Set(builtins)].sort()));
`;

function nodeBuiltinsOf(entry: string): readonly string[] {
  const bundle = Bun.spawnSync([process.execPath, "-e", RECORD_NODE_BUILTINS], {
    env: { ...process.env, CORE_PACKAGE, PATCH_ENTRY: entry },
  });
  expect(bundle.stderr.toString()).toBe("");
  return JSON.parse(bundle.stdout.toString());
}

test("pure Patch entry bundles without Node storage", () => {
  expect(nodeBuiltinsOf("@concept/core/patch")).toEqual([]);
  expect(nodeBuiltinsOf("./src/patch/release.ts")).toEqual([]);
});
