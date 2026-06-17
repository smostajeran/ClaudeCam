// Read a .pxpz (P'X5 project = a ZIP archive) without any dependency: parse the central directory
// and inflate the wanted entry with node:zlib. Used server-side so the engine can ingest an uploaded
// project and the app never has to parse the proprietary format itself.
import { inflateRawSync, gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

export function extractFromZip(buf: Buffer, match: (name: string) => boolean): { name: string; data: Buffer } | null {
  // End of Central Directory record (scan backwards; signature 0x06054b50)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // central directory offset
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break; // central dir file header
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (match(name)) {
      const lhNameLen = buf.readUInt16LE(localOff + 26);
      const lhExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      const data = method === 8 ? inflateRawSync(comp) : Buffer.from(comp);
      return { name, data };
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// .pxpz stores each project file gzip-compressed inside the ZIP (e.g. .../5/config.px5.gz),
// so ZIP-extract the entry then gunzip the gzip stream.
export function extractConfigPx5(buf: Buffer): { name: string; data: Buffer } | null {
  const r = extractFromZip(buf, (n) => n.endsWith("config.px5.gz") || n.endsWith("config.px5"));
  if (!r) return null;
  const data = r.name.endsWith(".gz") ? gunzipSync(r.data) : r.data;
  return { name: r.name.replace(/\.gz$/, ""), data };
}

// CLI: list config.px5 inside a .pxpz and its size
if (process.argv[1]?.endsWith("pxpz.ts")) {
  const f = process.argv[2]; if (!f) { console.log("usage: node src/engine/pxpz.ts <file.pxpz>"); process.exit(0); }
  const r = extractConfigPx5(readFileSync(f));
  console.log(r ? `extracted ${r.name}: ${r.data.length} bytes; componentsets=${(r.data.toString("utf8").match(/<componentset/g) || []).length}` : "no config.px5 found in archive");
}
