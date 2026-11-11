// First-use entry point: invoke the official /hub command in a real, trusted pi session.
// No tutor/model call, account or package-registry resolution.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { initProject } from "../src/init";
import ncept from "../src/extension";

const address = process.argv[2];
if (!address) throw new Error("Usage: bun packages/pi/scripts/pull-hub.ts <public-release-url>");
const root = await mkdtemp(join(tmpdir(), "ncept-pi-pull-"));
try {
  const cwd = await initProject(join(root, "profile"));
  const agentDir = join(root, "agent");
  await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ sessionDir: "sessions" }));
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [ncept],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
  });
  const errors: string[] = [];
  try {
    await session.bindExtensions({ onError: (error) => errors.push(error.error) });
    await session.prompt("/hub pull " + address);
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("Official pi /hub pull completed: " + address);
  } finally {
    session.dispose();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
