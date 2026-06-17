import { readFileSync } from "node:fs";
import { FILES } from "./paths.ts";

function counts(file: string, tag: string) {
  const xml = readFileSync(file, "utf8");
  const live = xml.replace(/<!--[\s\S]*?-->/g, "");
  const raw = (xml.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
  const liveTotal = (live.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
  const selfClosing = (live.match(new RegExp(`<${tag}\\b[^>]*/>`, "g")) ?? []).length; // references
  console.log(
    `${file.split("/").pop()} <${tag}>: raw(incl comments)=${raw}  live=${liveTotal}  self-closing(refs)=${selfClosing}  with-body(defs)=${liveTotal - selfClosing}`,
  );
}
counts(FILES.properties, "property");
counts(FILES.clauses, "clause");
counts(FILES.articlerules, "assemblyrule");
counts(FILES.assemblyrules, "assemblyrule");
