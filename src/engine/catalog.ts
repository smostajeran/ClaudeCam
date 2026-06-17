// USM article catalog (database.xml): article number -> price, weight, multilingual names.
// Plus the component->article-number map from componentsystem.xml (the <attribute typeref="art_number">).
// Used to resolve a placed part to its billable article for naming + a priced BOM.
import { readFileSync, existsSync } from "node:fs";

export interface Article { artNo: string; price: number; weight: number; en: string; de: string; fr: string; it: string; es: string }
const dec = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#34;/g, '"');

export function loadCatalog(file: string): Map<string, Article> {
  const m = new Map<string, Article>();
  if (!existsSync(file)) return m;
  const xml = readFileSync(file, "utf8");
  for (const a of xml.matchAll(/<article\s+([^>]*?)\/>/g)) {
    const at: Record<string, string> = {};
    for (const k of a[1].matchAll(/([A-Za-z_]\w*)="([^"]*)"/g)) at[k[1]] = k[2];
    if (!at.ArtNo) continue;
    m.set(at.ArtNo, { artNo: at.ArtNo, price: Number(at.Price_EUR) || 0, weight: Number(at.Weight) || 0, en: dec(at.EN ?? ""), de: dec(at.DE ?? ""), fr: dec(at.FR ?? ""), it: dec(at.IT ?? ""), es: dec(at.ES ?? "") });
  }
  return m;
}

// component type -> art_number attribute (literal or VCML expression) from componentsystem.xml.
export function loadComponentArtNo(file: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(file)) return m;
  const xml = readFileSync(file, "utf8");
  for (const c of xml.matchAll(/<component type="([^"]+)">([\s\S]*?)<\/component>/g)) {
    const a = c[2].match(/typeref="art_number"\s+value="([^"]*)"/);
    if (a) m.set(c[1], a[1]);
  }
  return m;
}
