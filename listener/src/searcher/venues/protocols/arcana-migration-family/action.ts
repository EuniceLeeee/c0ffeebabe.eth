import { arcanaMigrationActionAdapter } from "../../../../adapters/arcana-migration.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const arcanaMigrationFamilyOwnedAction = bindFamilyOwnedAction({
  action: arcanaMigrationActionAdapter,
  descriptor: arcanaMigrationActionAdapter.descriptor,
});
