# Ekubo native recipient implementation — 2026-10-15

Admitted native Ekubo directions now expose direct recipient settlement. Native input delivers ERC20 output to the requested receiver. Native output remains at the actor until the common boundary wraps and transfers the actual new WETH. Explicit native settlement checks positive input and clears exact ERC20 approval; default execution and existing ERC20 behavior remain unchanged.

The selected deployed Router has an explicit receiver. Its lock callback is internal to Accountant/Router and provides no caller continuation, so it does not grant deferred-input capability. Family tests check that distinction. No protocol branch was added to central code.

Production and owned-only builds, Family/recipient contracts, real local BotVM tests, common boundary, all-Family and strict-central regressions passed. Local EVM tests use a synthetic Router with admitted vanilla/TWAMM descriptors; they do not execute real TWAMM extension logic or establish historical acceptance. The scratch freezer's stale embedded Curve script was rejected and corrected without weakening the catalog comparison; failed evidence is retained.

Status: **implemented, local regressions and independent review passed**. New native recipient historical acceptance, formal Adapter Replay, opportunity and performance remain pending. [Frozen source, logs and review](ekubo-native-recipient-implementation-20261015.json).
