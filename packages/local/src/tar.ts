/** A deliberately small, portable ustar codec: regular files only, no links or filesystem access. */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const block = 512;
export type ProfileFiles = ReadonlyMap<string, Uint8Array>;

function field(header: Uint8Array, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}
function number(header: Uint8Array, start: number, length: number): number {
  const value = field(header, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar number");
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) throw new Error("Tar number exceeds safe size");
  return result;
}
function checksum(header: Uint8Array): number {
  return header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
}
function safePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsafe tar path: " + path);
}
function put(header: Uint8Array, start: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error("Tar field too long: " + value);
  header.set(bytes, start);
}
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}
export function encodeTar(files: ProfileFiles): Uint8Array {
  let size = block * 2;
  for (const bytes of files.values()) size += block + Math.ceil(bytes.length / block) * block;
  const output = new Uint8Array(size);
  let offset = 0;
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    safePath(path);
    const header = output.subarray(offset, offset + block);
    put(header, 0, 100, path);
    put(header, 100, 8, octal(0o644, 8));
    put(header, 108, 8, octal(0, 8));
    put(header, 116, 8, octal(0, 8));
    put(header, 124, 12, octal(bytes.length, 12));
    put(header, 136, 12, octal(0, 12));
    header[156] = 48;
    put(header, 257, 6, "ustar\0");
    put(header, 263, 2, "00");
    put(header, 148, 8, checksum(header).toString(8).padStart(6, "0") + "\0 ");
    output.set(bytes, offset + block);
    offset += block + Math.ceil(bytes.length / block) * block;
  }
  return output;
}
export function decodeTar(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length % block !== 0) throw new Error("Truncated tar archive");
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + block <= bytes.length) {
    const header = bytes.subarray(offset, offset + block);
    if (header.every((byte) => byte === 0)) {
      if (offset + block * 2 > bytes.length || bytes.subarray(offset).some((byte) => byte !== 0))
        throw new Error("Invalid tar end marker");
      return files;
    }
    if (number(header, 148, 8) !== checksum(header)) throw new Error("Tar checksum mismatch");
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    const path = prefix ? prefix + "/" + name : name;
    const size = number(header, 124, 12);
    const type = header[156];
    const end = offset + block + Math.ceil(size / block) * block;
    if (end > bytes.length) throw new Error("Truncated tar file: " + path);
    // Directory records from standard tar writers are harmless, but never extract links or extensions.
    if (type === 53 && size === 0) safePath(path.replace(/\/$/, ""));
    else {
      if (type !== 0 && type !== 48) throw new Error("Unsupported tar entry type: " + path);
      safePath(path);
      if (files.has(path)) throw new Error("Duplicate tar path: " + path);
      files.set(path, bytes.slice(offset + block, offset + block + size));
    }
    offset = end;
  }
  throw new Error("Missing tar end marker");
}
