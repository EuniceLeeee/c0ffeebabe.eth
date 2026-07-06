import { PROTOCOL_LEG_DESCRIPTORS } from "../../adapters/protocol-legs.js";

export type TemplateSlotKind = "flash" | "lend" | "swap" | "repay" | "guard";

export interface TemplateConstraint {
  type: "token-continuity" | "final-token-equals-start-token";
}

export interface TemplateSlot {
  id: string;
  kind: TemplateSlotKind;
  adapters: string[];
  min?: number;
  max?: number;
}

export interface PathTemplate {
  name: string;
  slots: TemplateSlot[];
  constraints: TemplateConstraint[];
}

const SWAP_ADAPTERS = [
  "psm",
  ...PROTOCOL_LEG_DESCRIPTORS.map((desc) => desc.id),
  "fluid-dex-swap",
  "univ4-unlock",
  "univ3-swap",
  "univ2-swap",
  "curve-exchange",
  "curve-exchange-nr",
  "curve-exchange-plain",
  "curve-exchange-received-uint",
];

export const FLASH_LEND_SWAP_REPAY: PathTemplate = {
  name: "flash-lend-swap-repay",
  slots: [
    { id: "flash", kind: "flash", adapters: ["morpho-flash", "balancer-flash"] },
    { id: "lend", kind: "lend", adapters: ["fluid-vault", "fluid-dex-liquidate"], min: 1, max: 4 },
    { id: "swap", kind: "swap", adapters: SWAP_ADAPTERS, min: 1, max: 8 },
    { id: "repay", kind: "repay", adapters: ["erc20-approve", "erc20-transfer"] },
    { id: "guard", kind: "guard", adapters: ["assert-balance"] },
  ],
  constraints: [
    { type: "token-continuity" },
    { type: "final-token-equals-start-token" },
  ],
};

export const FLASH_SWAP_REPAY: PathTemplate = {
  name: "flash-swap-repay",
  slots: [
    { id: "flash", kind: "flash", adapters: ["morpho-flash", "balancer-flash"] },
    { id: "swap", kind: "swap", adapters: SWAP_ADAPTERS, min: 1, max: 8 },
    { id: "repay", kind: "repay", adapters: ["erc20-approve", "erc20-transfer"] },
    { id: "guard", kind: "guard", adapters: ["assert-balance"] },
  ],
  constraints: [
    { type: "token-continuity" },
    { type: "final-token-equals-start-token" },
  ],
};
