import { sweepDisposableProjects } from "./disposable-projects";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: mise run bb:sweep-disposable [--dry-run]");
await sweepDisposableProjects({ dryRun: args.includes("--dry-run") });
