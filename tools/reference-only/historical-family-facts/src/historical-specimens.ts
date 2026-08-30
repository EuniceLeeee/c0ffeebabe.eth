import type { Hash } from "../../../../packages/canonical-codec/src/index.ts";

export type FrozenHistoricalFamilyIdV1 =
  | "curve-underlying"
  | "dodo-v2"
  | "fluid-dex"
  | "univ2-standard"
  | "univ4"
  | "angstrom-v4";

export interface FrozenHistoricalFamilyLocatorV1 {
  readonly familyId: FrozenHistoricalFamilyIdV1;
  readonly manifestRoot: Hash;
  readonly txHash: Hash;
  readonly canonicalBlockHash: Hash;
  readonly framePath?: readonly string[];
  readonly frameSelector?: string;
  readonly frameTarget?: string;
  readonly eventEmitter?: string;
  readonly eventTopic0?: Hash;
  readonly eventLogIndex?: string;
}

/** Exact immutable-CAS locators; never an admission allowlist or release oracle. */
export const FROZEN_HISTORICAL_FAMILY_LOCATORS_V1: readonly FrozenHistoricalFamilyLocatorV1[] = Object.freeze([
  Object.freeze({ familyId: "curve-underlying", manifestRoot: "0x15bcdb923bd656196fb6bf227fc3f47f740d4d8f4e89f7a63327f643129e6c5b", txHash: "0x149df3ec17a6044e0c66c25aa55ce044abe33bf14cedea26295e1b6d4c9fde60", canonicalBlockHash: "0x5a1cbd6b472206d2c695f4960d177e5b78188ac277c441f4a60da71ce7ede3fa", framePath: Object.freeze(["0", "3", "4"]), frameSelector: "0xa6417ed6", frameTarget: "0xfe0a8e9d60131404ffaee95b48ebf908f4d8d808", eventEmitter: "0xfe0a8e9d60131404ffaee95b48ebf908f4d8d808", eventTopic0: "0xd013ca23e77a65003c2c659c5442c00c805371b7fc1ebd4c206c41d1536bd90b", eventLogIndex: "0x1d7" }),
  Object.freeze({ familyId: "dodo-v2", manifestRoot: "0x4c05aa01aaf0c63d2becccc367e49442268fb3bf5f5be0c071b8292ae0ca3b99", txHash: "0xdc52761ffb79eaf37df696b3ed0eff0e7befbec224caaecf61a7a68f0e2cdfc4", canonicalBlockHash: "0x90e8b454a84230787647ae09c34238823904c38a53329b9a5e6c55b896c0b84c", framePath: Object.freeze(["0", "3", "10"]), frameSelector: "0xdd93f59a", frameTarget: "0xa057613074e335acbfedb364573f53f3801399be", eventEmitter: "0xa057613074e335acbfedb364573f53f3801399be", eventTopic0: "0xc2c0245e056d5fb095f04cd6373bc770802ebd1e6c918eb78fdef843cdb37b0f", eventLogIndex: "0x25e" }),
  Object.freeze({ familyId: "fluid-dex", manifestRoot: "0x9bd03723469a26ceb826038783348a5577d31c72f548a864545104f71917f4b3", txHash: "0xbd30e0b400d101183b52154c37b085f8a5a0cd35929ffbbf3d3d5145adb14ab6", canonicalBlockHash: "0x154711a7d062ba8c9f38a7aece109beccc079384b6c7f0d3ab75929c77e0c6a7", framePath: Object.freeze(["0", "5", "1", "2"]), frameSelector: "0x2668dfaa", frameTarget: "0x667701e51b4d1ca244f17c78f7ab8744b4c99f9b", eventEmitter: "0x667701e51b4d1ca244f17c78f7ab8744b4c99f9b", eventTopic0: "0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7", eventLogIndex: "0x277" }),
  Object.freeze({ familyId: "univ2-standard", manifestRoot: "0x687f562d19c0e1e0aa939d7c81067b5b283f0d5b1f44408664e1474ee136c259", txHash: "0x0ffa9acf81b5631ac91d1c141adbbe884ad0bdd991143bd13cd10eacc2fc8454", canonicalBlockHash: "0x58202b31ed2ba7d3410860d8e345da2c3c4e7a94ba8526141e621e32361d4cf7" }),
  Object.freeze({ familyId: "univ4", manifestRoot: "0x40ccc7c1024ad205fe5fbdd6fdb851788d03479721aa3b52590b94efc066976c", txHash: "0x3db0570bd5e80759d43344842f655cab0a3954cfc24132276aa0741dd09cf5ca", canonicalBlockHash: "0x6c4964b47c2cf9a1b82cc63f01083c18f30961ed85357a43b83bb9e970b40644", framePath: Object.freeze(["2", "0", "0"]), frameSelector: "0xf3cd914c", frameTarget: "0x000000000004444c5dc75cb358380d2e3de08a90", eventEmitter: "0x000000000004444c5dc75cb358380d2e3de08a90", eventTopic0: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", eventLogIndex: "0x46c" }),
  Object.freeze({ familyId: "angstrom-v4", manifestRoot: "0xffaef59267211e4839e946e42317f923a0a9ed762f2991ab0737da1ee5d64787", txHash: "0x9c4c0a7d0fb210d02779e0cb5cc2ba637c3d7e68cb30374ed3c5bc83a64db457", canonicalBlockHash: "0x899b1d8a74772c9060405fd37577c08e31063cb4a067ac951604b42f4378d7c8", framePath: Object.freeze(["0", "2", "2", "0", "2", "3"]), frameSelector: "0xa88f90c1", frameTarget: "0xb535aeb27335b91e1b5bccbd64888ba7574efbf8", eventEmitter: "0x000000000004444c5dc75cb358380d2e3de08a90", eventTopic0: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", eventLogIndex: "0xcf" }),
]);
