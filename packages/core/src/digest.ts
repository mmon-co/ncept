import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** Pure sha256 hex so Core's digests run in Convex functions and browsers, not only Node. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** Shared by Patch content, Pedagogy releases and observation identities; each hashes its own
 * serialization, so a digest is comparable only against the same kind of content. */
export type ContentDigest = `sha256:${string}`;

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical content cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical content cannot contain ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function contentDigest(value: unknown): ContentDigest {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function isContentDigest(value: unknown): value is ContentDigest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
