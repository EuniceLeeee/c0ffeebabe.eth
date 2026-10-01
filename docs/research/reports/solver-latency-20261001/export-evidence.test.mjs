import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactText } from './export-evidence.mjs';

const textCases = [
  'https://review-user:CANARY_PASSWORD@provider.invalid/v2/CANARY_KEY',
  'https://review-user:CANARY_PASSWORD@github.com/path',
  'Authorization: Bearer CANARY_BEARER',
  'Proxy-Authorization: Basic CANARY_BASIC',
  '"Authorization": "Bearer CANARY_BEARER"',
  '{"private_key":"CANARY_PRIVATE","Authorization":"Bearer CANARY_BEARER"}',
  '{"apiKey":"CANARY_API"}',
  'SEARCHER_PRIVATE_KEY=CANARY_PRIVATE',
  'client_secret="CANARY_CLIENT_SECRET"',
  'X-Api-Key: CANARY_API',
  'https:\\/\\/review-user:CANARY_PASSWORD@provider.invalid/v2/CANARY_KEY',
  String.raw`{\"private_key\":\"CANARY_PRIVATE\"}`,
  'https://github.com/example#token=CANARY_TOKEN',
  'https://github.com/example#CANARY_OPAQUE',
  'PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nCANARY_BODY\n-----END PRIVATE KEY-----"',
  '--private-key CANARY_PRIVATE --api-key="CANARY_API"',
  "message='{\"private_key\":\"CANARY_NESTED\"}' durationMs=3",
  'password="CANARY_HEAD\\"CANARY_TAIL" durationMs=3',
  '--password "CANARY_HEAD\\"CANARY_TAIL" durationMs=3',
];
for (let i = 0; i < textCases.length; i++) {
  test(`text secret form ${i + 1}`, () => assert(!redactText(textCases[i]).includes('CANARY_')));
}

test('nested structured and embedded serialized secrets', () => {
  const value = {
    nested: [{ SEARCHER_PRIVATE_KEY: 'CANARY_PRIVATE', client_secret: 'CANARY_CLIENT', rpcPassword: 'CANARY_PASSWORD',
      'X-Api-Key': 'CANARY_API', Authorization: 'Bearer CANARY_BEARER' }],
    message: '{"private_key":"CANARY_EMBEDDED"}',
  };
  assert(!JSON.stringify(redact(value)).includes('CANARY_'));
});

test('public source link, line anchor, address, hash, timing and count retained', () => {
  const value = { source: 'https://raw.githubusercontent.com/KyberNetwork/kyberswap-dex-lib/0867b088e490608f731e4e37eaf49ea72e7846b3/pkg/entity/pool.go',
    line: 'https://github.com/Uniswap/v4-core/blob/main/src/libraries/Pool.sol#L38-L42',
    address: '0x1111111111111111111111111111111111111111', hash: '0x' + '1'.repeat(64), block: 26090582, wallMs: 4472.096833000192, count: 29449 };
  assert.deepEqual(redact(value), value);
});

test('redacted map keys cannot collapse evidence entries', () => {
  const out = redact({ 'https://provider-a.invalid': { count: 1 }, 'https://provider-b.invalid': { count: 2 } });
  assert.equal(Object.keys(out).length, 2);
  assert.deepEqual(Object.values(out), [{ count: 1 }, { count: 2 }]);
});

test('large calldata is replaced by length and digest, not copied', () => {
  const value = '0x' + 'ab'.repeat(100);
  const out = redactText(value);
  assert(out.includes('bytes=100'));
  assert(!out.includes(value));
});
