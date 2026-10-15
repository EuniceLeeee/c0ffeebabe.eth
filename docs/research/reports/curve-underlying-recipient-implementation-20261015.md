# Curve underlying recipient implementation — 2026-10-15

The remaining nativeAlias recipient wiring is implemented. A direction receives the capability only after an optional, source-bound probe verifies exact positive input debit and actual receipt at an independent receiver. Ordinary probe rejection retains the default direction. Native output uses the existing common ETH/WETH boundary; the Family owns the raw ABI and approval semantics.

The baseline already contains the generic 5f receiver implementation and its FRAX evidence, so this change does not repeat that work. Both receiver selectors now enter the existing registry-based nomination path. No instance allowlist or central protocol branch was added.

Actual and owned-only production builds passed. Necessary regressions passed: 30 nativeAlias tests, 40 Family tests, 7 actual local BotVM tests, 301 all-Family tests and 174 strict-central tests, plus classic recipient and common asset-boundary checks. The local EVM uses synthetic pools/tokens and production emitted programs. It covers exact debit, real receiver balances, old inventory, zero input, wrong receiver, approval cleanup, rollback and native conversion. The frozen JSON binds source, tools and logs, including failed author-side evidence attempts and their corrections.

Status: **implemented with local regressions and independent code review**. Unified historical receiver acceptance, untested identity/variant evidence, formal Adapter Replay, natural valuation, opportunity reproduction and phase 4 timing remain pending. Existing historical evidence retains its original fingerprint and scope. No deployment, live run or broadcast occurred.

Evidence: [source pins, execution receipts, independent review and limits](curve-underlying-recipient-implementation-20261015.json). Raw logs remain in the ignored `logs/family-implementation-20261015.0exjskqq` evidence directory.
