// Convert engine placement (P'X5 frame: centimetres, Z-up, right-handed) to RealityKit
// (metres, Y-up, right-handed). The basis change is a single RotX(-90°) applied to every part —
// position remap (x, y, z)cm -> (x, z, -y)m and quaternion conjugation q' = qR · q · qR*.
// This replaces per-part hand-derived quaternions (the source of the glass-fitting orientation bug):
// one consistent world transform for ALL parts, plus a per-MESH authored-frame correction (constant
// per .usdc, applied on the app side — see IOS_INTEGRATION.md).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export type V3 = [number, number, number];
export type Q = [number, number, number, number]; // x, y, z, w

const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const QR: Q = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];  // RotX(-90°)
const QRc: Q = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];   // conjugate
const S = 0.01; // cm -> m

export const posToRK = (p: V3): V3 => [+(p[0] * S).toFixed(5), +(p[2] * S).toFixed(5), +(-p[1] * S).toFixed(5)];
export const quatToRK = (q: Q): Q => qmul(qmul(QR, q), QRc).map((x) => +x.toFixed(6)) as Q;

// Convert a whole placement.json object to RealityKit-ready transforms (keeps type/name/artNo/etc).
export function placementToRK(pl: any): any {
  const conv = (p: any) => ({
    ...p,
    pos: posToRK(p.pos), quat: quatToRK(p.quat),
    ...(p.quad ? { quad: p.quad.map((c: V3) => posToRK(c)) } : {}),
  });
  return { ...pl, units: "m", up: "Y", frame: "RealityKit", parts: (pl.parts ?? []).map(conv) };
}

// CLI: out/placement.json -> out/placement.ios.json
if (process.argv[1]?.endsWith("export_ios.ts")) {
  const f = "out/placement.json";
  if (!existsSync(f)) { console.log("no out/placement.json (run solve.ts first)"); process.exit(0); }
  const rk = placementToRK(JSON.parse(readFileSync(f, "utf8")));
  writeFileSync("out/placement.ios.json", JSON.stringify(rk, null, 1));
  const s = rk.parts.find((p: any) => p.type?.startsWith("glasscharnier_vorne_oben_l"));
  console.log(`wrote out/placement.ios.json (${rk.parts.length} parts, metres/Y-up)`);
  if (s) console.log(`  sample ${s.type}: pos=${JSON.stringify(s.pos)} quat=${JSON.stringify(s.quat)}`);
}
