import type { ActionAdapter } from "../types.js";

const adapters = new Map<string, ActionAdapter>();

export function register(adapter: ActionAdapter): void {
  if (adapters.has(adapter.id)) {
    throw new Error(`adapter already registered: ${adapter.id}`);
  }
  adapters.set(adapter.id, adapter);
}

export function get(id: string): ActionAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`unknown adapter: ${id}`);
  return adapter;
}

/** Find adapter matching a trace call. Returns null if none match. */
export function matchCall(
  target: string,
  selector: string,
): ActionAdapter | null {
  for (const adapter of adapters.values()) {
    if (adapter.matchTrace(target, selector)) return adapter;
  }
  return null;
}

export function listAll(): ActionAdapter[] {
  return [...adapters.values()];
}
