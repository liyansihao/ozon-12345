# Flow B Pool Memory Strategy

Updated: 2026-06-18

This file is the long-term memory for Ozon China source scanning. It records which pools are proven, which are only supplements, which are quality scouts, and which should be stopped early. The goal is to avoid rediscovering the same lessons every run.

Structured memory lives in [config/flow_b_pool_memory.json](/Users/mac/.codex/worktrees/3b6c/ozon/flow_b_codex_transfer_20260608/config/flow_b_pool_memory.json).

## Pool Types

Main pools are scanned first when they have fresh sellers.

Supplement pools are used only when main pools decay.

Watch pools are useful for product/category discovery or quality scouting, but not for fast favorite volume.

Exhausted pools used to work or look relevant, but the current fresh seller pool is weak.

Downweighted pools are noisy, large-good-heavy, seller-extraction-poor, or historically low-yield.

## Current Main Pools

| pool | category id | segment | observed fav/min | current status |
| --- | ---: | --- | ---: | --- |
| kids/toys high-price tail | 7000, 7108 | toy/BJD/RC/blocks seller clusters, especially mid/tail windows | 18.76 best historical | keep first only when fresh cluster exists; current pool is mostly exhausted |
| tabletop/card games | 13506 | tabletop/card-game sellers after text filtering | 11.3 | strongest clean new pool from 2026-06-18 |
| playing cards / collectible cards | 13517 | cards, DND, UNO, Bicycle, collectible-card products | 5.6 seller-scan; product browsing also helped | effective secondary main pool |

## Supplement Pools

| pool | category id | segment | observed performance | rule |
| --- | ---: | --- | --- | --- |
| default min50 middle window | default China highlight | only the proven middle window, not front/tail | 13.19 best historical, volatile | use only as controlled backup |
| hobby and creativity controlled | 13500 | handpicked tabletop/hobby/creative sellers inside broad hobby | total moved 975 -> 999 during partial scan, but count was interrupted | use as volume supplement with strict quality filtering |

## Watch Pools

| pool | category id | segment | observed performance | rule |
| --- | ---: | --- | --- | --- |
| DND dice / board-game accessories | 13523 | clean DND dice and small accessories | seller scan +0, product exploration lifted 948 -> 975 | quality scout, not fast seller-scan volume |
| BJD/dolls | 31272 | BJD dolls and doll accessories | +0 from 2 sellers | quality scout only |

## Exhausted Pools

These are not deleted forever, but should not be hard-scanned without new evidence.

| pool | category id | reason |
| --- | ---: | --- |
| current toys/game page | 7108 | clean products, but fresh sellers are concentrated |
| constructors | 7174 | relevant products but seller mix drifted; +1 |
| figures/accessories | 7169 | drifted into tools/food/large goods; +0 |
| plush toys | 7175 | too few products and unstable page |
| toy weapons | 7141 | one seller, mixed products, +0 |

## Downweighted Pools

| pool | category id | reason |
| --- | ---: | --- |
| broad electronics | 15500 | large electronics / brand / low quality fit |
| construction and repair | 9700 | tool and building drift |
| collectibles current page | 13755 | current page drifted generic |
| pets current page | 12300 | category parameter did not form a clean pet pool |
| kids outdoor | 30726 | electric cars, pools, bikes, duplicate-heavy |
| school/learning | 7182 | medical/e-bike/razor/outdoor drift |
| paint by numbers for seller scanning | 13568 | clean product pool, but 62 products yielded 0 sellers |
| broad accessories | 7697 | +0; only useful because it exposed tabletop/card signal |

## Exhaustion Rules

A pool is considered exhausted for the current run when any of these happen:

1. After dedupe, fresh sellers are below 3.
2. Two consecutive scan batches have favorite delta below 5.
3. Ten relevant products produce 2 or fewer fresh sellers.
4. The category drifts into large goods, heavy instruments, branded electronics, furniture, medical goods, strollers, bikes, pools, construction tools, or unrelated apparel.
5. Maozi favorite count is unavailable for two consecutive batches; pause and restore count before judging.

An exhausted pool can be revived only if a new price window, product breadcrumb, or seller cluster produces at least 8 fresh sellers and the first validation batch reaches delta >= 5.

## Switching Logic

1. Start with fresh `kids_toys_high_price_tail` if a new seller cluster exists.
2. If toy freshness is low, switch to `tabletop_card_games` (`13506`).
3. Then use `playing_cards_collectible_cards` (`13517`).
4. If both are low, use supplement pools:
   - default min50 middle window
   - controlled hobby/creativity (`13500`) with handpicked sellers
5. Use watch pools only to discover new breadcrumbs or quality candidates.
6. If all active pools decay, discover a new pool:
   - open products that triggered Maozi favorites
   - extract breadcrumb category IDs
   - create a China-highlight URL with that category ID
   - collect products
   - filter product text before seller extraction
   - validate 1-3 batches
   - promote, watch, downweight, or mark exhausted

## Promotion Rules

Promote a new candidate to a main pool if:

1. It has two validation batches and average fav/min >= 8.
2. Or one small validation produces favorite_delta >= 15 with a clean small-goods seller segment.
3. Seller/product mix does not depend on large goods, heavy instruments, furniture, branded electronics, or obvious low-quality drift.

Keep a candidate as a supplement if it has volume but quality is mixed.

Keep a candidate as watch if product quality is good but seller volume is too concentrated.

Downweight it if seller extraction fails, favorite delta is 0, or category drift dominates.

## Updated Default Priority

1. `kids_toys_high_price_tail` when fresh.
2. `tabletop_card_games` (`13506`) with tabletop/card/DND text filtering.
3. `playing_cards_collectible_cards` (`13517`) with card/UNO/Bicycle/collectible-card filtering.
4. `default_min50_middle_window` only as backup.
5. `hobby_creativity_controlled` (`13500`) only with handpicked small hobby/tabletop/creative sellers.
6. Watch pools for discovery only: `13523` DND dice and `31272` BJD/dolls.

## Implementation Note

The next code improvement should make this memory executable: read `config/flow_b_pool_memory.json`, choose pools by priority, apply exhaustion rules, and write each validation back to the pool memory after every run.
