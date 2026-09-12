import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** Pure sha256 hex so Core's digests run in Convex functions and browsers, not only Node. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** Shared content identity for JSON values. Owners choose which data is content. */
export type ContentDigest = `sha256:${string}`;

/** SHA-256 of raw bytes, not JSON; text attachments supply their UTF-8 encoding. */
export function attachmentDigest(bytes: Uint8Array): ContentDigest {
  return `sha256:${bytesToHex(sha256(bytes))}`;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical content cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value, canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("canonical content must contain plain JSON objects");
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
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
