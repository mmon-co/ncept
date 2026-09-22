import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

/** Bundling for the browser polyfills Node built-ins instead of failing, so the resolved
 * specifiers are the evidence, not the build's success. Entries resolve from Core's own
 * package directory, so `@concept/core/patch` is the published export rather than a guessed
 * file. */
const CORE_PACKAGE = fileURLToPath(new URL("../../", import.meta.url));

async function nodeBuiltinsOf(entry: string): Promise<readonly string[]> {
  const builtins: string[] = [];
  const bundle = await Bun.build({
    entrypoints: [Bun.resolveSync(entry, CORE_PACKAGE)],
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
  expect(bundle.success).toBe(true);
  return [...new Set(builtins)].sort();
}

test("pure Patch entry bundles without Node storage", async () => {
  expect(await nodeBuiltinsOf("@concept/core/patch")).toEqual([]);
  expect(await nodeBuiltinsOf("./src/patch/release.ts")).toEqual([]);
});
