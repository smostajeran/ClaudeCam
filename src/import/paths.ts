import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
// Decoded-cartridge root. Override on a server (Railway etc.) with USM_DATA, e.g. /app/data.
// Otherwise prefer the in-repo `data/` bundle so a fresh clone runs with no setup (this is what
// lets `node src/engine/place.ts` etc. work out of the box); fall back to the local Windows decode.
const REPO_DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
export const ROOT = process.env.USM_DATA
  ?? (existsSync(join(REPO_DATA, "co", "packages")) ? REPO_DATA : "C:/Virtual-LastU/snx2xml");
export const APPCODES_DIR = join(ROOT, "co/appcodes");
export const SNX = join(ROOT, "co/packages/hallerpackage");
export const CART = join(SNX, "cartridge");
export const REP = join(SNX, "representation");

export const FILES = {
  componentsystem: CART + "/componentsystem.xml",
  docksystem: CART + "/docksystem.xml",
  properties: CART + "/properties.xml",
  clauses: CART + "/clauses.xml",
  assemblyrules: CART + "/assemblyrules.xml",
  articlerules: CART + "/articlerules.xml",
  volumes: CART + "/volumes.xml",
  geometryrepresentation: REP + "/geometryrepresentation.xml",
  conflictrepresentation: REP + "/conflictrepresentation.xml",
  language_en: ROOT + "/gui_language_en.xml",
};
