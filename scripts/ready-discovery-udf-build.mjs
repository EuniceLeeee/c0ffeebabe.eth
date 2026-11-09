#!/usr/bin/env node
// Compile existing discovery capability roots into a query-side pure runtime.
// No Family list, SQL annotations, identity RPC, signing, or strict invocation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from '../listener/node_modules/esbuild/lib/main.js';
import ts from '../listener/node_modules/typescript/lib/typescript.js';

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
      roots.push({familyId,entrySourceFile:source(item.root.entrySourceFile),entryExport:item.root.entryExport,
        additionalSourceFiles:item.root.additionalSourceFiles.map(source),contentHash:item.identity.contentHash,
        semanticDependencies:item.identity.semanticDependencies,packagePath:path});
    }
  }
  assert(packages.length && roots.length,'No complete discovery capability package found');
  roots.sort((a,b)=>a.familyId.localeCompare(b.familyId));
  return {sourceRoot:root,packages,roots};
}

// Capability roots name code, not necessarily an instantiated capability.
// JSON roots bind the same compiler and ordered children as their production entry.
export function declarativeBinding(root, sourceRoot) {
  const definitions = root.additionalSourceFiles.filter(file => file.endsWith('.json'))
    .filter(file => json(file).manifest?.familyId === root.familyId);
  if (!definitions.length) return null;
  assert.equal(definitions.length, 1, 'Ambiguous JSON Family definition');
  const definition = definitions[0], document = json(definition);
  assert.equal(document.scope?.family, root.familyId, 'JSON Family scope mismatch');
  assert(Array.isArray(document.variantFiles), 'Missing variant bindings');
  const children = document.variantFiles.map(name => {
    assert(typeof name === 'string' && /^\.\/[a-z0-9][a-z0-9-]*\.json$/.test(name), 'Invalid variant path');
    const file = realpathSync(resolve(dirname(definition), name));
    assert(root.additionalSourceFiles.includes(file), 'Variant absent from capability closure');
    return file;
  });
  assert(new Set([definition,...children]).size === children.length + 1, 'Duplicate JSON binding');
  const dir = join(sourceRoot, 'src/searcher/venues/production-families');
  const matches = [];
  for (const file of readdirSync(dir).filter(file => file.endsWith('.production.ts'))) {
    const path = join(dir,file), content = readFileSync(path,'utf8');
    const ast = ts.createSourceFile(path,content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS), imports = new Map();
    for (const node of ast.statements) if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const imported = resolve(dir,node.moduleSpecifier.text.replace(/\.js$/,'.ts'));
      if (node.importClause?.name) imports.set(node.importClause.name.text,{path:imported,export:'default'});
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const b of bindings.elements)
        imports.set(b.name.text,{path:imported,export:b.propertyName?.text ?? b.name.text});
    }
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const binding = imports.get(node.expression.text), args = node.arguments;
        if (binding?.path === root.entrySourceFile && binding.export === root.entryExport &&
            args[0] && ts.isIdentifier(args[0]) && imports.get(args[0].text)?.path === definition) {
          assert(args.length === 2 && ts.isArrayLiteralExpression(args[1]), 'Invalid production child bindings');
          const files = args[1].elements.map(arg => ts.isIdentifier(arg) ? imports.get(arg.text)?.path : undefined);
          assert.deepEqual(files, children, 'Production child bindings disagree with JSON');
          matches.push({path,sha256:sha(content)});
        }
      }
      ts.forEachChild(node,visit);
    }
    visit(ast);
  }
  assert.equal(matches.length,1,'Missing/ambiguous JSON production compiler binding');
  return {definition,children,production:matches[0]};
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
  const src=join(inventory.sourceRoot,'src/searcher');
  const prod=sourceExtractor(join(src,'universe-rebuild-production.ts'),extracts);
  const checkpoint=sourceExtractor(join(src,'universe-rebuild-checkpoint.ts'),extracts);
  const catalog=sourceExtractor(join(src,'venues/family-capability-catalog.ts'),extracts);
  const reader=sourceExtractor(options.reader,extracts);
  const imports=[], tuples=[];
  for(const [i,root] of inventory.roots.entries()) {
    const binding = declarativeBinding(root, inventory.sourceRoot);
    if (binding) {
      root.declarative = binding;
      const domain = json(binding.definition).production.domain;
      const suffix = {protocol:'Protocol',swap:'Swap',credit:'Credit'}[domain];
      assert(suffix && root.entryExport === 'compileDeclarative'+suffix &&
        root.entrySourceFile === join(src,'venues/declarative-'+domain+'.ts'), 'Unsupported declarative compiler root');
      imports.push(`import {compileDeclarativeFamilyDiscovery as compile${i}} from ${JSON.stringify(join(src,'venues/declarative-family-discovery.ts'))};`);
      imports.push(`import definition${i} from ${JSON.stringify(binding.definition)};`);
      binding.children.forEach((file,j)=>imports.push(`import child${i}_${j} from ${JSON.stringify(file)};`));
      tuples.push(`{plugin:compile${i}(definition${i},[${binding.children.map((_,j)=>`child${i}_${j}`).join(',')}])}`);
    } else {
      imports.push(`import {${root.entryExport} as discovery${i}} from ${JSON.stringify(root.entrySourceFile)};`);
      const namespaces=root.additionalSourceFiles.map((file,j)=>{const name='manifestSource'+i+'_'+j;imports.push(`import * as ${name} from ${JSON.stringify(file)};`);return name;});
      tuples.push(`{plugin:{discovery:discovery${i},manifest:findManifest(${JSON.stringify(root.familyId)},[${namespaces.join(',')}])}}`);
    }
  }
  const methods=['digest','candidateForFamilyObservation','candidateForFamilyCallObservation','adapterLabelForFamily',
    'rebuildFamilyInstanceDedupeKey','candidateInstanceIdentity','hashFamilyCandidateKey','familyIdForCandidate',
    'candidateFingerprint','encodeDurableValue','isSealedReadonlyMap'];
  const helpers=['appendPattern','freezePatternIndex','comparePatternMatch','appendUniqueMatches','addressSurfaceKey','isNonZeroWord','normalizeHex','nonempty'];
  const generated=[...imports,
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
export function compactTransaction(tx){const counts=emptyCounts(),observations=observationsFromTx(tx,counts),out=[];
for(const raw of observations){const isCall=raw.kind==='call';const observation=isCall?{...raw,source:{number:raw.blockNumber,hash:raw.blockHash,generation:raw.blockNumber}}:{...raw,kind:'log',source:{number:raw.blockNumber,hash:raw.blockHash,generation:raw.blockNumber}};
for(const match of index.matches(observation)){const {familyId,patternId}=match;const discovery=familyMap.get(familyId).plugin.discovery;
const candidate=isCall?candidateForFamilyCallObservation(raw,familyId,patternId):candidateForFamilyObservation(raw,familyId,patternId);
const signature=isCall?raw.data.slice(0,10).toLowerCase():raw.topics[0].toLowerCase();
if(candidate!==null)out.push({kind:'candidate',family:familyId,key:rebuildFamilyInstanceDedupeKey(candidate),block:raw.blockNumber,score:candidateEvidenceScore(candidate),fingerprint:candidateFingerprint(candidate),snapshot:encodeDurableValue(candidate),tx:raw.transactionHash.toLowerCase(),logIndex:raw.logIndex??null,signature});
}
for(const retained of collectOpaque(raw)){out.push({kind:'opaque',family:retained.family,key:retained.key,block:raw.blockNumber,score:0,fingerprint:'',snapshot:raw,tx:raw.transactionHash.toLowerCase(),logIndex:raw.logIndex??null,signature:raw.topics[0].toLowerCase()});}}
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
    // Retained TS discovery may wrap a declarative runtime. Project that shared
    // dependency too; never load identity/execution merely to obtain discovery.
    build.onLoad({filter:/[\/]declarative-(protocol|swap|credit)\.ts$/}, args => {
      const domain = args.path.match(/declarative-(protocol|swap|credit)\.ts$/)[1];
      assert.equal(args.path,join(src,'venues/declarative-'+domain+'.ts'),'Unexpected compiler module');
      const suffix={protocol:'Protocol',swap:'Swap',credit:'Credit'}[domain];
      return {loader:'ts',resolveDir:dirname(args.path),contents:
        `import {compileDeclarativeFamilyDiscovery} from './declarative-family-discovery.js';
export function createDeclarative${suffix}Runtime(raw,children=[]){if(raw.production.domain!==${JSON.stringify(domain)})throw Error('Wrong discovery domain');return {definition:compileDeclarativeFamilyDiscovery(raw,children)};}
export function compileDeclarative${suffix}(raw,children=[]){return createDeclarative${suffix}Runtime(raw,children).definition;}`};
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
  const inputs=Object.keys(result.metafile.inputs).map(path=>({path,sha256:sha(readFileSync(path))}));
  const report={version:1,builderSha256:sha(readFileSync(new URL(import.meta.url))),...inventory,readerPath:options.reader,readerSha256:sha(readFileSync(options.reader)),
    familyCount:inventory.roots.length,familyIds:inventory.roots.map(root=>root.familyId),scope:'all discovered package roots; no production activation changed',
    kernelBytes:kernel.length,kernelSha256:sha(kernel),resources:[...resourceFiles,{file:"kernel.js",sha256:sha(kernel),bytes:kernel.length}],extracts,inputs,
    interfaces:{compactTransactionJson:'JSON tx -> JSON array of decorated candidate/opaque records',transactionJson:'JSON tx -> JSON {counts, observations, records}'},
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
