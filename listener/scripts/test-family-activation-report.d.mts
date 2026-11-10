interface FamilyActivationResult {
  id: string;
  definition: boolean;
  passed: number;
  failed: number;
  incomplete: number;
  result: "passed" | "failed" | "incomplete";
}

export function selectFamilyActivation(
  events: readonly unknown[],
  familyIds: readonly string[],
  exitCode: number,
): { sharedFailures: string[]; families: FamilyActivationResult[] };
