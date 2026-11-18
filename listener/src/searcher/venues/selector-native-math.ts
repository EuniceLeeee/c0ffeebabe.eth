import { assertModuleData } from './declarative-modules.js';
import { createDeclarativeMathRegistry, type DeclarativeMathFunctions } from './declarative-math.js';
import { compileDeclarativeValues, validateDeclarativeStatements, validateDeclarativeValue } from './declarative-values.js';

/** Pure parameter/observation calculations travel inside the declaration.
 * There is no registry of protocol implementations or imported handlers. */
export function bindSelectorNativeMath(raw: any = {version:1,entries:{},models:[]}): DeclarativeMathFunctions {
  assertModuleData(raw);
  if (!raw || raw.version !== 1 || !raw.entries || !Array.isArray(raw.models) ||
      Object.keys(raw).some(key => !['version','entries','models'].includes(key))) throw new Error('native value model bindings');
  const pure = new Set(['abiEncode','create2Address','mul','max','program','number','lower','unique','pow','objectEntries','objectFromEntries',
    'uint','address','sameAddress','hash','codeHash','get','defined','not','and','or','eq','ne','gt','gte','lt','lte','add','sub','div','min',
    'coalesce','if','merge','omit','concat','map','flatMap','filter','some','every','at','length','string','join','sortId','bytes','maskHash',
    'matches','expression','sumUint','shrUint','andUint','signedWord','packedHash']);
  function check(value: any): void {
    if (value && typeof value === 'object') {
      if (Object.hasOwn(value,'op') && !pure.has(value.op)) throw new Error('native value model must be pure');
      Object.values(value).forEach(check);
    }
  }
  const models = raw.models.map((model: any) => {
    if (!model || Object.keys(model).some(key => !['id','version','values','program'].includes(key)) ||
        typeof model.id !== 'string' || !Number.isSafeInteger(model.version) || !Array.isArray(model.program))
      throw new Error('native inline value model');
    check(model);
    const values = compileDeclarativeValues({abi:{},constants:{},expressions:{},programs:{},...model.values});
    validateDeclarativeValue(model.program);
    validateDeclarativeStatements(model.program);
    return { id:model.id, version:model.version,
      validateInput() {},
      evaluate(input: any) { return values.run(model.program,{input}); },
      validateOutput(output: any) { if (output === undefined) throw new Error('native value model returned no result'); },
    };
  });
  return createDeclarativeMathRegistry(models).bind({version:1,entries:raw.entries});
}
