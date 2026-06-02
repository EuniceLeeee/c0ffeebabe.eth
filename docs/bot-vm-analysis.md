# MEV Bot VM Architecture — Bytecode Reverse Engineering

Bot: `0xE08D97e151473A848C3d9CA3f323Cb720472D015`

## 1. High-Level Architecture

The bot is a hand-written EVM program (not Solidity-compiled) that implements a **custom action interpreter** — a VM within the EVM. It reads a packed instruction stream from calldata, dispatches each byte-coded opcode, and advances a program counter until the stream is exhausted.

```
                     +-----------+
                     | tx.origin |
                     | == 0xC0ffee|
                     +-----+-----+
                           |
              +------------+-------------+
              |                          |
         selector ==               selector !=
        0xcabcfc90                 0xcabcfc90
       (self-call /                     |
        subscript)            msg.sender == owner?
              |               (from code tail)
         VM Loop 1           /              \
         @ 0x005a          yes               no
         (no tip)            |                |
                        VM Loop 2      fallback handler
                        @ 0x052d         @ 0x0a2b
                        (+ tip)             |
                                    callback_active?
                                    /             \
                                  yes              no
                            keccak256 lookup   field2 != 0?
                            → pre-stored        → VM Loop 3
                              response            @ 0x102f
```

### Entry Guards

| Offset | Check | Fail Action |
|--------|-------|-------------|
| 0x0000 | `gas > 3000` | `RETURN(0,0)` (silent exit) |
| 0x000d | `tx.origin == 0xC0ffee...` | `REVERT(0,0)` |
| 0x04e8 | `msg.sender == owner` (from code tail) | → fallback handler |

### Selector Dispatch

Only one selector is explicitly checked in bytecode. Everything else routes by `msg.sender`.

| Path | Condition | Entry |
|------|-----------|-------|
| Self-call / subscript | `selector == 0xcabcfc90` | VM Loop 1 → exit clean (no tip) |
| Owner / top-level | `selector != 0xcabcfc90 && msg.sender == code_tail` | VM Loop 2 → builder tip + sweep |
| Protocol callback | `selector != 0xcabcfc90 && msg.sender != code_tail` | Fallback: keccak256 lookup or VM Loop 3 |

**Note:** `0x8cbf8566` is the selector observed in the reference tx, but the contract does not check for it — any non-`0xcabcfc90` selector works for the owner path.

**Note:** `0xcabcfc90` is NOT Morpho's callback selector (`onMorphoFlashLoan(uint256,bytes)` = `0x31f57072`). It is the bot's own self-call entry: the owner script uses opcode 0x00 to `CALL(self, 0xcabcfc90 || subscript_data)`, which re-enters the contract at VM Loop 1 to run a nested sub-script. Morpho and other protocol callbacks arrive through the fallback path instead.

---

## 2. TSLOT 0x1337 — State Register

A single transient storage slot packs the VM's callback state into 7 bytes:

```
Bit layout (256-bit word, MSB left):
 ┌──────────┬───────────────┬───────────────┬─────────────────────┐
 │ 248..255 │   224..247    │   200..223    │      0..199         │
 │ field1   │   field2      │   field3      │     (unused)        │
 │  1 byte  │   3 bytes     │   3 bytes     │                     │
 └──────────┴───────────────┴───────────────┴─────────────────────┘
```

**Unpack** (at entry of each VM loop):
```
word   = TLOAD(0x1337)
field1 = word >> 248              // 1 byte
word'  = word << 8
field2 = word' >> 232             // 3 bytes
word'' = word' << 24
field3 = word'' >> 232            // 3 bytes
```

**Repack** (before TSTORE):
```
packed = (field1 << 248) | (field2 << 224) | (field3 << 200)
TSTORE(0x1337, packed)
```

### Field Semantics

| Field | Size | Meaning |
|-------|------|---------|
| field1 | 1 byte | **callback_active** — 0 = no pending callback; 1 = callback response pre-stored, expect callback |
| field2 | 3 bytes | **resume_offset** — calldata offset or program counter for callback resume |
| field3 | 3 bytes | **auxiliary_offset** — secondary state for nested callbacks |

---

## 3. VM Loop Mechanics

Each VM loop has identical structure. The stack at loop entry:

```
[pc, remaining, field1, field2, field3]
 ↑      ↑
 │      └─ bytes left to process (decrements each iteration)
 └──────── current calldata read offset (increments)
```

### Fetch-Decode-Execute Cycle

```
loop:
    opcode = calldata[pc] >> 248        // read top byte
    dispatch(opcode)                     // jump table 0x00..0x0e
    handler:
        ... execute action ...
        instr_size = compute_size()
        remaining -= instr_size
        pc += instr_size
        if remaining <= 0: exit
        goto loop
```

### Invalid Opcode Error Codes

| Context | Error | ASCII |
|---------|-------|-------|
| Owner/Callback VM (Loop 1 & 2) | `0x69636f21` | `ico!` |
| Fallback VM callback (Loop 3) | `0x69736f21` | `iso!` |

---

## 4. Opcode Reference (15 opcodes: 0x00 — 0x0e)

### Opcode 0x00: CALL (no value)

External call with `msg.value = 0`, no return data capture.

```
Layout: [0x00][address:20][payload_len:3][payload:N]
Size:   24 + N bytes

Semantics:
  CALL(gas=gasleft, to=address, value=0,
       argsOffset=23, argsSize=payload_len,
       retOffset=0, retSize=0)
  Reverts on failure.
```

### Opcode 0x01: CALL (with value)

External call with a 96-bit `msg.value` (12 bytes, enough for ~79B ETH).

```
Layout: [0x01][address:20][value:12][payload_len:3][payload:N]
Size:   36 + N bytes

Semantics:
  CALL(gas=gasleft, to=address, value=value_96bit,
       argsOffset=35, argsSize=payload_len,
       retOffset=0, retSize=0)
  Reverts on failure.
```

### Opcode 0x02: SAVE STATE (set field2)

Saves callback resume state. Used before an external call that will trigger a callback.

```
Layout: [0x02][new_field2:3]
Size:   4 bytes

Semantics:
  field2 = new_field2    // resume offset
  field3 = 0             // clear auxiliary
  // field1 unchanged
  TSTORE(0x1337, pack(field1, field2, field3))
```

### Opcode 0x03: RETURN

Halts execution and returns data to caller.

```
Layout: [0x03][data_len:3][data:N]
Size:   N/A (execution halts)

Semantics:
  Copy data to memory
  RETURN(offset=3, size=data_len)
```

### Opcode 0x04: WETH UNWRAP

Unwraps all WETH balance to native ETH. No parameters.

```
Layout: [0x04]
Size:   1 byte

Semantics:
  bal = WETH.balanceOf(address(this))
  if bal > 0:
      WETH.withdraw(bal)
```

Hardcoded WETH: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`

### Opcode 0x05: CLEAR STATE

Resets callback state fields to zero. Used after callback completes.

```
Layout: [0x05]
Size:   1 byte

Semantics:
  field2 = 0
  field3 = 0
  // field1 unchanged
  TSTORE(0x1337, pack(field1, 0, 0))
```

### Opcode 0x06: SAVE STATE (set field3)

Like opcode 0x02, but sets field3 instead of field2.

```
Layout: [0x06][new_field3:3]
Size:   4 bytes

Semantics:
  field2 = 0
  field3 = new_field3    // auxiliary offset
  // field1 unchanged
  TSTORE(0x1337, pack(field1, 0, field3))
```

### Opcode 0x07: CLEAR field1

Resets the callback_active flag.

```
Layout: [0x07]
Size:   1 byte

Semantics:
  field1 = 0             // callback no longer active
  // field2, field3 unchanged
  TSTORE(0x1337, pack(0, field2, field3))
```

### Opcode 0x08: STORE CALLBACK RESPONSE

Pre-stores an expected callback response in transient storage, keyed by the keccak256 hash of the expected incoming calldata. Also activates callback mode.

```
Layout: [0x08][tslot_key:32][response_header_len:3][response_data:N]
Size:   36 + N bytes

Semantics:
  // tslot_key = keccak256(expected_callback_calldata), pre-computed off-chain
  for i, word in enumerate(response_words):
      TSTORE(tslot_key + i, word)   // first word includes 3-byte length header
  field1 = 1                         // mark callback active
  TSTORE(0x1337, pack(1, field2, field3))
```

This is the core of the callback pre-computation trick:
1. Off-chain searcher pre-computes what calldata the external protocol will send back
2. Computes `keccak256(expected_calldata)` as the storage key
3. Stores the desired response at that key
4. When the callback arrives, the fallback handler hashes incoming calldata, finds the match, and returns the pre-stored response

### Opcode 0x09: CLEAR CALLBACK RESPONSE

Removes a previously stored callback response from transient storage.

```
Layout: [0x09][tslot_key:32]
Size:   33 bytes

Semantics:
  len = TLOAD(tslot_key) >> 232   // read stored length header
  slots_to_clear = (len + 3) / 32 + 1 (approx)
  for i in range(slots_to_clear):
      TSTORE(tslot_key + i, 0)
```

### Opcode 0x0a: CLEAR TSLOT RANGE

Bulk-clears a range of transient storage slots using namespace indexing.

**Layout unverified — do not use as encoder spec.**

```
Layout: [0x0a][arg_at_pc+1:3][arg_at_pc+4:3]
Size:   7 bytes

Semantics (inferred, not stepper-verified):
  One arg is multiplied by 0x086470 (550,000) to compute base_slot.
  The other arg is the iteration count.
  Loop: TSTORE(base_slot + i, 0) for i in 0..count

  Which arg is base vs count depends on stack order —
  disasm shows CALLDATALOAD at pc+1 and pc+2 (overlapping 3-byte reads).
  Needs EVM stepper to resolve definitively.
```

### Opcode 0x0b: CREATE (deploy arbitrary initcode)

Deploys arbitrary initcode via CREATE. The created contract address is discarded. What the initcode does is entirely determined by the script — it could self-destruct, execute a one-shot action, or deploy a persistent helper. The VM doesn't constrain it.

```
Layout: [0x0b][bytecode_len:3][initcode:N]
Size:   4 + N bytes

Semantics:
  CALLDATACOPY(0, pc+4, bytecode_len)
  CREATE(value=0, offset=0, size=bytecode_len)
  // address discarded
```

### Opcode 0x0c: TSTORE BULK (write range)

Writes multiple 32-byte words from calldata directly into consecutive transient storage slots.

**Layout unverified — do not use as encoder spec.**

```
Layout: [0x0c][arg_at_pc+1:3][arg_at_pc+4:3][words:N*32]
Size:   7 + N * 32 bytes

Semantics (inferred, not stepper-verified):
  Same structure as 0x0a: two 3-byte fields at pc+1 and pc+4,
  one multiplied by 0x086470 for base_slot, the other as count.
  Loop: TSTORE(base_slot + i, calldataload(pc + 7 + i*32))

  Exact arg-to-role mapping unresolved — same caveat as 0x0a.
```

### Opcode 0x0d: REVERT

Halts execution with custom error data.

```
Layout: [0x0d][data_len:3][data:N]
Size:   N/A (execution halts)

Semantics:
  Copy data to memory
  REVERT(offset=3, size=data_len)
```

### Opcode 0x0e: CLONE SELF

Deploys a clone of this contract at a new address using CREATE.

```
Layout: [0x0e]
Size:   1 byte

Semantics:
  // Build init code in memory:
  //   PUSH1 0x0d; CODESIZE; SUB; DUP1; PUSH1 0x0d; PUSH0; CODECOPY; PUSH0; RETURN
  // Append this contract's runtime bytecode (CODECOPY)
  // Patch in ADDRESS at known offset
  CREATE(value=0, offset=0, size=codesize+13)
  Reverts if CREATE fails.
```

---

## 5. Callback Routing — Fallback Handler (0x0a2b)

When an external protocol calls the bot (e.g., Morpho `onMorphoFlashLoan` = 0x31f57072, Uniswap V4 unlock callback, Curve callback), and the selector is not 0xcabcfc90 and the sender is not the owner, the fallback handler activates.

The handler supports **two callback modes**:

### Mode A: Hash-Lookup Response (opcode 0x08 / 0x09)

For callbacks where the response is fully known at TX submission time. The bot pre-stores a response keyed by the keccak256 hash of the expected incoming calldata. When the callback arrives, a single hash lookup returns the pre-stored data — zero computation.

### Mode B: Resume-VM from Callback Calldata (field2 / field3)

For callbacks that carry dynamic `bytes` payloads (e.g., Morpho's `onMorphoFlashLoan(uint256, bytes)`). The protocol passes opaque bytes that contain the next chunk of VM opcodes. The fallback handler uses field2/field3 from TSLOT 0x1337 to locate and execute the nested script from callback calldata via VM Loop 3. **This is the primary mode used in the reference tx.**

### Fallback Handler Pseudocode

```
fallback():
    state = TLOAD(0x1337)
    unpack → (field1, field2, field3)

    if field1 != 0:                          // Mode A: hash-lookup active
        hash = keccak256(msg.data)
        response = TLOAD(hash)
        if response != 0:
            load response words from TSLOT[hash], TSLOT[hash+1], ...
            RETURN(response_data)            // instant return, no VM execution
        // no match → fall through

    if field2 != 0:                          // Mode B: resume-VM
        // field2 encodes offset/length into callback calldata
        // parse calldata to extract nested VM script
        // execute VM Loop 3 @ 0x102f on the extracted opcodes
        ...

    RETURN(0, 0)                             // default: empty return
```

### How Callbacks Work End-to-End

```
1. Owner calls bot with any selector (e.g., 0x8cbf8566) + packed opcodes

2. VM executes opcodes sequentially:
   a. [if Mode A] Opcode 0x08: Pre-store callback response at keccak256(expected_calldata)
   b. Opcode 0x02/0x06: Save resume state to TSLOT 0x1337
   c. Opcode 0x00: CALL external contract (triggers callback)
      - For self-calls: CALL(self, 0xcabcfc90 || subscript) → enters VM Loop 1
      - For protocols: CALL(Morpho.flashLoan(...)) → Morpho calls back via fallback

3. Protocol calls back into bot (fallback path):
   Mode A: hash(msg.data) → TLOAD → return pre-stored response immediately
   Mode B: locate VM script in callback calldata → execute via VM Loop 3

4. Callback completes, VM continues from next opcode:
   a. Opcode 0x07: Clear field1 (if Mode A was used)
   b. Opcode 0x09: Clear stored response from TSLOT (if Mode A)
   c. Opcode 0x05: Clear state (if Mode B)
   d. Continue with next action...

5. After all opcodes processed → builder tip → sweep ETH to owner
```

---

## 6. Builder Tip + Sweep (0x09b6 — 0x0a27)

After the owner VM loop finishes (Loop 2 only):

```
0x09b6:
  // Guard: only original contract tips (clone's code_tail != 0xc0ffee)
  if CODECOPY(codesize - 20) != 0xc0ffee:
      goto return

  // Tip calculation (integer math, truncation intended)
  tip = (selfbalance / 10000) * msg.value
  // msg.value is real ETH but doubles as bps parameter
  // e.g., msg.value = 500 wei → tip = 5% of contract ETH balance

  if tip > 0:
      CALL(COINBASE, tip)                   // pay block builder

  // Sweep remaining ETH to operator
  CALL(0xc0ffee, selfbalance)               // hardcoded, not code_tail

  RETURN(0, 0)
```

**Subtlety:** The tip guard compares `code_tail` against hardcoded `0xc0ffee`. This means:
- Original contract (code_tail == 0xc0ffee): tips builder, sweeps to 0xc0ffee
- Clone (code_tail == parent address != 0xc0ffee): skips tip/sweep entirely, just returns
- The sweep target is hardcoded `0xc0ffee`, NOT read from code_tail

**Note on `msg.value`:** It is real ETH transferred into the contract (not a virtual parameter), but the amount is typically tiny — its primary role is encoding the tip rate in basis points. The bulk of the ETH balance being tipped/swept comes from WETH unwrapped by opcode 0x04 during script execution. The msg.value ETH also becomes part of `selfbalance` and participates in the tip/sweep calculation.

---

## 7. Gas Optimization Techniques

### TLOAD/TSTORE over SLOAD/SSTORE (EIP-1153, Cancun)
- Transient storage costs 100 gas per access (vs 2100/20000 for cold SLOAD/SSTORE)
- All callback state and pre-stored responses use TSLOT
- Automatically cleared at end of transaction — no cleanup needed

### keccak256 Callback Routing
- Zero-computation callback responses (just hash + lookup)
- No branching on selector, no ABI decoding of callback arguments
- The cost: pre-computing responses off-chain + storing them (amortized across the tx)

### Namespace Multiplier (0x086470 = 550,000)
- Prevents collisions between different callback response sets
- Each "namespace" gets 550,000 TSLOT slots
- Bulk operations (opcodes 0x0a, 0x0c) use namespace indexing

### No Memory Expansion Waste
- Calldata is processed in-place via CALLDATALOAD
- Memory is reused for each CALL (always writes at offset 0)
- MCOPY (Cancun) used in the fallback handler for efficient memory shuffling

### Packed Instruction Stream
- Variable-length instructions (1 to 36+ bytes)
- No padding or alignment — every byte counts
- 3-byte length fields allow payloads up to 16 MB (practical limit: gas)

### DELEGATECALL-free Design
- All external interactions via CALL (not DELEGATECALL)
- Avoids context-switching overhead
- Contract holds all assets directly

---

## 8. VM as a Reusable Design

The bot's VM is a **generic action executor**. To reuse this design:

### What stays the same
- Entry guard pattern (origin check, gas check, sender check)
- TSLOT 0x1337 state register for callback coordination
- keccak256 callback pre-computation trick
- Builder tip mechanism
- Opcode dispatch loop structure

### What to customize
- **Opcode set**: Add/remove actions for your specific DeFi integrations
- **Hardcoded addresses**: WETH unwrap (opcode 0x04) has hardcoded WETH address
- **Owner address**: Stored in code tail (last 20 bytes of deployed bytecode)
- **Self-call selector**: 0xcabcfc90 can be changed (owner path accepts any other selector)

### Key design decisions
1. **Pre-computed callbacks**: All callback responses must be known at TX submission time. This works for atomic MEV but not for reactive strategies.
2. **No return value handling**: Opcodes 0x00/0x01 ignore return data (`retSize=0`). If you need return values, add a new opcode.
3. **No conditional logic**: The VM is a linear instruction stream with no branching. All "decisions" are made off-chain by the searcher.
4. **Transient-only state**: Nothing persists across transactions. The contract is stateless between blocks.

