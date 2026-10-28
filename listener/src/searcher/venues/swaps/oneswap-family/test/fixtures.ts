import { instanceKey } from "../../../adapter-family-identifiers.js";
import { ID, LINEAGE } from "../manifest.js";
import type { Descriptor } from "../types.js";
/** Retained real N26130639 descriptor, offline fixture only; not current admission. */
export function descriptor(): Descriptor { return {
  "codeHash": "0xf4f3d71d4189d732ff36e27397ed799ae9fea7f2a186e717a18cb014f0adbaf6",
  "factory": "0x5ed3c9089ed0355bc77cf439dc2ed28c4054c8c4",
  "factoryCodeHash": "0x73f0f18337ad08b19811b3b3d69bc37db992676fc2f6c573df728f628b8968f5",
  "familyId": ID,
  "implementation": "0x4e3e0852d664b671222384d654d789b2434a9446",
  "implementationCodeHash": "0xc52fb497f537ad9cd34c67b27a1dca7b5d31f13a78b6e004b7ee1101af0171d1",
  "instanceKey": instanceKey("0x1025f2334e88a4a0e93e5e2ff4a4e67317682b60"),
  "isOnlySwap": true,
  "lineageId": LINEAGE,
  "money": "0x0000000000000000000000000000000000000000",
  "ones": "0x0b342c51d1592c41068d5d4b4da4a68c0a04d5a4",
  "pool": "0x1025f2334e88a4a0e93e5e2ff4a4e67317682b60",
  "priceDiv": 1n,
  "priceMul": 1n,
  "provenance": [
    {
      "evidenceHash": "714aad2ec4947f1d824a4d5476af6dbbdf5b620106f59ee8e7ad6f77db6cfbe5",
      "kind": "oneswap-verified-proxy-factory-registration-implementation",
      "subject": "0x5ed3c9089ed0355bc77cf439dc2ed28c4054c8c4"
    }
  ],
  "runtimeRequirements": [
    {
      "freshness": "pinned-block",
      "kind": "source-state"
    }
  ],
  "stock": "0x0b342c51d1592c41068d5d4b4da4a68c0a04d5a4",
  "stockUnit": 100000000000000n
}; }
