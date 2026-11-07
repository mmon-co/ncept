#!/usr/bin/env node
import { initProject } from "./init.js";

const [command, directory, ...extra] = process.argv.slice(2);
if (command !== "init" || !directory || extra.length) {
  console.error("Usage: npx @mmon-co/pi init <dir>");
  process.exitCode = 1;
} else {
  try {
    const dir = await initProject(directory);
    console.log(
      "Profile ready: " +
        dir +
        "\nRun: cd " +
        JSON.stringify(dir) +
        " && pi\nTrust this learning project when pi asks.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
