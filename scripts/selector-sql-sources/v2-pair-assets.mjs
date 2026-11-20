// Target-blind Ethereum mainnet asset identity. A pairFor match verifies the
// factory-derived address for two proposed currencies, not activity, direction,
// Family eligibility, code at a block, or proof of absence for unmatched pairs.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const listener=new URL('../../listener/',import.meta.url);
const {build}=createRequire(new URL('package.json',listener))('esbuild');
export const v2PairFactory='0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f';
const initCodeHash='96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f';
// Matches the immutable TRUSTED_V2_LINEAGES bootstrap, without loading
// any discovery state. Source of hash: deployed factory.pairCodeHash(),
// selector 0x9aab9248; the test records the canonical historical read.
export const sushiV2PairFactory='0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac';
const sushiInitCodeHash='e18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303';

async function compileUdf(name,factory,codeHash){
  const result=await build({stdin:{resolveDir:fileURLToPath(listener),contents:`
import {keccak_256} from '@noble/hashes/sha3';
import {hexToBytes,bytesToHex} from '@noble/hashes/utils';
const hash=x=>bytesToHex(keccak_256(hexToBytes(x)));
export function expected(a,b){
  const valid=s=>typeof s==='string'&&s.length===42&&/^0x[0-9a-fA-F]{40}$/.test(s);
  if(!valid(a)||!valid(b))return null;
  a=a.slice(2).toLowerCase();b=b.slice(2).toLowerCase();
  if(a===b||/^0+$/.test(a)||/^0+$/.test(b))return null;
  // UniswapV2Library.pairFor: keccak256(abi.encodePacked(token0, token1)).
  // The salt preimage is 40 bytes, not the 64 bytes of abi.encode.
  const salt=hash(a<b?a+b:b+a);
  return '0x'+hash('ff'+'${factory.slice(2)}'+salt+'${codeHash}').slice(-40);
}`},bundle:true,write:false,format:'iife',globalName:'V2PairAddress',platform:'browser',target:'es2020',minify:true,legalComments:'none'});
  return `CREATE TEMP FUNCTION ${name}(tokenA STRING,tokenB STRING)
RETURNS STRING LANGUAGE js AS r'''
${result.outputFiles[0].text}
return V2PairAddress.expected(tokenA,tokenB);
''';`;
}
let cached,lineageCached;
// Propose token addresses from transaction evidence, then require the
// CREATE2-derived pair address to equal the actual Swap emitter.
export function renderV2PairUdf(){return cached??=compileUdf('v2ExpectedPair',v2PairFactory,initCodeHash);}
export function renderV2LineagePairUdf(){return lineageCached??=compileUdf('v2LineageExpectedPair',sushiV2PairFactory,sushiInitCodeHash);}
