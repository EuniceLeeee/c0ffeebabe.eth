// Asset-order evidence only, not a Family admission rule. Ethereum mainnet's
// factory and pool init-code hash are the deployment inputs to PoolAddress.sol.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const listener = new URL('../../listener/', import.meta.url);
const {build} = createRequire(new URL('package.json', listener))('esbuild');
const factory = '0x1f98431c8ad98523631ae4a59f267346ea31f984';
// Sushi's own deployments/ethereum/UniswapV3Factory.json; the same pool
// creation-code hash below pins the ABI of @uniswap/v3-core@1.0.1.
export const sushiV3ReceiptFactory = '0xbaceb8ec6b9355dfc0269c18bac9d6e2bdc29c4f';
// ABI subscription constraint for a proven contract, NOT observed calldata.
export const v3LineageReceiptEvidence = Object.freeze({tag:'swap+v3-lineage-receipt-create2',selector:'0x128acb08'});
const initCodeHash = 'e34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';
const udfName = 'v3FactoryExpectedPool';

async function render() {
  const result = await build({
    stdin: {resolveDir: fileURLToPath(listener), contents: `
      import {keccak_256} from '@noble/hashes/sha3';
      import {hexToBytes, bytesToHex} from '@noble/hashes/utils';
      const digest = (hex) => bytesToHex(keccak_256(hexToBytes(hex)));
      export function expected(f, a, b, fee) {
        const address = x => typeof x === 'string' && x.length === 42 && /^0x[0-9a-fA-F]{40}$/.test(x);
        if (![f, a, b].every(address) || !['${factory}','${sushiV3ReceiptFactory}'].includes(f.toLowerCase()) ||
            typeof fee !== 'string' || !/^(0|[1-9][0-9]{0,7})$/.test(fee) ||
            Number(fee) > 0xffffff) return null;
        a = a.slice(2).toLowerCase(); b = b.slice(2).toLowerCase();
        if (a >= b || /^0{40}$/.test(a)) return null;
        // keccak256(abi.encode(address,address,uint24)); not abi.encodePacked.
        const word = s => s.padStart(64, '0');
        const salt = digest(word(a) + word(b) + word(Number(fee).toString(16)));
        // bytes1(0xff), 20-byte factory, 32-byte salt, 32-byte init-code hash.
        return '0x' + digest('ff' + f.slice(2).toLowerCase() + salt + '${initCodeHash}').slice(-40);
      }
    `},
    bundle: true, write: false, platform: 'browser', format: 'iife',
    target: 'es2020', globalName: 'V3PoolAddress', minify: true, legalComments: 'none',
  });
  const udf = `CREATE TEMP FUNCTION ${udfName}(factoryAddress STRING, asset0 STRING, asset1 STRING, feeText STRING)
RETURNS STRING LANGUAGE js AS r'''
${result.outputFiles[0].text}
return V3PoolAddress.expected(factoryAddress, asset0, asset1, feeText);
''';`;
  return udf;
}

let rendered;
// Standalone, pure address derivation. This module has no chain-data source.
export async function renderV3ReceiptAddressUdf() {
  return rendered ??= render();
}
