import { ethers } from "ethers";
import type { IdentitySemantics } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  BEACON,
  ERC1967_IMPLEMENTATION_SLOT,
  IMPLEMENTATION_CODE_HASH,
  PAIR,
  PROXY_BEACON_SLOT,
  PROXY_CODE_HASH,
  TOKEN,
  address,
  beaconCall,
  call,
  code,
  key,
  read,
  sourceOf,
  storageAddress,
  tokenCall,
} from "./codec.js";
import { ID, LINEAGE } from "./manifest.js";
import type { Binding, Candidate, Identity } from "./types.js";

type Proof =
  | { readonly phase: "rejected"; readonly source: CanonicalSource; readonly reasonCode: string; readonly ids: readonly string[] }
  | { readonly phase: "code"; readonly source: CanonicalSource; readonly ids: readonly string[] }
  | {
    readonly phase: "proxy"; readonly source: CanonicalSource; readonly ids: readonly string[];
    readonly beacon: string; readonly implementation: string;
  }
  | {
    readonly phase: "surface"; readonly source: CanonicalSource; readonly ids: readonly string[];
    readonly beacon: string; readonly implementation: string;
    readonly tokenX: string; readonly tokenY: string;
  }
  | { readonly phase: "complete"; readonly source: CanonicalSource; readonly ids: readonly string[]; readonly facts: Binding };

const CODE_IDS = ["pair-code"] as const;
const PROXY_IDS = ["beacon-slot", "implementation-slot"] as const;
const PAIR_IDS = ["beacon-implementation", "implementation-code", "underlying-tokens", "reserves", "references"] as const;
const TOKEN_IDS = ["token-x-code", "token-y-code", "decimals-x", "decimals-y"] as const;

/**
 * Ammalgam pairs are `PairBeaconProxy` instances whose implementation is
 * installed by a shared beacon. Identity pins, in four rounds:
 *   1. the proxy runtime code (a beacon proxy, not an arbitrary `swap` clone),
 *   2. the beacon slot and the cached ERC-1967 implementation slot,
 *   3. the beacon's current implementation equals the cached one, its runtime
 *      code hash equals the verified `AmmalgamPair` runtime, and the pair
 *      surface (`underlyingTokens`, reserves, reference reserves) is sane,
 *   4. both token runtimes and decimals.
 * No instance allowlist and no factory-creation claim: the pair exposes no
 * factory getter, so this family does not assert CREATE2 provenance.
 */
export const identity = {
  memoReuse: "recheck-identity",
  identityKey: (value: Identity) => key(value.facts),
  variants: [{
    id: "pair-beacon-proxy-verified-implementation",
    kind: "standalone-contract",
    lineageId: LINEAGE,
    applies: (candidate: Candidate) => candidate.candidateKind === "ammalgam-pair",
    requirements({ evidence }) {
      const prior = evidence as Proof | undefined;
      if (prior === undefined) return { transports: ["get-code" as const] };
      if (prior.phase === "code") return { transports: ["get-storage" as const] };
      if (prior.phase === "proxy" || prior.phase === "surface") {
        return { transports: ["get-code" as const, "eth-call" as const] };
      }
      return { transports: [] };
    },
    buildRequests({ candidate: c, evidence }) {
      const prior = evidence as Proof | undefined;
      const pair = address(c.pair);
      if (prior === undefined) return [code(CODE_IDS[0], pair)];
      if (prior.phase === "code") {
        return [
          { id: PROXY_IDS[0], kind: "get-storage" as const, address: ethers.getAddress(pair), slot: PROXY_BEACON_SLOT },
          { id: PROXY_IDS[1], kind: "get-storage" as const, address: ethers.getAddress(pair), slot: ERC1967_IMPLEMENTATION_SLOT },
        ];
      }
      if (prior.phase === "proxy") {
        return [
          beaconCall(PAIR_IDS[0], prior.beacon),
          code(PAIR_IDS[1], prior.implementation),
          call(PAIR_IDS[2], pair, "underlyingTokens"),
          call(PAIR_IDS[3], pair, "getReserves"),
          call(PAIR_IDS[4], pair, "referenceReserves"),
        ];
      }
      if (prior.phase === "surface") {
        return [
          code(TOKEN_IDS[0], prior.tokenX),
          code(TOKEN_IDS[1], prior.tokenY),
          tokenCall(TOKEN_IDS[2], prior.tokenX, "decimals"),
          tokenCall(TOKEN_IDS[3], prior.tokenY, "decimals"),
        ];
      }
      return [];
    },
    decode({ step, results }): Proof {
      const prior = step.evidence as Proof | undefined;
      const pair = address(step.candidate.pair);
      if (prior === undefined) {
        const source = sourceOf(results);
        if (results.length !== CODE_IDS.length) throw new Error("ammalgam identity code read set");
        const proxyCode = results[0].ok ? results[0].data : "0x";
        if (ethers.keccak256(proxyCode) !== PROXY_CODE_HASH) {
          return { phase: "rejected", source, reasonCode: "ammalgam-proxy-runtime-unsupported", ids: CODE_IDS };
        }
        return { phase: "code", source, ids: CODE_IDS };
      }
      if (prior.phase === "rejected" || prior.phase === "complete") {
        throw new Error("ammalgam identity continued after a terminal phase");
      }
      if (prior.phase === "code") {
        const source = sourceOf(results, prior.source);
        if (results.length !== PROXY_IDS.length) throw new Error("ammalgam identity proxy read set");
        const beacon = storageAddress(results, PROXY_IDS[0]);
        const implementation = storageAddress(results, PROXY_IDS[1]);
        if (beacon === ethers.ZeroAddress.toLowerCase() || implementation === ethers.ZeroAddress.toLowerCase()) {
          return { phase: "rejected", source, reasonCode: "ammalgam-proxy-beacon-slot-empty", ids: PROXY_IDS };
        }
        return { phase: "proxy", source, ids: PROXY_IDS, beacon, implementation };
      }
      if (prior.phase === "proxy") {
        const source = sourceOf(results, prior.source);
        if (results.length !== PAIR_IDS.length) throw new Error("ammalgam identity pair read set");
        const beaconImplementation = address(read(results, PAIR_IDS[0], BEACON, "implementation")[0] as string);
        const implementationCode = results.find(result => result.id === PAIR_IDS[1]);
        if (!implementationCode?.ok) throw new Error("ammalgam implementation code read failed");
        if (beaconImplementation !== prior.implementation ||
            ethers.keccak256(implementationCode.data) !== IMPLEMENTATION_CODE_HASH) {
          return { phase: "rejected", source, reasonCode: "ammalgam-beacon-implementation-mismatch", ids: PAIR_IDS };
        }
        const tokens = read(results, PAIR_IDS[2], PAIR, "underlyingTokens");
        const tokenX = address(tokens[0] as string);
        const tokenY = address(tokens[1] as string);
        const reserves = read(results, PAIR_IDS[3], PAIR, "getReserves");
        const references = read(results, PAIR_IDS[4], PAIR, "referenceReserves");
        if (tokenX === tokenY || reserves[0] <= 0n || reserves[1] <= 0n ||
            references[0] <= 0n || references[1] <= 0n) {
          return { phase: "rejected", source, reasonCode: "ammalgam-pair-surface-invalid", ids: PAIR_IDS };
        }
        return {
          phase: "surface", source, ids: PAIR_IDS,
          beacon: prior.beacon, implementation: prior.implementation, tokenX, tokenY,
        };
      }
      if (prior.phase !== "surface") throw new Error("ammalgam identity unexpected phase");
      const source = sourceOf(results, prior.source);
      if (results.length !== TOKEN_IDS.length) throw new Error("ammalgam identity token read set");
      const tokenXCode = results.find(result => result.id === TOKEN_IDS[0]);
      const tokenYCode = results.find(result => result.id === TOKEN_IDS[1]);
      if (!tokenXCode?.ok || !tokenYCode?.ok || tokenXCode.data === "0x" || tokenYCode.data === "0x") {
        return { phase: "rejected", source, reasonCode: "ammalgam-token-runtime-missing", ids: TOKEN_IDS };
      }
      const decimalsX = read(results, TOKEN_IDS[2], TOKEN, "decimals")[0] as bigint;
      const decimalsY = read(results, TOKEN_IDS[3], TOKEN, "decimals")[0] as bigint;
      if (decimalsX > 77n || decimalsY > 77n) {
        return { phase: "rejected", source, reasonCode: "ammalgam-token-decimals-invalid", ids: TOKEN_IDS };
      }
      return {
        phase: "complete", source, ids: TOKEN_IDS,
        facts: {
          pair,
          beacon: prior.beacon,
          implementation: prior.implementation,
          proxyCodeHash: PROXY_CODE_HASH,
          implementationCodeHash: IMPLEMENTATION_CODE_HASH,
          tokenX: prior.tokenX,
          tokenY: prior.tokenY,
          decimalsX,
          decimalsY,
        },
      };
    },
    decide({ evidence }) {
      const prior = evidence as Proof | undefined;
      if (prior?.phase === "rejected") {
        return { status: "chain-proven-rejected" as const, reasonCode: prior.reasonCode, evidenceRequestIds: [...prior.ids] };
      }
      if (prior?.phase !== "complete") return { status: "continue" as const };
      return {
        status: "verified" as const,
        identity: {
          familyId: ID,
          lineageId: LINEAGE,
          subject: prior.facts.pair,
          facts: prior.facts,
          provenance: [{
            kind: "ammalgam-pair-beacon-implementation-and-underlying-tokens",
            subject: prior.facts.implementation,
            evidenceHash: hashCanonical({
              facts: {
                pair: prior.facts.pair,
                beacon: prior.facts.beacon,
                implementation: prior.facts.implementation,
                proxyCodeHash: prior.facts.proxyCodeHash,
                implementationCodeHash: prior.facts.implementationCodeHash,
                tokenX: prior.facts.tokenX,
                tokenY: prior.facts.tokenY,
                decimalsX: prior.facts.decimalsX,
                decimalsY: prior.facts.decimalsY,
              },
              source: { ...prior.source },
            }),
          }],
        },
      };
    },
  }],
} satisfies IdentitySemantics<Candidate, Identity>;
