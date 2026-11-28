import { describe, expect, test } from "bun:test";
import { hasShortIdSuffix, idOf, slugged } from "../src/resource-url";

const uuid = "54b8fc86-dd1d-4903-a68a-eb13b983540d";
const patch = `patch-${uuid}`;

describe("resource URLs", () => {
  test("decode the whole UUID regardless of the decorative title", () => {
    for (const id of [uuid, "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
      for (const kind of ["", "patch", "session", "surface", "mission", "view", "material"]) {
        const canonical = kind ? `${kind}-${id}` : id;
        const short = slugged(canonical, "  🧪!  ");
        expect(short).toMatch(/^[A-Za-z0-9]{22}$/);
        expect(slugged(canonical, "你好，世界 3!")).toBe(`你好-世界-3-${short}`);
        expect(idOf(short, kind)).toBe(canonical);
        expect(idOf(`wrong-title-${short}`, kind)).toBe(canonical);
        expect(idOf(canonical, kind)).toBe(canonical);
      }
    }
  });

  test("preserve authored IDs and reserve the short token at minting", () => {
    const authored = "mission-mmon-getting-started";
    expect(slugged(authored, "another name")).toBe(authored);
    expect(idOf(authored, "mission")).toBe(authored);
    expect(slugged(`notes-${uuid}`, "Document", "material")).toBe(`notes-${uuid}`);
    expect(slugged("e".repeat(32), "Document", "material")).toBe("e".repeat(32));
    expect(hasShortIdSuffix(authored)).toBe(false);
    expect(hasShortIdSuffix(`mission-${slugged(patch)}`)).toBe(true);
  });

  test("publisher links represent exactly the 128-bit prefix", () => {
    const key = "00000000000000000000000000000001" + "2".repeat(32);
    const short = slugged(key, "mmon Co.", "publisher");
    expect(short).toBe("mmon-co-0000000000000000000001");
    expect(idOf(short, "publisher")).toBe(key.slice(0, 32));
    expect(idOf(key, "publisher")).toBe(key);
  });
});
