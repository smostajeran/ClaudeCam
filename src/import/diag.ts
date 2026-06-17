import { readFileSync } from "node:fs";
import { FILES } from "./paths.ts";

const xml = readFileSync(FILES.componentsystem, "utf8");
const noComments = xml.replace(/<!--[\s\S]*?-->/g, "");
function types(s: string): string[] {
  const re = /<component\b[^>]*\btype="([^"]+)"/g;
  const a: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) a.push(m[1]);
  return a;
}
const uniq = (a: string[]) => [...new Set(a)];

const rawAll = types(xml);
const liveAll = types(noComments);
const model = JSON.parse(readFileSync("out/model.json", "utf8"));
const parsed: string[] = model.components.map((c: any) => c.type);

console.log("rawAll(incl comments):", rawAll.length, " rawUniq:", uniq(rawAll).length);
console.log("live(no comments)   :", liveAll.length, " liveUniq:", uniq(liveAll).length);
console.log("parsed              :", parsed.length, " parsedUniq:", uniq(parsed).length);

const seen = new Set<string>();
const dups = [...new Set(parsed.filter((t) => seen.has(t) || (seen.add(t), false)))];
console.log("duplicate types in parsed:", dups);

const ps = new Set(parsed);
console.log("live-but-not-parsed:", uniq(liveAll).filter((t) => !ps.has(t)));
console.log("comment-only types :", uniq(rawAll).filter((t) => !uniq(liveAll).includes(t)));
