// Importer entry point. Emits out/model.json + a validated coverage report.
import { writeFileSync } from "node:fs";
import { importComponentsAndDocks } from "./components.ts";
import {
  importProperties, importClauses, importAssemblyRules, importArticleRules, importVolumes, importGeomReps,
} from "./systems.ts";
import type { ModelBundle } from "../model.ts";

// Verified true counts (1025 = grep's 1026 minus the commented-out rohr250E).
const EXPECT: Record<string, number> = {
  components: 1025, dockTypes: 369, properties: 180, clauses: 124, assemblyRules: 75, articles: 239,
};

function main(): void {
  const t0 = Date.now();
  const { components, dockTypes } = importComponentsAndDocks();
  const properties = importProperties();
  const clauses = importClauses();
  const assemblyRules = importAssemblyRules();
  const articles = importArticleRules();
  const volumes = importVolumes();
  const geomReps = importGeomReps();

  const got: Record<string, number> = {
    components: components.length, dockTypes: dockTypes.length, properties: properties.length,
    clauses: clauses.length, assemblyRules: assemblyRules.length, articles: articles.length,
  };

  const bundle: ModelBundle = {
    meta: { product: "usm_haller", cartridgeVersion: "vUSM 10.2.0", sourceBuild: "5.4.18", generated: new Date().toISOString() },
    components, dockTypes, properties, clauses, assemblyRules, articles, volumes, geomReps,
    coverage: {
      ...got,
      volumes: volumes.length,
      geomReps: geomReps.length,
      dockInstances: components.reduce((s, c) => s + c.docks.length, 0),
      dockTypesWithDof: dockTypes.filter((d) => d.dof).length,
      propertiesWithDomain: properties.filter((p) => p.domain).length,
      propertyAssignments: properties.reduce((s, p) => s + p.assignedTo.length, 0),
    },
  };
  writeFileSync("out/model.json", JSON.stringify(bundle, null, 2));

  console.log("=== usm-engine importer (Haller) ===");
  let allOk = true;
  for (const k of Object.keys(EXPECT)) {
    const ok = got[k] === EXPECT[k];
    allOk &&= ok;
    console.log(`  ${ok ? "OK " : "!! "} ${k}: ${got[k]}${ok ? "" : ` (expected ${EXPECT[k]})`}`);
  }
  console.log(`     volumes: ${volumes.length} · geomReps: ${geomReps.length} · dockInstances: ${bundle.coverage.dockInstances} · propAssignments: ${bundle.coverage.propertyAssignments}`);
  console.log(`  -> out/model.json  (${Date.now() - t0} ms)  ${allOk ? "[ALL GREEN]" : "[CHECK FAILURES]"}`);

  // spot-checks grounded in the manual analysis
  const dockRot = (type: string, dt: string) =>
    JSON.stringify(components.find((c) => c.type === type)?.docks.find((d) => d.type === dt)?.euler);
  console.log("=== spot-checks ===");
  console.log("  hinge L scharnier_vorne_oben2glas:", dockRot("glasscharnier_vorne_oben_l", "scharnier_vorne_oben2glas"), "(expect x=180)");
  console.log("  hinge R scharnier_vorne_oben2glas:", dockRot("glasscharnier_vorne_oben_r", "scharnier_vorne_oben2glas"), "(expect x=0)");
  const inos = properties.find((p) => p.feature === "f_inosBoxRotation");
  console.log("  f_inosBoxRotation domain:", JSON.stringify(inos?.domain?.values), "(expect [0,90])");
  const beschlag = properties.find((p) => p.feature === "Beschlaegematerial");
  console.log("  Beschlaegematerial domain:", JSON.stringify(beschlag?.domain?.values), "(expect globaldef/C0/B0)");
}
main();
