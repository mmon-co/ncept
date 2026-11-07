import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initProject } from "../src/init";

// Unpublished-package encounter: same Profile as init, loaded from this checkout.
// No deployment, account, seed, or model request is required to open the surface.
const dir = process.argv[2];
if (!dir) throw new Error("Usage: bun packages/pi/scripts/first-use.ts <unused-profile-directory>");
const profile = await initProject(dir);
await writeFile(
  join(profile, ".pi/settings.json"),
  JSON.stringify(
    {
      packages: [resolve(import.meta.dir, "..")],
      sessionDir: "sessions",
    },
    null,
    2,
  ) + "\n",
);
console.log("cd " + JSON.stringify(profile) + " && pi");
