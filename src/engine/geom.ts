// Minimal 4x4 rigid-transform math for the dock/placement solver. Column-vector convention:
// a point p in local space maps to world as p_world = M * p_local; compose parent*child.
// Euler angles are in DEGREES; P'X5 stores <rot x y z> — rotation order is calibrated in solve.ts.
export type Mat4 = number[]; // length 16, row-major (m[row*4+col])
export type Vec3 = [number, number, number];

const D2R = Math.PI / 180;

export const ident = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return o;
}
export const mulAll = (...ms: Mat4[]): Mat4 => ms.reduce(mul, ident());

export function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
}
export function rotX(deg: number): Mat4 { const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]; }
export function rotY(deg: number): Mat4 { const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]; }
export function rotZ(deg: number): Mat4 { const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }

// Euler -> matrix for a given axis order, e.g. "XYZ" means R = Rx*Ry*Rz (intrinsic x then y then z).
export function euler(x: number, y: number, z: number, order = "XYZ"): Mat4 {
  const R: Record<string, Mat4> = { X: rotX(x), Y: rotY(y), Z: rotZ(z) };
  return mulAll(...order.split("").map((a) => R[a]));
}
// Rigid transform = translate(t) * euler(rot).
export const trs = (t: Vec3, rot: Vec3, order = "XYZ"): Mat4 => mul(translation(t[0], t[1], t[2]), euler(rot[0], rot[1], rot[2], order));

export const getTranslation = (m: Mat4): Vec3 => [m[3], m[7], m[11]];

// Invert a rigid transform (rotation R + translation t): inv = [R^T | -R^T t].
export function invRigid(m: Mat4): Mat4 {
  const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]; // R row-major 3x3
  const t: Vec3 = [m[3], m[7], m[11]];
  const rt = [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]]; // R^T
  const nt: Vec3 = [-(rt[0] * t[0] + rt[1] * t[1] + rt[2] * t[2]), -(rt[3] * t[0] + rt[4] * t[1] + rt[5] * t[2]), -(rt[6] * t[0] + rt[7] * t[1] + rt[8] * t[2])];
  return [rt[0], rt[1], rt[2], nt[0], rt[3], rt[4], rt[5], nt[1], rt[6], rt[7], rt[8], nt[2], 0, 0, 0, 1];
}

// Quaternion (x,y,z,w) from the rotation part of a matrix — used for orientation comparison.
export function matToQuat(m: Mat4): [number, number, number, number] {
  const [m00, m01, m02, , m10, m11, m12, , m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}
// Angle (degrees) between two orientations given as quaternions.
export function quatAngleDeg(a: [number, number, number, number], b: [number, number, number, number]): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d)) / D2R;
}
export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
