import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { getAddress, isHexString, keccak256 } from "ethers";
import type { AdapterRequest, CanonicalSource } from "../venues/adapter-request-program.js";

export interface RecordedFamilyReadWitness {
  readonly version: 1;
  readonly chainId: number;
  readonly source: CanonicalSource;
  readonly executor: string;
  readonly rounds: readonly { readonly name: string; readonly reads: readonly {
    readonly id: string; readonly kind: "eth-call" | "get-storage" | "get-code"; readonly target: string;
    readonly selector?: string; readonly calldata?: string; readonly from?: string | null;
    readonly slot?: string; readonly resultHash: string; readonly provisioning?: "historical-harness-runtime";
  }[] }[];
  readonly responses: Readonly<Record<string, string | { readonly encoding: "gzip-base64"; readonly byteLength: number; readonly data: string }>>;
}

type Caller = NonNullable<Extract<AdapterRequest, { kind: "eth-call" }>["caller"]>;
const address = (a: string) => getAddress(a).toLowerCase();

/** One issuer invocation. Rounds and requests are matched in their original order.
 * IDs are additional checks; they never select the response. */
export function createRecordedFamilyReadReplay(fixture: RecordedFamilyReadWitness, expected: {
  source: CanonicalSource; chainId: number; resolveCaller: (caller: Caller) => string;
}) {
  assert.equal(fixture.version, 1);
  assert.equal(fixture.chainId, expected.chainId);
  assert.deepEqual(fixture.source, expected.source);
  const bodies = new Map<string, string>();
  for (const [hash, encoded] of Object.entries(fixture.responses)) {
    let data: string;
    if (typeof encoded === "string") data = encoded;
    else {
      assert.equal(encoded.encoding, "gzip-base64");
      assert(Number.isSafeInteger(encoded.byteLength) && encoded.byteLength > 0 && encoded.byteLength <= 2 ** 22);
      const bytes = gunzipSync(Buffer.from(encoded.data, "base64"), { maxOutputLength: encoded.byteLength });
      assert.equal(bytes.length, encoded.byteLength);
      data = "0x" + bytes.toString("hex");
    }
    assert(isHexString(data, true));
    assert.equal(keccak256(data), hash, "recorded response hash mismatch");
    bodies.set(hash, data);
  }
  const usedBodies = new Set<string>();
  let index = 0;
  return {
    readRound(requests: readonly AdapterRequest[]) {
      const round = fixture.rounds[index];
      assert(round, "unexpected read round");
      assert.equal(requests.length, round.reads.length, "recorded read count differs in " + round.name);
      const values = requests.map((request, i) => {
        const row = round.reads[i]!;
        assert.equal(request.kind, row.kind, "physical request kind differs in " + round.name);
        assert.equal(request.id, row.id, "recorded request order/ID differs in " + round.name);
        let key: string;
        if (request.kind === "eth-call") {
          assert.equal(address(request.to), address(row.target));
          assert.equal(request.data.toLowerCase(), row.calldata);
          assert.equal(request.data.slice(0, 10).toLowerCase(), row.selector);
          const caller = request.caller ? address(expected.resolveCaller(request.caller)) : null;
          assert.equal(caller, row.from);
          key = ["eth-call", address(request.to), row.calldata, caller ?? ""].join("|");
        } else if (request.kind === "get-storage") {
          assert.equal(address(request.address), address(row.target));
          assert(isHexString(row.slot, 32)); assert.equal(request.slot.toLowerCase(), row.slot);
          key = ["get-storage", address(request.address), row.slot].join("|");
        } else if (request.kind === "get-code") {
          assert.equal(address(request.address), address(row.target));
          key = ["get-code", address(request.address)].join("|");
        } else throw new Error("recorded Family read requires a supported read transport");
        const data = bodies.get(row.resultHash);
        assert.notEqual(data, undefined, "missing recorded response for " + row.id);
        usedBodies.add(row.resultHash);
        return { id: row.id, key, data: data!, provisioning: row.provisioning };
      });
      index++;
      return values;
    },
    finish() {
      assert.equal(index, fixture.rounds.length, "unused recorded read round");
      assert.equal(usedBodies.size, bodies.size, "unused recorded response body");
    },
  };
}
