import type { ProductionTerminalSelectionMaterialV1 } from "../internal/terminal-selection-material-owner.ts";
import { readProductionPredicateMaterialSourceStateV1 } from "../internal/predicate-material-source-owner.ts";
import { available, defineProvider, unavailable } from "./shared.ts";

const PREDICATE_ID = "aloha.terminal-selection-lineage.facts";

export const TERMINAL_SELECTION_MATERIAL_PROVIDER = defineProvider(PREDICATE_ID, async source => {
  const state = readProductionPredicateMaterialSourceStateV1(source);
  if (state.observeTerminalSelection === null) {
    return unavailable(PREDICATE_ID, "missing", "owner-port-missing", "terminal-selection-observer");
  }
  try {
    const material = await state.observeTerminalSelection() as ProductionTerminalSelectionMaterialV1;
    return available(
      PREDICATE_ID,
      material.candidateReleaseCommit,
      material.artifacts,
      [material.resolverPolicy],
      [material.fact],
    );
  } catch (error) {
    return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", error instanceof Error ? error.message : "terminal-selection-owner");
  }
});
