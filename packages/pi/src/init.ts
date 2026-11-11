import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { init } from "@mmon-co/ncept-local";
import { tutorSystemPrompt } from "@mmon-co/ncept-default-theory";

/** Create a learning project without changing the user's pi agent directory. */
export async function initProject(directory: string): Promise<string> {
  const dir = resolve(directory);
  await init(dir);
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(
    join(dir, ".pi/settings.json"),
    JSON.stringify({ packages: ["npm:@mmon-co/ncept-pi"], sessionDir: "sessions" }, null, 2) + "\n",
    { flag: "wx" },
  );
  await writeFile(join(dir, ".pi/SYSTEM.md"), tutorSystemPrompt("empty") + "\n", { flag: "wx" });
  return dir;
}
