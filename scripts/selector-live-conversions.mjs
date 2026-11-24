import {GENERATED_PRODUCTION_FAMILY_ENTRIES} from '../listener/src/searcher/generated/production-family-entries.generated.ts';

import {isEnabledSqlExecutionLeg} from '../listener/src/searcher/sql-execution-selectors.ts';

export function enabledConversionDefinitions() {
  return GENERATED_PRODUCTION_FAMILY_ENTRIES
    .map(entry => entry.module.selectorFamilyModule)
    .filter(isEnabledSqlExecutionLeg)
    .map(({definition}) => definition);
}
