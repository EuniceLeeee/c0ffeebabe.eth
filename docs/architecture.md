# MEV Flash Arbitrage — Architecture / 架构文档

## 1. Project Summary / 项目概述

研究和复现以太坊主网上的 MEV 套利策略。核心案例：**wstUSR 脱锚套利**。

Study and replicate MEV arbitrage strategies on Ethereum mainnet forks.
Primary case study: **wstUSR depegging arbitrage**.

Reference tx: `0xf88b498b...970`, block 24710788. Profit: ~273 wstUSR + ~0.078 WETH.

### Arbitrage Flow / 套利路径

```
Morpho flash loan (3,533 wstUSR)
  ├─ Fluid Vault ×2: deposit wstUSR → borrow USDC (total 3,679 USDC)
  ├─ Sky PSM: USDC → DAI (1:1)
  ├─ Uniswap V4: DAI → USDT
  ├─ Uniswap V3 #1: USDT → WETH (parallel leg, profits ~0.078 WETH)
  ├─ Uniswap V3 #2: WETH → USDT
  ├─ Curve chain: USDT → sUSDS → DOLA → wstUSR (3,806 wstUSR)
  └─ Repay flash loan (3,533 wstUSR), keep profit (~273 wstUSR)
```

---

## 2. Directory Layout / 目录结构

```
MEV/
├── src/                          # On-chain contracts (deployable)
│   ├── BotVM.sol                 # VM interpreter — executes packed opcode scripts
│   ├── BotVMEncoder.sol          # Opcode encoding library (route-agnostic)
│   ├── BotVMScriptBuilder.sol    # Builds wstUSR arb scripts for BotVM
│   ├── FlashArb.sol              # Readable Solidity arb (alternative to BotVM)
│   ├── Constants.sol             # All on-chain addresses, block numbers
│   └── interfaces/
│       ├── IERC20.sol
│       ├── IFluidVault.sol
│       ├── IMorpho.sol
│       └── ISwap.sol             # Curve, Uniswap V3/V4, Sky PSM, Chainlink
│
├── script/                       # Forge scripts (fork-only, never broadcast)
│   ├── AutoBackrun.s.sol         # ★ Main 8-phase automated pipeline
│   ├── BackrunReplay.s.sol       # Standalone replay of the reference tx
│   ├── Simulate.s.sol            # Simple simulation script
│   ├── SimulateBotVM.s.sol       # BotVM-specific simulation
│   └── helpers/                  # Compositional pipeline building blocks
│       ├── Types.sol             # All data structures and enums
│       ├── Detector.sol          # Phase 2-3: opportunity detection
│       ├── ModuleRegistry.sol    # Phase 4 input: available action modules
│       ├── PathComposer.sol      # Phase 4: DFS path discovery
│       ├── CompilerAdapter.sol   # Phase 5: filter supported shapes + compile
│       ├── ParamSolver.sol       # Phase 5: fill params by ratio scaling
│       ├── CaptureArbSim.sol     # Phase 6 helper: capture intermediate values
│       ├── Simulator.sol         # Phase 6: simulate BotVM execution
│       ├── Optimizer.sol         # Optional: grid scan + ternary search
│       └── LocalOrderedReplay.sol # Phase 7.5: ordered historical tx replay
│
├── test/
│   ├── WstUSRArb.t.sol           # Fork tests: replay arb, verify profits
│   └── BotVM.t.sol               # BotVM unit tests: opcodes, state, edge cases
│
├── listener/                     # TypeScript live mempool listener (dry-run)
│   ├── src/
│   │   ├── index.ts              # Entry: WebSocket subscription + event loop
│   │   ├── filter.ts             # Decode pending tx, detect target swaps
│   │   ├── simulator.ts          # Fork + forge script orchestration
│   │   └── types.ts              # Shared TypeScript types
│   ├── package.json
│   └── tsconfig.json
│
├── docs/
│   ├── architecture.md           # ← This file
│   └── historical-replay.md      # Ordered tx replay reference
│
└── foundry.toml                  # via_ir=true, solc 0.8.24, cancun EVM
```

---

## 3. Layer Architecture / 分层架构

```
┌──────────────────────────────────────────────────────┐
│                  listener/ (TypeScript)                │
│    WebSocket → filter pending tx → spawn forge script  │
│    (dry-run only, no submission)                       │
└─────────────────────┬────────────────────────────────┘
                      │ shell: forge script AutoBackrun
┌─────────────────────▼────────────────────────────────┐
│              AutoBackrun.s.sol (8-Phase Pipeline)      │
│  Phase 1: Replay  │  Phase 2-3: Detect               │
│  Phase 4: DFS     │  Phase 5: Filter+Fill             │
│  Phase 6: Simulate│  Phase 7: Score (net PnL)         │
│  Phase 7.5: Ordered Replay │  Phase 8: Report         │
└─────────────────────┬────────────────────────────────┘
                      │ calls
┌─────────────────────▼────────────────────────────────┐
│                   BotVM.sol (Runtime)                  │
│    10 opcodes, TSLOT 0x1337 state, fallback callbacks │
│    ← script built by BotVMScriptBuilder               │
│    ← opcodes encoded by BotVMEncoder                  │
└──────────────────────────────────────────────────────┘
```

---

## 4. Core Components Detail / 核心组件详解

### 4.1 BotVM — Script Interpreter / 脚本解释器

**File**: `src/BotVM.sol` (292 lines)

逆向工程自链上 MEV bot `0xE08D...015`。10 个操作码的自定义 VM，通过 packed byte stream 驱动。

Reverse-engineered from on-chain MEV bot. Custom 10-opcode VM driven by packed byte scripts.

**Opcodes:**

| Op | Name | Layout | Function |
|----|------|--------|----------|
| `0x00` | CALL | `[addr:20][len:3][payload:N]` | External call (no ETH) |
| `0x01` | CALL_VALUE | `[addr:20][value:12][len:3][payload:N]` | External call with ETH |
| `0x02` | SET_FIELD2 | `[offset:3]` | Set callback resume offset |
| `0x03` | RETURN | `[len:3][data:N]` | Return data to caller |
| `0x04` | WETH_UNWRAP | (none) | Unwrap all WETH balance |
| `0x05` | CLEAR_STATE | (none) | Clear field2 + field3 |
| `0x06` | SET_FIELD3 | `[offset:3]` | Set auxiliary offset |
| `0x07` | CLEAR_FIELD1 | (none) | Clear callback flag |
| `0x08` | ASSERT_BALANCE_GTE | `[token:20][threshold:32]` | Min profit guard |
| `0x0d` | REVERT | `[len:3][data:N]` | Revert with data |

**TSLOT 0x1337 State Register** (transient storage):

```
 ┌─────────┬──────────┬──────────┐
 │ field1  │ field2   │ field3   │
 │ 1 byte  │ 3 bytes  │ 3 bytes  │
 │ cb_flag │ resume   │ auxiliary│
 └─────────┴──────────┴──────────┘
```

**Entry Points:**

```
execute(script)      ← owner calls (main entry)
execSubscript(script)← self-call (opcode 0x00 calling self)
fallback()           ← protocol callback (reads field2 for sub-script offset)
```

**Callback nesting pattern:**

```solidity
// Top script:
SET_FIELD2(100)       // offset for Morpho callback
CALL(Morpho.flashLoan(..., innerScript))
CLEAR_STATE

// Morpho calls back → fallback() reads field2=100 → extracts innerScript → runs VM
// innerScript:
SET_FIELD2(68)        // offset for V4 callback
CALL(V4.unlock(..., v4Script))
CLEAR_STATE
// ... and so on, arbitrarily deep
```

### 4.2 BotVMEncoder — Opcode Encoding / 操作码编码

**File**: `src/BotVMEncoder.sol` (70 lines)

Pure library. Route-agnostic — encodes individual opcodes into packed bytes:

```solidity
BotVMEncoder.encodeCall(target, payload)          // → 0x00 ++ addr ++ len ++ payload
BotVMEncoder.encodeSetField2(100)                 // → 0x02 ++ 0x000064
BotVMEncoder.encodeAssertBalanceGte(token, 50e18) // → 0x08 ++ token ++ threshold
```

### 4.3 BotVMScriptBuilder — Route-Specific Script Builder / 路由脚本构建

**File**: `src/BotVMScriptBuilder.sol` (298 lines)

Builds the complete nested callback tree for the wstUSR arb route:

```
buildWstUsrArbScript(params, executor) → packed bytes
  ├─ _buildMorphoSubScript()    # Flash loan callback: Fluid borrow → PSM → V4 → V3 → profit check
  ├─ _buildV4SubScript()        # V4 unlock callback: DAI→USDT swap → V3#1 → settle
  └─ _buildCurveChainScript()   # V3 callback: USDT→sUSDS→DOLA→wstUSR + pay WETH
```

**Input** (`WstUsrArbParams`):

| Field | Source | Description |
|-------|--------|-------------|
| `flashAmount` | ParamSolver | Morpho flash loan amount (wstUSR) |
| `debtAmount1/2` | ParamSolver | Fluid borrow amounts (USDC) |
| `v4TakeAmount` | ParamSolver | USDT to take from V4 |
| `v3ExactOutput` | ParamSolver | USDT exact output for V3 #2 |
| `daiAmount` | CaptureArbSim | DAI received from PSM (intermediate) |
| `usdtReceived` | CaptureArbSim | USDT from V3 (intermediate) |
| `wethOwed` | CaptureArbSim | WETH to pay V3 (intermediate) |
| `susdsOut` | CaptureArbSim | sUSDS from Curve (intermediate) |
| `dolaAmount` | CaptureArbSim | DOLA from Curve (intermediate) |
| `minProfit` | PathComposer | Min wstUSR profit (revert guard) |

### 4.4 FlashArb — Readable Solidity Alternative / 可读 Solidity 版本

**File**: `src/FlashArb.sol` (211 lines)

Same arb logic, but as readable Solidity with named functions and Solidity-level callbacks. Used for understanding and testing. BotVM is what the real MEV bot uses.

相同套利逻辑，但用可读 Solidity 实现。用于理解和测试。真正的 MEV bot 用 BotVM。

---

## 5. AutoBackrun Pipeline — 8 Phases / 自动回跑 8 阶段流水线

**File**: `script/AutoBackrun.s.sol` (323 lines)

Inherits: `Script` + `SimulatorBase` + `LocalOrderedReplayBase`

### Phase 1: Replay / 回放

```
ReplayMode.TRIGGER → vm.transact(TX0) only (victim tx)
ReplayMode.EXACT   → vm.transact(TX0..TX7) all 8 prefix txs
ReplayMode.LIVE    → disabled (vm.transact can't replay pending txs)
```

Sets fork to block 24710787, rolls to 24710788, warps timestamp. Saves `preReplaySnap` for Phase 7.5.

### Phase 2-3: Detector / 机会检测

**File**: `script/helpers/Detector.sol` (29 lines)

```solidity
spotQuote = ICurvePool(CURVE_DOLA_WSTUSR).get_dy(0, 1, 1e18);  // 1 DOLA → ? wstUSR
gapBps = (spotQuote - fairQuote) * 10000 / fairQuote;
isOpportunity = gapBps >= MIN_GAP_BPS (100 bps)
```

When wstUSR is depegged (trading below fair value), 1 DOLA buys more than 1 wstUSR → gap > 0.

### Phase 4: PathComposer — DFS Path Discovery / DFS 路径搜索

**File**: `script/helpers/PathComposer.sol` (150 lines)

```
Input:  ModuleRegistry.getModules() → 8 action modules
Output: CandidatePath[] with step sequences

DFS rules:
  - Start token: borrowMod.tokenOut (USDC)
  - Target token: flashMod.tokenIn (wstUSR)
  - Edge (moduleId) not repeated
  - Token CAN repeat (USDT → WETH → USDT is valid)
  - Max depth: 6
  - Two-pass: count first, then fill
```

**Module graph:**

```
FLASH_LOAN: wstUSR ──→ wstUSR (Morpho)
BORROW:     wstUSR ──→ USDC   (Fluid)
SWAP:       USDC   ──→ DAI    (Sky PSM)
SWAP:       DAI    ──→ USDT   (UniV4)
SWAP:       USDT   ──→ WETH   (UniV3 forward)
SWAP:       WETH   ──→ USDT   (UniV3 reverse)
SWAP:       USDT   ──→ DOLA   (Curve sUSDS chain)
SWAP:       DOLA   ──→ wstUSR (Curve DOLA/wstUSR)
```

DFS finds path: `USDC → DAI → USDT → WETH → USDT → DOLA → wstUSR` (6 swaps).
Full candidate: `[FLASH, BORROW, PSM, V4, V3_FWD, V3_REV, CURVE1, CURVE2]` = 8 steps.

### Phase 5: CompilerAdapter + ParamSolver / 编译过滤 + 参数填充

**CompilerAdapter** (`script/helpers/CompilerAdapter.sol`, 57 lines):

The ONLY file that imports `BotVMScriptBuilder`. Acts as boundary:

```solidity
function isSupportedShape(path) → bool
  // Must be exactly [FLASH, BORROW, PSM, V4, V3_FWD, V3_REV, CURVE1, CURVE2]

function compile(path, params, executor) → bytes
  // Delegates to BotVMScriptBuilder.buildWstUsrArbScript()
```

**ParamSolver** (`script/helpers/ParamSolver.sol`, 25 lines):

Ratio-scales parameters from reference tx:

```solidity
debtAmount = BASE_DEBT × flashAmount / BASE_FLASH
v4TakeAmount = BASE_V4_TAKE × flashAmount / BASE_FLASH
...
```

### Phase 6: Simulator / 模拟执行

**File**: `script/helpers/Simulator.sol` (120 lines)

Abstract contract `SimulatorBase`. Two-phase simulation:

```
Phase A: CaptureArbSim
  ├─ Deploy fresh CaptureArbSim contract
  ├─ Execute full arb (Morpho flash → Fluid → swaps → Curve)
  ├─ Read intermediate values (daiAmount, usdtReceived, wethOwed, susdsOut, dolaAmount)
  └─ Revert state (inner snapshot)

Phase B: BotVM execution on clean state
  ├─ Build WstUsrArbParams from Phase A intermediates
  ├─ Compile script via CompilerAdapter
  ├─ Deploy BotVM (or use deployed address)
  ├─ BotVM.execute(script)
  ├─ Read wstUSR/WETH profit balances
  ├─ Compute net PnL (gas + builder tip + wstUSR→WETH conversion)
  └─ Revert state (outer snapshot)
```

**ExecutionConfig** branching:

```
executor == address(0) → new BotVM() (fork-deploy, temp address)
executor != address(0) → use real deployed BotVM, vm.prank(owner)
```

**Net PnL calculation:**

```solidity
gasCostWei = gasUsed × gasPriceWei
wstUsrProfitWethValue = wstUsrProfit × wstUsrToWethPriceE18 / 1e18
grossWethValue = wethProfit + wstUsrProfitWethValue
requiredWeth = gasCostWei + builderTipWei + minNetProfitWethWei
coversNetProfit = grossWethValue >= requiredWeth
netTotalWethProfit = grossWethValue - gasCostWei - builderTipWei
```

### Phase 7: Score / 评分

```solidity
for each candidate:
  skip if !success
  skip if !coversNetProfit          // net PnL gate
  skip if wstUsrProfit < MIN_PROFIT // 50 wstUSR minimum
  tiebreaker: wstUsrProfit (primary), netTotalWethProfit (secondary)
```

**wstUSR→WETH price resolution** (on-chain):

```solidity
dolaPerWstUsr = ICurvePool(CURVE_DOLA_WSTUSR).get_dy(1, 0, 1e18)  // Curve spot
ethUsdPrice = IChainlinkFeed(CHAINLINK_ETH_USD).latestRoundData()  // Chainlink
priceE18 = dolaPerWstUsr × 1e8 / ethUsdPrice                      // DOLA ≈ $1
```

### Phase 7.5: Local Ordered Replay / 本地有序回放

**File**: `script/helpers/LocalOrderedReplay.sol` (138 lines)

Validates the full sequence `[victim txs → our tx]` on a clean pre-replay state:

```
vm.revertToState(preReplaySnap)
  ├─ Replay prefix txs: vm.transact(TX0), vm.transact(TX1), ...
  ├─ CaptureArbSim (fresh intermediate values)
  ├─ Compile + BotVM.execute(script)
  ├─ Check wstUSR/WETH profit
  ├─ Verify coversNetProfit
  └─ Revert state
```

**Not a real bundle simulation.** Uses `vm.transact()` for historical txs only. Does not validate signed tx validity, nonces, relay acceptance, or coinbase payments.

### Phase 8: Report / 报告输出

```
wstUSR profit: 679804742377814573622  (~679.8 wstUSR)
WETH profit:   78263560246501388      (~0.078 WETH)
wstUSR->WETH:  186165297650262911    (~0.186 WETH)
netTotalWETH:  228070327896764299    (~0.228 WETH net)
gasUsed:       1211948
scriptLen:     3105 bytes
calldataLen:   3204 bytes
```

Plus full calldata hex for the `BotVM.execute(script)` call.

---

## 6. Data Structures / 数据结构

**File**: `script/helpers/Types.sol`

```solidity
enum ActionType { FLASH_LOAN, BORROW, SWAP }
enum ReplayMode { TRIGGER, EXACT, LIVE }

struct ActionModule {
    ActionType actionType;
    address protocol;
    address tokenIn;
    address tokenOut;
    bytes32 moduleId;      // keccak256("morpho-flash-wstUSR"), etc.
}

struct CandidatePath {
    ActionModule[] steps;  // [FLASH, BORROW, SWAP, SWAP, ...]
    uint256 rawIndex;
    uint256 flashAmount;   // ← filled by ParamSolver
    uint256 debtAmount1;
    uint256 debtAmount2;
    uint256 v4TakeAmount;
    uint256 v3ExactOutput;
    uint256 minProfit;
}

struct ExecutionConfig {
    address executor;              // address(0) = fork-deploy mode
    address owner;
    uint256 gasPriceWei;
    uint256 builderTipWei;
    uint256 minNetProfitWethWei;
    uint256 wstUsrToWethPriceE18;  // auto-resolved from Curve + Chainlink
}

struct SimResult {
    uint256 wstUsrProfit;
    uint256 wethProfit;
    uint256 gasUsed;
    uint256 gasCostWei;
    uint256 wstUsrProfitWethValue; // wstUSR profit in WETH terms
    uint256 netTotalWethProfit;    // gross - gas - tip
    bool coversNetProfit;          // net PnL gate
    bool success;
    bytes txCalldata;              // ready-to-submit calldata
    uint256 scriptLength;
    uint256 calldataLength;
    ...
}
```

---

## 7. TypeScript Listener / TypeScript 监听器

**Directory**: `listener/`

Dry-run mempool listener. Two modes:

### Backtest Mode

```
listener --backtest --victim-tx 0xc52b...
  └─ REPLAY_MODE=trigger forge script AutoBackrun.s.sol --fork-url $RPC -vv
     └─ Parse structured output → report profit
```

### Dry-Run Listener Mode

```
listener --dry-run --duration 600
  ├─ WebSocket: eth_subscribe("pendingTransactions") via Alchemy
  ├─ For each pending tx:
  │   ├─ filter.ts: Is it a wstUSR→DOLA swap on CURVE_DOLA_WSTUSR? ≥100 wstUSR?
  │   ├─ If match → log detection
  │   └─ Simulation disabled (vm.transact can't replay pending txs)
  └─ On shutdown: print session summary (detected / simulated / opportunities)
```

**filter.ts** decodes 4 Curve exchange selectors, checks `i=1, j=0` (wstUSR→DOLA direction).

**Limitation**: `simulateOpportunity()` is disabled. Real live simulation needs full tx object replay (not `vm.transact(hash)`), e.g., via `eth_callBundle` or `mev_simBundle`.

---

## 8. Key Addresses / 关键地址

All defined in `src/Constants.sol`:

| Name | Address | Role |
|------|---------|------|
| wstUSR | `0x1202...055` | Target token (depegged stablecoin) |
| USDC | `0xA0b8...B48` | Borrow output |
| DAI | `0x6B17...d0F` | PSM output |
| USDT | `0xdAC1...ec7` | DEX intermediate |
| WETH | `0xC02a...Cc2` | Parallel profit leg |
| DOLA | `0x8653...ce4` | Curve intermediate |
| Morpho | `0xBBBB...Cb` | Flash loan provider |
| Fluid Vault | `0xee32...ce6` | wstUSR/USDC vault |
| Curve DOLA/wstUSR | `0x6427...452` | Target swap pool |
| Chainlink ETH/USD | `0x5f4e...419` | Price oracle |
| UniV3 USDT/WETH | `0xc7bB...e9b` | V3 swap pool |
| UniV4 Pool Manager | `0x0000...A90` | V4 swap |
| Fork block | 24710787 | Pre-reference state |
| Target block | 24710788 | Reference tx block |

---

## 9. Testing / 测试

### Forge Tests (18 total)

```bash
forge test --fork-url $MAINNET_RPC_URL --fork-block-number 24710787 -vv
```

**WstUSRArb.t.sol** (8 tests):
- `testReplayWithOriginalPreState` — full arb at correct pre-state, ~273 wstUSR profit
- `testExactReplay` — exact 8-tx ordered replay
- `testReplayAtForkBlockIsNotOriginalTxState` — proves fork block alone is wrong state
- `testMinProfitRevert` — min profit guard works
- `testCurveMinUsesCurrentRunOutput` — Curve slippage guard
- `testForkState` — basic fork connectivity
- `testMinProfitIgnoresExistingBalance` — existing balance not counted
- `testTraceOriginalBotEndBlockBalance` — verify original bot balances

**BotVM.t.sol** (10 tests):
- Opcode tests: CALL, SET_FIELD2, ASSERT_BALANCE_GTE, REVERT, etc.
- Access control: onlyOwner, self-call, sweep
- Full arb replay through BotVM

### AutoBackrun Script

```bash
# Trigger mode (victim tx only)
REPLAY_MODE=trigger forge script script/AutoBackrun.s.sol:AutoBackrun \
  --fork-url $MAINNET_RPC_URL -vv

# Exact mode (full block prefix)
REPLAY_MODE=exact forge script script/AutoBackrun.s.sol:AutoBackrun \
  --fork-url $MAINNET_RPC_URL -vv
```

---

## 10. Environment Variables / 环境变量

| Variable | Default | Description |
|----------|---------|-------------|
| `MAINNET_RPC_URL` | (required) | Ethereum mainnet RPC (HTTP) |
| `MAINNET_WS_URL` | derived from RPC | WebSocket URL for listener |
| `REPLAY_MODE` | `exact` | `trigger` / `exact` / `live` |
| `BOTVM_ADDRESS` | (none) | Deployed BotVM address (production mode) |
| `BOTVM_OWNER` | (none) | BotVM owner address |
| `GAS_PRICE_GWEI` | `30` | Gas price for net PnL calculation |
| `BUILDER_TIP_WEI` | `0` | Builder tip (for bundle submission) |
| `MIN_NET_PROFIT_WETH_WEI` | `0` | Minimum net profit threshold |
| `WSTUSR_TO_WETH_PRICE_E18` | auto (on-chain) | Manual price override |

---

## 11. Safety Rules / 安全规则

1. **No mainnet broadcast.** All testing on local forks.
2. **No real bundle submission.** Everything stays dry-run.
3. **No `.env` in git.** RPC URLs and keys stay local.
4. **Scripts default to `--broadcast` disabled.**
5. **BotVM.execute() is onlyOwner.** Owner set immutably in constructor.
6. **ASSERT_BALANCE_GTE (opcode 0x08)** — script-level min profit guard.
