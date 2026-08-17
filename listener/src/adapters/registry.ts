import type { ActionAdapter } from "../types.js";
import type { AdapterDescriptor } from "./adapter-descriptors.js";

const adapters = new Map<string, ActionAdapter>();

export function register(adapter: ActionAdapter): void {
  if (adapters.has(adapter.id)) {
    throw new Error(`adapter already registered: ${adapter.id}`);
  }
  if (descriptorForRegisteredAdapter(adapter) === null) {
    throw new Error(`missing adapter descriptor: ${adapter.id}`);
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

export function classifyCall(target: string, selector: string): AdapterDescriptor | null {
  const adapter = matchCall(target, selector);
  return adapter ? descriptorForRegisteredAdapter(adapter) : null;
}

export function assertDescriptorCoverage(): void {
  const missing = [...adapters.values()]
    .filter((adapter) => descriptorForRegisteredAdapter(adapter) === null)
    .map((adapter) => adapter.id);
  if (missing.length > 0) {
    throw new Error(`missing adapter descriptor(s): ${missing.join(", ")}`);
  }
}

export function listAll(): ActionAdapter[] {
  return [...adapters.values()];
}

export function listDescriptors(): AdapterDescriptor[] {
  return [...adapters.values()].map((adapter) => {
    const descriptor = descriptorForRegisteredAdapter(adapter);
    if (!descriptor) {
      throw new Error(`missing adapter descriptor: ${adapter.id}`);
    }
    return descriptor;
  });
}

function descriptorForRegisteredAdapter(
  adapter: ActionAdapter,
): AdapterDescriptor | null {
  const inline = adapter.descriptor;
  if (inline === undefined) return null;
  if (inline.adapterId !== adapter.id) {
    throw new Error(
      `adapter ${adapter.id} descriptor id mismatch: ${inline.adapterId}`,
    );
  }
  return inline;
}
