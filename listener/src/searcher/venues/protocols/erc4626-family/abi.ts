// Compatibility constants are derived from the declaration, never a second ABI.
import { Interface, getAddress } from "ethers";
import definition from "./erc4626.json";
const identity = definition.identity.definition;
const discovery = definition.discovery.definition;
export const ERC4626_INTERFACE = new Interface(identity.abi.vault);
export const ERC4626_ERC20_INTERFACE = new Interface(identity.abi.token);
export const ERC4626_PROBE_ACTOR = getAddress(identity.parameters.constants.actor);
export const ERC4626_SAMPLE_AMOUNTS = identity.parameters.constants.samples.map(BigInt);
export const ERC4626_DEPOSIT_CALL_PATTERN_ID = discovery.calls[0]!.id;
export const ERC4626_REDEEM_CALL_PATTERN_ID = discovery.calls[1]!.id;
export const ERC4626_DEPOSIT_LOG_PATTERN_ID = discovery.events[0]!.id;
export const ERC4626_WITHDRAW_LOG_PATTERN_ID = discovery.events[1]!.id;
export const ERC4626_SURFACE_PATTERN_ID = discovery.surface.id;
export const ERC4626_DEPOSIT_TOPIC = ERC4626_INTERFACE.getEvent(discovery.events[0]!.signature)!.topicHash.toLowerCase();
export const ERC4626_WITHDRAW_TOPIC = ERC4626_INTERFACE.getEvent(discovery.events[1]!.signature)!.topicHash.toLowerCase();
