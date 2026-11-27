import { name } from "../package.json";

// bb takes the final component of the npm package name as the plugin's storage and RPC identity.
export const conceptPluginId = name.slice(name.lastIndexOf("/") + 1);
