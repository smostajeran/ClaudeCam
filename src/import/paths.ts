import { join } from "node:path";
// Decoded-cartridge root. Override on a server (Railway etc.) with USM_DATA, e.g. /app/data;
// defaults to the local Windows decode for development.
export const ROOT = process.env.USM_DATA ?? "C:/Virtual-LastU/snx2xml";
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
