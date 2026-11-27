import {hashCanonical} from './canonical-value.js';
import type {SelectorNativeExecutionDefinition,SelectorNativeProgram} from './selector-native-definition.js';

/** Legacy untyped declarations keep their existing execution behavior. An
 * explicitly separate identity program is never an execution alternative. */
export function selectorExecutionPrograms(definition:SelectorNativeExecutionDefinition):readonly SelectorNativeProgram[]{
  return definition.programs.filter(p=>p.type!=='independentIdentity');
}

/** Source-compiled definitions declare exactly one execution template. */
export function selectSingleExecution(definition:SelectorNativeExecutionDefinition):{
  readonly program:SelectorNativeProgram;
  readonly programKey:string;
}{
  const programs=definition.programs.some(p=>p.type!==undefined)
    ?definition.programs.filter(p=>p.type==='execution')
    :selectorExecutionPrograms(definition);
  if(programs.length!==1)throw Error(`selector definition requires exactly one execution program (found ${programs.length})`);
  const program=programs[0]!;
  return {program,programKey:`parameters:${hashCanonical(program as any)}`};
}

/** Pure source projections and legacy read bindings expose the same data
 * coordinate contract, but source projections never contain read flows. */
export function selectorProgramProjection(program:SelectorNativeProgram):SelectorNativeProgram['binding']{
  return program.projection??program.binding;
}
