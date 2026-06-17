// Minimal runtime part-graph + host the interpreter calls into for part-dependent builtins.
import type { Component } from "../model.ts";

export type Value = any; // skeleton: number|string|boolean|null|array|object|Part|Dock

export interface Part {
  id: string;
  type: string;
  features: Map<string, Value>;
  parent: Part | null;
  // dock connections: dockType -> connected Part (filled by the solver later)
  connections: Map<string, Part[]>;
}

// The Host resolves part-dependent builtins (Feature, Dock, GetTypeName, ...).
// Backed by the imported model for type info; the live PartGraph for instance state.
export class Host {
  componentsByType: Map<string, Component>;
  current: Part | null = null;
  env: Map<string, Value>; // EnvValue() store + Scenario()

  constructor(components: Component[], env: Record<string, Value> = {}) {
    this.componentsByType = new Map(components.map((c) => [c.type, c]));
    this.env = new Map(Object.entries(env));
  }

  // supertype chain test, from the imported component nesting
  isSubTypeOf(type: string, ofType: string): boolean {
    let t: string | null | undefined = type;
    const seen = new Set<string>();
    while (t && !seen.has(t)) {
      if (t === ofType) return true;
      seen.add(t);
      t = this.componentsByType.get(t)?.supertype ?? null;
    }
    return false;
  }
}
