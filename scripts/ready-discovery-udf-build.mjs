#!/usr/bin/env node
// Compile existing discovery capability roots into a query-side pure runtime.
// No Family list, SQL annotations, identity RPC, signing, or strict invocation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { build } from '../listener/node_modules/esbuild/lib/main.js';
import ts from '../listener/node_modules/typescript/lib/typescript.js';
import { generatedCapabilityManifestFromShadowArtifact } from '../listener/src/searcher/venues/family-capability-shadow.ts';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));

export function scanDiscoveryPackages(inputPath, sourceRoot) {
  const root = realpathSync(sourceRoot);
  const paths = [];
  function visit(path) {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) visit(join(path,entry.name));
        else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(join(path,entry.name));
      }
    } else paths.push(path);
  }
  visit(realpathSync(inputPath));
  const packages = [], roots = [], ids = new Set();
  const source = path => {
    assert(typeof path === 'string' && !isAbsolute(path), 'Capability source must be package-relative');
    const absolute = realpathSync(resolve(root,path));
    assert(!relative(root,absolute).startsWith('..'), 'Capability source escapes source root');
    return absolute;
  };
  for (const path of paths) {
    const artifact = json(path);
    if (artifact.format !== 'adapter-family-capability-shadow-v1') continue;
    assert.equal(artifact.complete,true,'Incomplete capability package');
    assert.deepEqual(artifact.issues,[],'Capability package has issues');
    assert.deepEqual(artifact.legacy,[],'Legacy capability roots cannot be silently omitted');
    assert(Array.isArray(artifact.exact),'Missing exact capability roots');
    const declaredFamilies=new Set(artifact.exact.map(item=>item.identity?.familyId));
    const discoveryFamilies=new Set(artifact.exact.filter(item=>item.identity?.capability==='discovery').map(item=>item.identity.familyId));
    assert.deepEqual([...declaredFamilies].sort(),[...discoveryFamilies].sort(),'Package Family is missing a discovery capability root');
    generatedCapabilityManifestFromShadowArtifact({ artifact, strictFamilyIds: [...declaredFamilies] });
    packages.push({path,sha256:sha(readFileSync(path))});
    for (const item of artifact.exact.filter(item=>item.identity?.capability === 'discovery')) {
      assert.equal(item.precision,'capability-exact','Discovery root must be capability-exact');
      assert.equal(item.root?.capability,'discovery','Discovery capability root mismatch');
      const familyId = item.identity.familyId;
      assert(typeof familyId === 'string' && familyId.length,'Missing Family ID');
      assert(!ids.has(familyId),'Duplicate discovery root: '+familyId); ids.add(familyId);
      assert.equal(item.root?.absence,null,'Discovery root absent: '+familyId);
      assert.match(item.root.entryExport,/^[A-Za-z_$][\w$]*$/,'Invalid root export');
      assert(Array.isArray(item.root.additionalSourceFiles) && item.root.additionalSourceFiles.length,'Missing manifest sources: '+familyId);
      const entrySourceFile=source(item.root.entrySourceFile),additionalSourceFiles=item.root.additionalSourceFiles.map(source);
      assert.equal(item.root.entryExport, 'defineSelectorFamilyModule', 'Retired production module cannot enter the v2 discovery catalog');
      assert.equal(entrySourceFile, join(root, 'src/searcher/venues/selector-family-module.ts'),
        'Discovery v2 module must use the framework-owned factory');
      assert(Array.isArray(item.root.authoringIntegrity) && item.root.authoringIntegrity.length === 1,
        'Missing selector-family/v2 authoring byte integrity');
      for (const integrity of item.root.authoringIntegrity) {
        const authored = source(integrity.sourceFile);
        assert(additionalSourceFiles.includes(authored), 'Authoring integrity is outside capability roots');
        assert.equal(sha(readFileSync(authored)), integrity.sha256, 'Stale authored JSON byte integrity; regenerate the capability artifact');
      }
      roots.push({familyId,entrySourceFile,entryExport:item.root.entryExport,
        additionalSourceFiles,sourceProvenance:[...new Set([entrySourceFile,...additionalSourceFiles])]
          .map(path=>({path,sha256:sha(readFileSync(path))})),contentHash:item.identity.contentHash,
        semanticDependencies:item.identity.semanticDependencies,packagePath:path});
    }
  }
  assert(packages.length && roots.length,'No complete discovery capability package found');
  roots.sort((a,b)=>a.familyId.localeCompare(b.familyId));
  return {sourceRoot:root,packages,roots};
}

// The production catalog admits only independent selector declarations. Query-side
// discovery binds the same JSON but loads the pure metadata factory, never VM code.
export function declarativeBinding(root, sourceRoot) {
  assert.equal(root.entryExport, 'defineSelectorFamilyModule', 'Retired discovery root: migrate to selector-family/v2 JSON');
  const expected = join(sourceRoot, 'src/searcher/venues/selector-family-module.ts');
  assert.equal(root.entrySourceFile, expected, 'Unsupported selector-native compiler root');
  const definitions = root.additionalSourceFiles.filter(file => file.endsWith('.json'))
    .filter(file => { const format = json(file).format; return format === undefined || format === 'selector-family/v2'; });
  assert.equal(definitions.length, 1, 'Missing/ambiguous selector-native definition');
  const definition = definitions[0], document = json(definition);
  const funding = document.domain === 'funding', credit = document.domain === 'credit';
  assert.match(document.selector, /^0x[0-9a-fA-F]{8}$/, 'Invalid selector-native interface');
  assert(typeof document.signature === 'string', 'Missing selector-native ABI');
  assert(new RegExp('^execution:' + document.selector.toLowerCase() + ':abi-[0-9a-f]{64}$').test(root.familyId),
    'Selector-native ABI family key mismatch');
  const directory = join(sourceRoot, 'src/searcher/venues/production-families'), matches = [];
  for (const file of readdirSync(directory).filter(file => file.endsWith('.production.ts'))) {
    const path = join(directory,file), content = readFileSync(path,'utf8');
    const ast = ts.createSourceFile(path,content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS), imports = new Map();
    for (const node of ast.statements) if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
      const imported = resolve(directory,node.moduleSpecifier.text.replace(/\.js$/,'.ts'));
      if (node.importClause?.name) imports.set(node.importClause.name.text,{path:imported,export:'default'});
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const b of bindings.elements) if (!b.isTypeOnly)
        imports.set(b.name.text,{path:imported,export:b.propertyName?.text ?? b.name.text});
    }
    let count = 0;
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const compiler = imports.get(node.expression.text), args = node.arguments;
        if (compiler?.path === expected && compiler.export === root.entryExport &&
            args[0] && ts.isIdentifier(args[0]) && imports.get(args[0].text)?.path === definition) {
          assert(args.length === 1, 'v2 module accepts one independent JSON');
          const types = node.typeArguments ?? [];
          assert.equal(types.length, 0, 'v2 module cannot override the JSON domain');
          const declaration=node.parent;
          assert(ts.isVariableDeclaration(declaration) &&
            ts.isIdentifier(declaration.name) && declaration.name.text === 'selectorFamilyModule' && ts.isVariableDeclarationList(declaration.parent) &&
            ts.isVariableStatement(declaration.parent.parent) && declaration.parent.parent.parent === ast &&
            declaration.parent.parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
            'Native discovery must bind the exported v2 selectorFamilyModule');
          count++;
        }
      }
      ts.forEachChild(node,visit);
    }
    visit(ast);
    if (count) { assert.equal(count,1,'Ambiguous native compiler invocation'); matches.push({path,sha256:sha(content)}); }
  }
  assert.equal(matches.length,1,'Missing/ambiguous native production binding');
  return {definition,children:[],production:matches[0],selectorNative:true,funding,credit};
}

function sourceExtractor(path, extracts) {
  const content=readFileSync(path,'utf8');
  const ast=ts.createSourceFile(path,content,ts.ScriptTarget.Latest,true,path.endsWith('.ts')?ts.ScriptKind.TS:ts.ScriptKind.JS);
  function save(name,node,text=node.getText(ast)) {
    extracts.push({path,sourceSha256:sha(content),name,start:node.getStart(ast),end:node.end,sha256:sha(text)});
    return text;
  }
  return {
    fn(name) {
      const found=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
      assert.equal(found.length,1,'Missing/ambiguous source function '+name);
      return save(name,found[0]);
    },
    method(className,name) {
      const owner=ast.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text===className);
      const method=owner?.members.find(node=>ts.isMethodDeclaration(node)&&node.name?.getText(ast)===name);
      assert(method,'Missing source method '+className+'.'+name); return save(className+'.'+name,method);
    },
    nestedInitializer(functionName,name) {
      const owner=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===functionName);
      const found=[];
      function walk(node) {if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name)found.push(node.initializer); ts.forEachChild(node,walk);}
      assert(owner,'Missing owner function '+functionName); walk(owner); assert.equal(found.length,1,'Missing/ambiguous local '+name);
      return save(functionName+'.'+name,found[0]);
    },
  };
}

const portableCrypto = `import {sha256} from '@noble/hashes/sha256';
function utf8(text) { const bytes=[]; for(let i=0;i<text.length;i++){let p=text.codePointAt(i);if(p>65535)i++;else if(p>=55296&&p<=57343)p=65533;
if(p<=127)bytes.push(p);else if(p<=2047)bytes.push(192|(p>>6),128|(p&63));else if(p<=65535)bytes.push(224|(p>>12),128|((p>>6)&63),128|(p&63));else bytes.push(240|(p>>18),128|((p>>12)&63),128|((p>>6)&63),128|(p&63));}return new Uint8Array(bytes);}
export function createHash(algorithm){if(algorithm!=='sha256')throw Error('Unsupported portable hash algorithm: '+algorithm);const state=sha256.create();return {
update(input,encoding){if(encoding!==undefined&&encoding!=='utf8')throw Error('Unsupported portable hash input encoding');state.update(typeof input==='string'?utf8(input):input);return this;},
digest(encoding){if(encoding!==undefined&&encoding!=='hex')throw Error('Unsupported portable hash output encoding');const bytes=state.digest();return encoding==='hex'?Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(''):bytes;}};}`;

export async function buildDiscoveryUdf(options) {
  for(const name of ['catalog','sourceRoot','reader','out']) assert(isAbsolute(options[name]),name+' must be absolute');
  assert(!existsSync(options.out),'Output directory must be new; frozen evidence is not overwritten');
  const inventory=scanDiscoveryPackages(options.catalog,options.sourceRoot), extracts=[];
  if (options.familyIds !== undefined) {
    const selected = new Set(options.familyIds);
    assert(selected.size === options.familyIds.length, 'Invalid discovery Family scope');
    inventory.roots = inventory.roots.filter(root => selected.has(root.familyId));
    assert.equal(inventory.roots.length, selected.size, 'Enabled Family is missing from the discovery package');
  }
  const src=join(inventory.sourceRoot,'src/searcher');
  const prod=sourceExtractor(join(src,'universe-rebuild-production.ts'),extracts);
  const checkpoint=sourceExtractor(join(src,'universe-rebuild-checkpoint.ts'),extracts);
  const catalog=sourceExtractor(join(src,'venues/family-capability-catalog.ts'),extracts);
  const reader=sourceExtractor(options.reader,extracts);
  const imports=[], tuples=[];
  for(const [i,root] of inventory.roots.entries()) {
    const binding = declarativeBinding(root, inventory.sourceRoot);
    root.declarative = binding;
    const factory = binding.funding ? 'compileSelectorNativeFundingDiscovery' : binding.credit ? 'compileSelectorNativeCreditDiscovery' : 'compileSelectorNativeDiscovery';
    const file = binding.funding ? 'selector-native-funding-definition.ts' : binding.credit ? 'selector-native-credit-definition.ts' : 'selector-native-discovery.ts';
    imports.push(`import {${factory} as compile${i}} from ${JSON.stringify(join(src,'venues',file))};`);
    imports.push(`import definition${i} from ${JSON.stringify(binding.definition)};`);
    tuples.push(`{plugin:compile${i}(definition${i})}`);
  }
  const methods=['digest','candidateForFamilyObservation','candidateForFamilyCallObservation','adapterLabelForFamily',
    'rebuildFamilyInstanceDedupeKey','candidateInstanceIdentity','hashFamilyCandidateKey','familyIdForCandidate',
    'candidateFingerprint','encodeDurableValue','isSealedReadonlyMap'];
  const helpers=['appendPattern','freezePatternIndex','comparePatternMatch','appendUniqueMatches','addressSurfaceKey','isNonZeroWord','normalizeHex','nonempty'];
  const generated=[...imports,
    `import {readySelectorCensusFromTransaction} from ${JSON.stringify(join(src,'ready-selector-census.ts'))};`,
    `import {readySelectorEdgesFromCensus,readySelectorEdgeKey,readySelectorEdgeFingerprint} from ${JSON.stringify(join(src,'ready-selector-edges.ts'))};`,
    `import {createOpaqueNominationCollector} from ${JSON.stringify(join(dirname(options.reader),'ready-opaque-nominations.mjs'))};`,
    `import {createHash} from '@portable-crypto';`,
    `function assert(value,message){if(!value)throw Error(message);}`,
    `function findManifest(id,modules){const matches=modules.flatMap(module=>Object.values(module)).filter(value=>value&&typeof value==='object'&&value.familyId===id&&Array.isArray(value.ownedActionAdapterIds));if(matches.length!==1)throw Error('Missing/ambiguous manifest: '+id);return matches[0];}`,
    `const families=[${tuples.join(',\n')}];`,
    ...helpers.map(name=>catalog.fn(name)),
    `const PROXY_ADDRESS_SURFACE_WILDCARD='*';`,
    `class MatchIndex { ${catalog.method('FamilyCapabilityCatalog','matches')} }`,
    `const index=new MatchIndex();const callMatches=new Map(),logMatches=new Map(),addressMatches=new Map();
const familyMap=new Map(),actionOwners=new Map(),poolOwners=new Map();
for(const family of families){const {manifest,discovery}=family.plugin;const familyId=manifest.familyId;familyMap.set(familyId,family);
if(typeof discovery.decodeCandidate!=='function'||typeof discovery.candidateKey!=='function')throw Error('Invalid discovery root: '+familyId);
for(const id of manifest.ownedActionAdapterIds){if(actionOwners.has(id))throw Error('Duplicate action owner');actionOwners.set(id,familyId);}
for(const id of manifest.poolAdapterIds??[]){if(poolOwners.has(id)&&poolOwners.get(id)!==familyId)throw Error('Duplicate pool owner');poolOwners.set(id,familyId);}
for(const p of discovery.callPatterns??[])appendPattern(callMatches,normalizeHex(p.selector,4,'call selector'),{familyId,patternId:p.id});
for(const p of discovery.logPatterns??[])appendPattern(logMatches,normalizeHex(p.topic,32,'log topic'),{familyId,patternId:p.id});
for(const p of discovery.addressSurfaces??[])appendPattern(addressMatches,addressSurfaceKey(p.kind,p.kind==='proxy-implementation'?PROXY_ADDRESS_SURFACE_WILDCARD:p.fingerprint),{familyId,patternId:p.id});}
index.callMatches=freezePatternIndex(callMatches);index.logMatches=freezePatternIndex(logMatches);index.addressMatches=freezePatternIndex(addressMatches);
const required=(map,id)=>{if(!map.has(id))throw Error('Unknown catalog key: '+id);return map.get(id);};
const PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG={listAll:()=>families,matches:observation=>index.matches(observation),forStrictFamily:id=>required(familyMap,id),ownerOfAction:id=>required(actionOwners,id),ownerOfPoolAdapter:id=>required(poolOwners,id)};`,
    checkpoint.fn('canonicalJson'),...methods.map(name=>prod.fn(name)),
    `const candidateEvidenceScore=${prod.nestedInitializer('preferCandidateRepresentative','evidenceScore')};`,
    reader.fn('observationsFromTx'),reader.fn('emptyCounts'),
    `export function rules(){return families.map(({plugin:{manifest,discovery}})=>({familyId:manifest.familyId,callPatterns:discovery.callPatterns??[],logPatterns:discovery.logPatterns??[]}));}`,
    `const collectOpaque=createOpaqueNominationCollector(PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG);
export function compactTransaction(tx){const census=readySelectorCensusFromTransaction(tx,{chainId:1});
const censusFingerprint=digest('ready-selector-census/v1:'+canonicalJson(census));
const out=[{kind:'selector-census',key:'1|'+(census.transactionHash??('unresolved:'+censusFingerprint)),block:census.blockNumber,
score:0,fingerprint:censusFingerprint,snapshot:census,tx:census.transactionHash}];
const counts=emptyCounts(),observations=observationsFromTx(tx,counts,census),edgeNominations=[];
for(const raw of observations){const isCall=raw.kind==='call';const observation=isCall?{...raw,source:{number:raw.blockNumber,hash:raw.blockHash,generation:raw.blockNumber}}:{...raw,kind:'log',source:{number:raw.blockNumber,hash:raw.blockHash,generation:raw.blockNumber}};
for(const match of index.matches(observation)){const {familyId,patternId}=match;const discovery=familyMap.get(familyId).plugin.discovery;
const candidate=isCall?candidateForFamilyCallObservation(raw,familyId,patternId):candidateForFamilyObservation(raw,familyId,patternId);
const signature=isCall?raw.data.slice(0,10).toLowerCase():raw.topics[0].toLowerCase();
if(candidate!==null){out.push({kind:'candidate',family:familyId,key:rebuildFamilyInstanceDedupeKey(candidate),block:raw.blockNumber,score:candidateEvidenceScore(candidate),fingerprint:candidateFingerprint(candidate),snapshot:encodeDurableValue(candidate),tx:raw.transactionHash.toLowerCase(),logIndex:raw.logIndex??null,signature});
if(isCall){const abi=discovery.callPatterns?.find(pattern=>pattern.id===patternId)?.signature;if(abi)edgeNominations.push({familyId,signature:abi,candidate});}}
}
for(const retained of collectOpaque(raw)){out.push({kind:'opaque',family:retained.family,key:retained.key,block:raw.blockNumber,score:0,fingerprint:'',snapshot:raw,tx:raw.transactionHash.toLowerCase(),logIndex:raw.logIndex??null,signature:raw.topics[0].toLowerCase()});}}
for(const edge of readySelectorEdgesFromCensus(census,edgeNominations))out.push({kind:'selector-edge',family:edge.familyId,key:readySelectorEdgeKey(edge),block:edge.blockNumber,score:edge.completeness==='complete'?1:0,fingerprint:readySelectorEdgeFingerprint(edge),snapshot:edge,tx:edge.transactionHash,signature:edge.selector});
return out;}
export function compactTransactionJson(input){return JSON.stringify(compactTransaction(JSON.parse(input)));}
export function transactionJson(input){const tx=JSON.parse(input),counts=emptyCounts();const observations=observationsFromTx(tx,counts);return JSON.stringify({counts,observations,records:compactTransaction(tx)});}`,
  ].join('\n');
  mkdirSync(options.out,{recursive:false});
  writeFileSync(join(options.out,'entry.generated.ts'),generated,{flag:'wx',mode:0o600});
  writeFileSync(join(options.out,'crypto-portability.generated.ts'),portableCrypto,{flag:'wx',mode:0o600});
  const jsonResources = new Map();
  const portablePlugin={name:'portable-runtime',setup(build){
    build.onResolve({filter:/^(node:crypto|@portable-crypto)$/},()=>({path:join(options.out,'crypto-portability.generated.ts')}));
    // BigQuery limits each JS library to 1 MiB. Keep declarative data separate
    // from code, as ordinary JS object resources (no eval/string-code loader).
    build.onLoad({filter:/\.json$/}, args => {
      if (!args.path.startsWith(inventory.sourceRoot+'/src/')) return;
      const value=JSON.stringify(JSON.parse(readFileSync(args.path,'utf8'))), hash=sha(value);
      jsonResources.set(hash,value);
      return {loader:'js',contents:`const value=globalThis.__MEV_DISCOVERY_JSON__[${JSON.stringify(hash)}]; if(!value)throw Error('Missing pinned discovery JSON'); export default value;`};
    });

  }};
  const result=await build({entryPoints:[join(options.out,'entry.generated.ts')],outfile:join(options.out,'kernel.js'),bundle:true,
    format:'iife',globalName:'DiscoveryKernel',platform:'browser',target:'es2020',minify:true,metafile:true,logLevel:'silent',
    nodePaths:[new URL('../listener/node_modules',import.meta.url).pathname],define:{self:'globalThis'},plugins:[portablePlugin]});
  const resourceFiles=[];
  let chunk='globalThis.__MEV_DISCOVERY_JSON__=globalThis.__MEV_DISCOVERY_JSON__||{};\n';
  const flush=()=>{const name='definitions-'+String(resourceFiles.length).padStart(3,'0')+'.js';
    writeFileSync(join(options.out,name),chunk,{flag:'wx',mode:0o600});resourceFiles.push({file:name,sha256:sha(chunk),bytes:Buffer.byteLength(chunk)});
    chunk='globalThis.__MEV_DISCOVERY_JSON__=globalThis.__MEV_DISCOVERY_JSON__||{};\n';};
  for(const [hash,value] of [...jsonResources].sort(([a],[b])=>a.localeCompare(b))){
    const statement=`globalThis.__MEV_DISCOVERY_JSON__[${JSON.stringify(hash)}]=${value};\n`;
    assert(Buffer.byteLength(statement)<900000,'Single JSON definition exceeds bounded library size');
    if(Buffer.byteLength(chunk+statement)>900000)flush();chunk+=statement;
  }
  if(jsonResources.size)flush();
  const kernel=readFileSync(join(options.out,'kernel.js'));
  assert(kernel.length<=1048576,'Discovery code exceeds BigQuery library limit');
  // The selector model has no protocol manifest/identity block to validate at
  // build time. Execute its shared pure data validator in the same empty realm
  // used by SQL before publishing a build receipt. No VM or runtime compiler is
  // loaded, and malformed data cannot become a nominally successful artifact.
  if(inventory.roots.some(root=>root.declarative?.selectorNative)){
    const context=vm.createContext({});
    for(const resource of resourceFiles)vm.runInContext(readFileSync(join(options.out,resource.file),'utf8'),context,{timeout:30000});
    vm.runInContext(kernel.toString('utf8'),context,{timeout:30000});
    assert.deepEqual(Array.from(context.DiscoveryKernel.rules(),row=>row.familyId).sort(),inventory.roots.map(root=>root.familyId).sort(),
      'Compiled discovery Family keys disagree with capability roots');
  }
  const inputs=Object.keys(result.metafile.inputs).map(path=>({path,sha256:sha(readFileSync(path))}));
  const report={version:1,builderSha256:sha(readFileSync(new URL(import.meta.url))),...inventory,readerPath:options.reader,readerSha256:sha(readFileSync(options.reader)),
    familyCount:inventory.roots.length,familyIds:inventory.roots.map(root=>root.familyId),scope:options.familyIds ? 'active production discovery roots' : 'all discovered package roots; no production activation changed',
    kernelBytes:kernel.length,kernelSha256:sha(kernel),resources:[...resourceFiles,{file:"kernel.js",sha256:sha(kernel),bytes:kernel.length}],extracts,inputs,
    interfaces:{compactTransactionJson:'JSON tx -> JSON array containing unconditional selector-census, pre-admission selector-edge observations and candidate/opaque records',transactionJson:'JSON tx -> JSON {counts, observations, records}'},
    safety:{strictStarted:false,liveStarted:false,productionFilterEnabled:false}};
  writeFileSync(join(options.out,'build-provenance.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
  writeFileSync(join(options.out,'metafile.json'),JSON.stringify(result.metafile,null,2),{flag:'wx',mode:0o600});
  return report;
}

if(process.argv[1]&&pathToFileURL(realpathSync(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2){assert(args[i].startsWith('--')&&args[i+1],'Expected --option value');options[args[i].slice(2).replace(/-([a-z])/g,(_,$1)=>$1.toUpperCase())]=args[i+1];}
  const result=await buildDiscoveryUdf(options);
  console.log(JSON.stringify({familyCount:result.familyCount,kernelBytes:result.kernelBytes,kernelSha256:result.kernelSha256,out:options.out}));
}
