// Runs inside an npm consumer, using the harness's own resolved dependency tree.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [harness, version] = process.argv.slice(2);
const directory = resolve("node_modules/@mmon-co/ncept-" + harness);
const manifest = await Bun.file(resolve(directory, "package.json")).json();
assert.equal(manifest.version, version);
const load = createRequire(resolve(directory, "package.json"));
const dependency = (name) => import(pathToFileURL(load.resolve("@mmon-co/ncept-" + name)).href);
// npm's lock records the actual transitive versions, including nested copies.
const lock = await Bun.file("package-lock.json").json();
console.log(
  manifest.name +
    "@" +
    version +
    " installed " +
    Object.entries(lock.packages)
      .filter(([path]) => path.includes("@mmon-co/ncept-"))
      .map(([path, { version }]) => path + "@" + version)
      .join(", "),
);
const { composePatch, emptyPatch } = await dependency("core");
const { defaultTheory } = await dependency("default-theory");
const { openProfile } = await dependency("local");
const { initProject } = await dependency("pi");
const cwd = await initProject("profile");
const profile = await openProfile(cwd, [defaultTheory]);
const node = "node-addition";
const label = "Add integers";
const provenance = await profile.addRevision(
  "patch-personal",
  composePatch(emptyPatch(), [
    { kind: "add-node", node: { id: node } },
    {
      kind: "add-metadata-set",
      metadataSet: {
        id: "metadata-addition",
        subjects: [{ kind: "node", id: node }],
        properties: {
          "display:label": label,
          "pedagogy:criterion": "Add two integers unaided.",
          "pedagogy:completion": { count: 1, of: { field: "node", is: "self" } },
        },
      },
    },
  ]),
);
await profile.setPersonal(provenance);

if (harness === "pi") {
  // Seed the Mission without starting the learning host; the installed
  // extension should be the first reader of the completion query.
  const statement = "Learn integer addition";
  await profile.appendLog([
    {
      kind: "mission.revised",
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      mission: { id: "addition", statement, priority: 1, targets: [{ node, provenance }] },
    },
  ]);
  const entry = await import(pathToFileURL(resolve(directory, manifest.pi.extensions[0])).href);
  let start;
  entry.default({
    events: { on() {} },
    on(event, handler) {
      if (event === "session_start") start = handler;
    },
    registerCommand() {},
  });
  let widget;
  await start(
    { type: "session_start" },
    {
      cwd,
      isProjectTrusted: () => true,
      ui: {
        setWidget(_id, lines) {
          widget = lines;
        },
      },
    },
  );
  assert(
    widget.some((line) => line.includes(statement)),
    "The dashboard should read the seeded Mission",
  );
} else {
  const entry = await import(pathToFileURL(resolve(directory, manifest.bb.host)).href);
  const map = await entry.default.handlers.map({ directory: cwd });
  const reading = map.nodes.find(({ id }) => id === node);
  assert.equal(reading?.label, label);
  assert.equal(reading.status, "open");
}
console.log(`${manifest.name}@${version}: seeded completion read passed`);
