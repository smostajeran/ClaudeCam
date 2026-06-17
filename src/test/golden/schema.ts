// Golden-test snapshot schema (BUILD_C). Positions in mm, quats [x,y,z,w].
export interface PartSnap { id: string; type: string; pos: [number, number, number]; quat: [number, number, number, number]; rot?: [number, number, number]; features?: Record<string, unknown> }
export interface ArticleSnap { number: string; qty: number }
export interface ConflictSnap { type: string; parts: string[] }
export interface Snapshot {
  project: string;
  pxVersion?: string;
  articles: ArticleSnap[];
  parts: PartSnap[];
  conflicts: ConflictSnap[];
}
export interface Tol { posMm: number; angleDeg: number }
export const DEFAULT_TOL: Tol = { posMm: 0.5, angleDeg: 0.5 };
