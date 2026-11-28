const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const uuidId = new RegExp(`^(?:([a-z]+)-)?(${uuid})$`);
const shortSuffix = /(?:^|-)([0-9A-Za-z]{22})$/;

/** The 128-bit hex payload of a trailing short ID. Larger values are ordinary authored words. */
function shortPayload(segment: string): { hex: string; index: number } | undefined {
  const suffix = shortSuffix.exec(segment);
  if (!suffix?.[1]) return;
  let value = 0n;
  for (const digit of suffix[1]) value = value * 62n + BigInt(alphabet.indexOf(digit));
  if (value >= 2n ** 128n) return;
  return { hex: value.toString(16).padStart(32, "0"), index: suffix.index };
}

/** Authored identities share the segment with generated IDs. Reserve the short-ID suffix at minting. */
export function hasShortIdSuffix(id: string): boolean {
  return shortPayload(id) !== undefined;
}

function shortId(hex: string): string {
  let value = BigInt(`0x${hex}`);
  let result = "";
  for (; value > 0n; value /= 62n) result = alphabet.charAt(Number(value % 62n)) + result;
  return result.padStart(22, "0");
}

/** A decorative, locale-independent title followed by a lossless UUID (or publisher key prefix). */
export function slugged(id: string, title?: string, kind?: string): string {
  const match = uuidId.exec(id);
  const payload =
    kind === "publisher"
      ? /^[0-9a-f]{32}(?:[0-9a-f]{32})?$/.test(id)
        ? id.slice(0, 32)
        : undefined
      : match && (kind === undefined || kind === (match[1] ?? ""))
        ? match[2]?.replaceAll("-", "")
        : undefined;
  if (!payload) return id;
  const words = (title ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
  const slug = Array.from(words).slice(0, 64).join("").replace(/-$/, "");
  return (slug ? slug + "-" : "") + shortId(payload);
}

export function parseResourceSegment(segment: string, kind = ""): { id: string; slug?: string } {
  const payload = shortPayload(segment);
  if (!payload) return { id: segment };
  const { hex, index } = payload;
  const id =
    kind === "publisher"
      ? hex
      : (kind ? kind + "-" : "") + hex.replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5");
  return { id, slug: segment.slice(0, index) };
}

/** Full legacy IDs and authored IDs pass through; the route supplies the omitted kind. */
export function idOf(segment: string, kind?: string): string {
  return parseResourceSegment(segment, kind).id;
}
