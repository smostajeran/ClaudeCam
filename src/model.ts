// Normalized engine model (BUILD_A). Units: cm; angles: degrees; source axes Z-up.
// Values that are VCML expressions are kept verbatim as strings (number when literal).

export type Num = number | string; // string => VCML expression kept verbatim
export interface Vec3 { x: Num; y: Num; z: Num }
export type Axis = "x" | "y" | "z" | "vector";

export interface Dof {
  kind: "rota" | "trans";
  axis: Axis;
  vector?: Vec3;
  domain?: { kind: "continuous" | "step"; from?: Num; to?: Num; step?: Num };
  default?: number;
}

export interface Dock {
  index: number;
  type: string;
  partnerTypes: string[];           // from docksystem
  translate: Vec3;
  euler: Vec3;                      // degrees
  amount?: { count: number; increment: Vec3 };
  activeExpr?: string;
  dof?: Dof;
  hasDynamic?: boolean;             // true if any transform field is an expression
}

export interface Component {
  type: string;
  supertype: string | null;        // enclosing <component> in the nesting
  include?: string;                // external componentsystem reference
  docks: Dock[];
}

export interface DockType {        // from docksystem.xml
  type: string;
  partnerTypes: string[];
  dof?: Dof;
  snappable?: boolean;
}

export interface RawNode { tag: string; attrs: Record<string, string>; children: RawNode[] }

export interface Property {
  type: string;
  feature: string;
  defaultExpr: Num | string;
  evalOnAccess: boolean;
  overwritable: boolean;
  domain?: { kind: string; numeric?: boolean; values?: string[]; from?: Num; to?: Num };
  assignedTo: string[]; // aggregationassignment part types that useproperty this
}

export interface Clause { type: string; condition?: RawNode }

export interface Morphology { targetType: string; activeExpr?: string; partContext: { id: string; type: string }[] }
export interface AssemblyRule {
  type: string;
  targetType?: string;
  blockId?: string;
  priority?: string;
  coords?: { positionPartId?: string; rotationPartId?: string; translate?: Vec3 };
  morphologies: Morphology[];
  condition?: RawNode;
}

export interface Volume {
  type: string;
  volumetype: string;
  corner?: string;
  occupancy: { type: string; min: number; appendage?: boolean }[];
}

export interface GeomRep {
  component: string;
  geometryRefs: string[];
  material?: string;
  rotation?: Vec3;
  scale?: Vec3;
  transformationExpr?: string;
  updateTrigger?: string;
}

export interface ModelBundle {
  meta: { product: string; cartridgeVersion: string; sourceBuild: string; generated: string };
  components: Component[];
  dockTypes: DockType[];
  properties: Property[];
  clauses: Clause[];
  assemblyRules: AssemblyRule[];
  articles: AssemblyRule[];
  volumes: Volume[];
  geomReps: GeomRep[];
  coverage: Record<string, unknown>;
}
