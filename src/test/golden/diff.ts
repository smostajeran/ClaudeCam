// Diff an engine snapshot against the P'X5 oracle snapshot (articles / placement / conflicts).
import type { Snapshot, PartSnap, Tol } from "./schema.ts";
import { DEFAULT_TOL } from "./schema.ts";

export function quatAngleDeg(a: number[], b: number[]): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]); // |dot|: handle q == -q
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}
export function posMaxMm(a: number[], b: number[]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

export interface PlacementDiff { id: string; issue?: string; typeExp?: string; typeAct?: string; posMm?: number; angleDeg?: number }
export interface DiffResult {
  pass: boolean;
  articlesMissing: string[];
  articlesExtra: string[];
  conflictsMissing: string[];
  conflictsExtra: string[];
  placement: PlacementDiff[];
}

export function diffSnapshots(exp: Snapshot, act: Snapshot, tol: Tol = DEFAULT_TOL): DiffResult {
  const aKey = (x: { number: string; qty: number }) => `${x.number} x${x.qty}`;
  const ea = new Set(exp.articles.map(aKey));
  const aa = new Set(act.articles.map(aKey));
  const articlesMissing = [...ea].filter((k) => !aa.has(k));
  const articlesExtra = [...aa].filter((k) => !ea.has(k));

  const cKey = (c: { type: string; parts: string[] }) => `${c.type}[${[...c.parts].sort().join(",")}]`;
  const ec = new Set(exp.conflicts.map(cKey));
  const ac = new Set(act.conflicts.map(cKey));
  const conflictsMissing = [...ec].filter((k) => !ac.has(k));
  const conflictsExtra = [...ac].filter((k) => !ec.has(k));

  const actById = new Map(act.parts.map((p) => [p.id, p]));
  const placement: PlacementDiff[] = [];
  for (const e of exp.parts) {
    const a = actById.get(e.id);
    if (!a) { placement.push({ id: e.id, issue: "missing-in-engine" }); continue; }
    const posMm = posMaxMm(e.pos, a.pos);
    const angleDeg = quatAngleDeg(e.quat, a.quat);
    if (e.type !== a.type || posMm > tol.posMm || angleDeg > tol.angleDeg) {
      placement.push({
        id: e.id,
        typeExp: e.type !== a.type ? e.type : undefined,
        typeAct: e.type !== a.type ? a.type : undefined,
        posMm: +posMm.toFixed(3),
        angleDeg: +angleDeg.toFixed(3),
      });
    }
  }

  const pass =
    !articlesMissing.length && !articlesExtra.length &&
    !conflictsMissing.length && !conflictsExtra.length && !placement.length;
  return { pass, articlesMissing, articlesExtra, conflictsMissing, conflictsExtra, placement };
}

export function report(name: string, d: DiffResult): void {
  console.log(`  ${d.pass ? "PASS" : "FAIL"}  ${name}`);
  if (d.articlesMissing.length) console.log("      articles missing:", d.articlesMissing);
  if (d.articlesExtra.length) console.log("      articles extra  :", d.articlesExtra);
  if (d.conflictsMissing.length) console.log("      conflicts missing:", d.conflictsMissing);
  if (d.conflictsExtra.length) console.log("      conflicts extra  :", d.conflictsExtra);
  for (const p of d.placement) console.log("      placement:", JSON.stringify(p));
}
