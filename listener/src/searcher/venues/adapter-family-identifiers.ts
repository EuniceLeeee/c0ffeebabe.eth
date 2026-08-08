export type FamilyId = string & { readonly __familyId: unique symbol };
export type LineageId = string & { readonly __lineageId: unique symbol };
export type InstanceKey = string & { readonly __instanceKey: unique symbol };
export type FamilyInstanceKey = string & {
  readonly __familyInstanceKey: unique symbol;
};
export type RouteKey = string & { readonly __routeKey: unique symbol };
export type StateInstanceKey = string & {
  readonly __stateInstanceKey: unique symbol;
};

export function familyId(value: string): FamilyId {
  return identifier(value, "familyId") as FamilyId;
}

export function lineageId(value: string): LineageId {
  return identifier(value, "lineageId") as LineageId;
}

export function instanceKey(value: string): InstanceKey {
  return identifier(value, "instanceKey") as InstanceKey;
}

export function routeKey(value: string): RouteKey {
  return identifier(value, "routeKey") as RouteKey;
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
  if (normalized !== value) {
    throw new Error(`${label} must not contain surrounding whitespace`);
  }
  return normalized;
}
