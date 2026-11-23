import {GENERATED_PRODUCTION_FAMILY_ENTRIES} from '../listener/src/searcher/generated/production-family-entries.generated.ts';

export function enabledConversionDefinitions() {
  return GENERATED_PRODUCTION_FAMILY_ENTRIES
    .map(entry => entry.module.selectorFamilyModule)
    .filter(({activation, definition}) => activation.enabled && ['swap', 'protocol'].includes(definition.domain))
    .map(({definition}) => definition);
}
