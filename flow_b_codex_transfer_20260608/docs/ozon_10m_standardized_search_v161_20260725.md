# v161 standardized-commodity search gate

- Run: `runs/flow_b/20260725_000000_ozon10m_v161`
- Frozen commit: `8f37b30300f9e6f1017d5477c36dd959d071d451`
- Window: 2026-07-24 23:57:53–2026-07-25 00:07:53 CST
- Single variable: replace exhausted seller pages with Global searches for generic standardized products

## Result

NOT PASS: one strict final, 6/hour. The final was v160 pending SKU 1567562706 (58.72%, 丽丽五号); the new search batch produced zero in-window strict finals.

Eighteen searches produced only four eligible listing links. Four real details led to one new submission, one reliable-match failure, one profit-upper-bound rejection, and one final profit rejection. CAPTCHA, soft block, browser crash, duplicate final SKU, and runtime failures were all zero.

The strict listing-evidence gate is now the largest loss for these explicitly Global searches. The next controlled variable is to admit listing-mode-unknown products from this exact `is_global=true` allowlist into real detail verification. Explicit non-FBS cards remain rejected, and unknown is never counted as FBS; final pure-FBS status still requires the existing detail check.
