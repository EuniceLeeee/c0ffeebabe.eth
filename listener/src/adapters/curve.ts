import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const ifaceWithReceiver = new ethers.Interface([
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
]);

const ifaceWithReceiverUint = new ethers.Interface([
  "function exchange_received(uint256 i, uint256 j, uint256 dx, uint256 min_dy, address receiver)",
]);

const ifaceNoReceiver = new ethers.Interface([
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy)",
]);

const ifacePlainExchange = new ethers.Interface([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
]);

const ifaceExchangeUnderlying = new ethers.Interface([
  "function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy)",
]);

const ifaceExecutePath = new ethers.Interface([
  "function executePath(bytes path, uint256[] amounts, address receiver)",
]);

/** Curve exchange_received with receiver param */
export const curveExchangeAdapter: ActionAdapter = {
  id: "curve-exchange",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const i = node.params.i as bigint;
    const j = node.params.j as bigint;
    const dx = node.amount;
    const minDy = node.params.minDy as bigint;
    const receiver = node.params.receiver as string;
    const calldata = ifaceWithReceiver.encodeFunctionData("exchange_received", [
      i, j, dx, minDy, receiver,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    // exchange_received(int128,int128,uint256,uint256,address)
    return selector === "0xafb43012";
  },
};

/** Curve exchange_received with uint256 indexes and receiver param */
export const curveExchangeReceivedUintAdapter: ActionAdapter = {
  id: "curve-exchange-received-uint",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const i = node.params.i as bigint;
    const j = node.params.j as bigint;
    const dx = node.amount;
    const minDy = node.params.minDy as bigint;
    const receiver = node.params.receiver as string;
    const calldata = ifaceWithReceiverUint.encodeFunctionData("exchange_received", [
      i, j, dx, minDy, receiver,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0x767691e7";
  },
};

/** Curve exchange_received without receiver param */
export const curveExchangeNoReceiverAdapter: ActionAdapter = {
  id: "curve-exchange-nr",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const i = node.params.i as bigint;
    const j = node.params.j as bigint;
    const dx = node.amount;
    const minDy = node.params.minDy as bigint;
    const calldata = ifaceNoReceiver.encodeFunctionData("exchange_received", [
      i, j, dx, minDy,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    // exchange_received(int128,int128,uint256,uint256) — 4 params, no receiver
    return selector === "0x7e3db030";
  },
};

/** Curve exchange(int128,int128,uint256,uint256) without receiver param */
export const curvePlainExchangeAdapter: ActionAdapter = {
  id: "curve-exchange-plain",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const i = node.params.i as bigint;
    const j = node.params.j as bigint;
    const dx = node.amount;
    const minDy = node.params.minDy as bigint;
    const calldata = ifacePlainExchange.encodeFunctionData("exchange", [
      i, j, dx, minDy,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0x3df02124";
  },
};

/** Curve exchange_underlying(int128,int128,uint256,uint256). */
export const curveExchangeUnderlyingAdapter: ActionAdapter = {
  id: "curve-exchange-underlying",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const calldata = ifaceExchangeUnderlying.encodeFunctionData("exchange_underlying", [
      node.params.i as bigint,
      node.params.j as bigint,
      node.amount,
      node.params.minDy as bigint,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0xa6417ed6";
  },
};

/** Curve router executePath(bytes,uint256[],address) leaf. */
export const curveRouterExecutePathAdapter: ActionAdapter = {
  id: "curve-router-execute-path",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const path = node.params.path as string;
    const amounts = node.params.amounts as bigint[];
    const receiver = node.params.receiver as string;
    const calldata = ifaceExecutePath.encodeFunctionData("executePath", [
      path, amounts, receiver,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0xcb70e273";
  },
};
