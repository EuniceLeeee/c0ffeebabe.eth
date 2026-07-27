# Landed evidence — self-burn-native tx `0xb51c…23a7`

- Transaction:
  `0xb51c9e139384978731d58c526d337bf78ac223647c5c0b570a574855bda723a7`
- Canonical block/index: `25619948 / 63`
- Status: `1`
- Same-actor predecessor used for the exact intra-block state anchor:
  `0x2fbb82b50a966e5080187f0ed7b488200f830f05eba5fe14cf8e17bd8c56bf36`
  at index `62`. This is not classified as an external public-mempool victim.
- Family leg: token `0x292a477e521230fe230c13c93374adde8ddec1c1`
  executes `transfer(token, amount)` and pays native ETH to the caller.
- Input burned in the landed receipt: `12306616935116519` token wei.
- Native payout: `12183550765765354` wei.
- WETH wrapped for the closing leg: `12098506946212668` wei.
- Gross native remainder: `85043819552686` wei.
- Balancer USDT principal: `23416320`; closing USDT output and repayment:
  `23416320` (exact).
- Conservative landed net-profit reference used only as fixture
  classification evidence: `canonicalNetProfitUsd = 0.12`.

This document records the landed transaction. It does not supply a solver
amount, quote, verified route, calldata, discovery admission, or expected
challenger output.
