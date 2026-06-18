# Ozon 扫描优化 Loop Summary

- run_dir: `runs/flow_b/20260617_090828_scan_optimization_loop`
- created_at: `2026-06-17T09:08:28`

## Baseline

- baseline run: `20260615_165407_high_yield_c_group`
- funnel: candidates 470 -> cost reliable 250 -> FBS calc 115 -> passers 32
- pass rate from candidates: 6.8%

### Source Scan Baseline
| source | sellers | favorite_delta | fav/min(scan seconds) | batches |
| --- | ---: | ---: | ---: | ---: |
| find_03_kids_toys_segment_min50 | 61 | 233 | 12.31 | 16 |
| find_01_models_min50 | 45 | 119 | 8.67 | 12 |
| find_02_models_min500 | 16 | 62 | 12.51 | 4 |
| manual_find_models_deep_80 | 6 | 11 | 3.31 | 3 |
| find_04_electronics_min500 | 8 | 0 | 0.0 | 1 |
| manual_find_kids_min500 | 8 | 0 | 0.0 | 2 |

## Strategy V1
- 调整 1：把儿童/玩具放到第一优先级，模型第二；电子高价降权。
- 调整 2：保留低产早停，避免低收藏店铺拖慢 1000 收藏。

## Round 1 - kids_toys_min50
- fresh sellers: 19
- favorite_delta: 5
- batches: 2
- result: low yield, early stopped
- adjustment: switch to kids_toys_min500; keep C-group speed unchanged

## Round 2 - kids_toys_min500
- fresh sellers: 75
- favorite_delta: 46
- batches: 6
- current favorite total: 132
- result: mixed. Toys/EDC/blocks/RC sellers worked; mattresses/furniture/large kids vehicles/general stores were weak and triggered early stop.
- adjustment: switch to narrower `models_min500`; keep C-group speed unchanged.

## Round 3 - models_min500
- fresh sellers: 3
- favorite_delta: 1
- batches: 1
- current favorite total: 136
- result: high purity but too narrow; not suitable as main 1000-favorite source.
- adjustment: switch to `models_min50`; keep C-group speed unchanged.

## Round 4 - models_min50
- fresh sellers: 10
- favorite_delta: -5
- batches: 2
- current favorite total: 134
- result: low yield and drifted into curtains/electronics/sports/outdoor.
- adjustment: downweight current models highlight; switch to a larger historical high-yield pool while keeping C-group speed unchanged.

## Round 5 - accessories_min50
- fresh sellers: 9
- favorite_delta: 15
- batches: 3
- current favorite total: 159
- result: small mixed pool. First batch worked, later batches dropped below threshold.
- adjustment: keep as supplemental source; test `build/tools min50` next while keeping C-group speed unchanged.

## Round 6 - build_min50
- fresh sellers: 10
- favorite_delta: 4
- batches: 2
- current favorite total: 166
- result: low yield; drifted into general goods and triggered early stop.
- adjustment: downweight build/tools; test `electronics_min50` next while keeping C-group speed unchanged.

## Round 7 - electronics_min50
- source extraction stopped early by strategy judgment.
- observed: 211 product candidates, but about 75 products only yielded about 28 sellers before stop.
- result: large product pool, low seller extraction efficiency, high large-electronics risk.
- adjustment: downweight broad electronics; test default China highlight next while keeping C-group speed unchanged.

## Round 8 - default_min50 front segment
- fresh sellers: 108
- favorite_delta: 0
- batches: 1
- current favorite total: 196
- result: source finding was strong, but first segment was low yield: bathroom/books/audio/laptop/general stores, 0 + 0 delta.
- adjustment: keep default pool, but skip first 40 fresh sellers and scan mid/tail segment; keep C-group speed unchanged.

## Round 9 - default_min50 skip40 mid segment
- fresh sellers: 68
- favorite_delta: 114
- batches: 8
- current favorite total: 310
- result: effective but volatile. Strong batches came from small electronics/protective accessories/tech stores; weak batches were generic/brand/large goods.
- adjustment: continue default pool from unprocessed product tail instead of rescrolling; keep C-group speed unchanged.

## Round 10 - default product tail after 321
- source extraction stopped early by strategy judgment.
- observed: by tail product 78, only about 36 sellers, dominated by repeated laptops/lights/bathroom goods.
- result: lower extraction efficiency than default mid segment; tail is downweighted.
- adjustment: test final seller segment from completed default source list: skip first 80 sellers.

## Round 11 - default_min50 skip80 tail seller segment
- fresh sellers: 28
- favorite_delta: 13
- batches: 4
- current favorite total: 323
- result: weak supplement. Tail seller segment underperformed default mid segment.
- adjustment: downweight default front and tail; test collectibles/category 13755 next.

## Round 12 - collectibles_min50
- source extraction stopped early by strategy judgment.
- observed: early products drifted into laptops/bathroom/lights/belts; about 22 products yielded only about 11 sellers.
- result: not a clean collectibles/toys pool; downweighted.
- adjustment: test pet supplies/category 12300 next while keeping C-group speed unchanged.

## Round 13 - pets_min50/category12300
- source extraction stopped early by strategy judgment.
- observed: category parameter did not form a clean pet pool; early products drifted to lights/belts/photo/mirror/laptop.
- result: downweighted despite historical pet profit potential.
- adjustment: test unscanned default bridge segment 8-40.

## Round 14 - default_min50 bridge 08-40
- fresh sellers: 32
- favorite_delta_counted: 1
- batches: 2
- current favorite total: 327
- result: low yield; confirms default front/bridge/tail are weak versus mid segment.
- adjustment: test remaining segment from `kids_toys_min500`.

## Round 15 - kids_toys_min500 skip32 tail
- fresh sellers: 43
- favorite_delta: 180
- batches: 11
- current favorite total: 507
- result: best current strategy. Tail segment was much stronger and steadier than default.
- adjustment: deepen `kids_toys_min500` source collection beyond first 120 sellers.

## Round 16 - kids_toys_min500 deeper deduped
- fresh sellers: 7
- favorite_delta: 16
- batches: 2
- current favorite total: 529
- result: source nearly exhausted after dedupe, but remaining toy/outdoor sellers still produced one good batch.
- adjustment: extract visible highlight category links before choosing next source.


# Final Loop Summary - 2026-06-17

## Final Status
- target favorite count: 1000
- reached favorite count: 529
- result: not completed, but closest safe point reached before high-quality sources became exhausted or drifted.
- main improvement found: segment selection matters more than scroll speed. C-group speed was kept unchanged; gains came from skipping weak source segments and prioritizing high-yield segments.

## Best Segments
| segment | favorite delta | batches | sellers scanned | fav/min | judgment |
| --- | ---: | ---: | ---: | ---: | --- |
| kids_toys_min500 tail skip32 | 180 | 11 | 43 | 18.76 | best, keep as first priority |
| default_min50 mid skip40 | 114 | 8 | 36 | 13.19 | effective but volatile |
| kids_toys_min500 front | 46 | 6 | 28 | 7.67 | mixed; front weak, later improved |
| kids_toys_min500 deeper fresh | 16 | 2 | 7 | 12.97 | source nearly exhausted |
| accessories_min50 | 15 | 3 | 9 | 10.92 | small supplement only |
| default_min50 tail skip80 | 13 | 4 | 16 | 3.63 | weak supplement |
| build_min50 | 4 | 2 | 8 | 4.43 | downweight |
| default_min50 bridge 08-40 | 1 | 2 | 8 | 0.66 | downweight |

## Category / Segment Findings
- highest collection rate: kids/toys high-price tail segment. It produced stable batches: 20, 19, 5, 8, 19, 22, 9, 49, 11, 16, 2. This is the best source for more favorites and likely better downstream product relevance.
- strongest secondary source: default China highlight mid segment after skipping the first 40 fresh sellers. It produced large spikes such as +47, +21, +19, but was volatile and needs early stop.
- profit-stable candidates by historical evidence: kids/toys, blocks/RC/BJD/toy accessories, small electronics/protective accessories, pet/small home utility when the source is clean.
- high favorite but lower profit stability: broad default pool and broad electronics. They find many sellers, but drift into laptops, phones, monitors, bathroom, medical devices, and large goods.
- low or downweighted: models current page, collectibles current page, pet category=12300 current page, build/tools current page, default front/bridge/tail segments. They either drifted heavily or produced weak favorite delta.

## What Changed During The Loop
- Kept scroll speed/wait parameters stable.
- Changed only source/segment selection per round.
- Stopped sources early when category drift or low-yield batches showed no improvement.
- Found that page segment is more important than category label: the same `kids_toys_min500` source was mediocre in the front but excellent after skipping weak early sellers.

## Final Strategy To Keep
1. Start with `kids_toys_min500`, but do not blindly scan from the beginning. Prioritize the tail/mid seller segments where toy/BJD/RC/blocks stores appear.
2. Use `default_min50` only as a secondary pool, and skip the first weak seller segment. Best tested window: after roughly the first 40 fresh sellers.
3. Keep low-delta early stop. It prevented wasting time on default front, build, model, pets, collectibles, and electronics drift.
4. Treat broad electronics and default as collection sources only; downstream profit filtering must aggressively downweight laptops, phones, monitors, medical devices, large bathroom goods, tires, furniture, and other big/brand-risk items.
5. For next loop, optimize one thing first: build a cleaner source finder that can jump directly into toy/BJD/RC/blocks seller segments instead of relying on broad category pages.

## Fallback Diagnosis
- largest bottleneck: source quality and segment drift, not scroll speed.
- next single optimization point: source selection. Specifically, identify and start from toy/BJD/RC/blocks seller clusters inside `kids_toys_min500`, or add a checkpointed seller collector so productive mid/tail segments can be resumed without reprocessing weak front pages.
- continue: kids/toys high-price tail, default mid segment, small electronics/protective accessories only when they appear in high-yield batches.
- downweight or early-stop: default front/bridge/tail, broad electronics, current collectibles category, current pets category, build/tools, models current page.

## Continuation Round 1 - mined curated RC/blocks/toys
- favorite_delta: 12
- batches: 3
- fav/min: 5.49
- current favorite total: 622
- result: relevant but declining; batch deltas 6, 4, 2, early stopped.

## Continuation Round 2 - blocks search min500
- source extraction stopped early: only about 5 products after 50 scroll steps.
- result: Ozon search entry is inefficient for current script.
- adjustment: switch kids category to min1000 price segment.

## Continuation Round 3 - kids_toys_min1000
- favorite_delta: 19
- batches: 2
- fav/min: 14.0
- current favorite total: 666
- result: quality OK but source nearly exhausted after dedupe.

## Continuation Round 4 - toys_games_7108_min500
- favorite_delta: 13
- batches: 2
- fav/min: 7.26
- current favorite total: 777
- result: clean product entry but fresh seller pool small after dedupe.

## Continuation Round 5 - kids_outdoor_30726_min500
- source extraction stopped early: first 37 products yielded only 6 sellers.
- result: duplicate-heavy and large-goods dominated; downweighted.

## Continuation Round 6 - school_learning_7182_min50
- source extraction stopped early due category drift into medical/e-bike/razor/outdoor goods.
- result: downweighted.

## Continuation Round 7 - toys_games_7108_min50
- favorite_delta: 10
- batches: 2
- fav/min: 10.02
- current favorite total: 865
- result: clean but fresh seller pool limited.

## Continuation Round 8 - toys_games_7108_min1000
- favorite_delta: 0
- batches: 1
- fav/min: 0.0
- current favorite total: 865
- result: clean high-price toy entry, but seller pool exhausted after dedupe; only 1 fresh seller and no favorite increase.

## Continuation Round 9 - kids_toys_min500 deep retry
- favorite_delta: 0
- batches: 0
- fav/min: 0.0
- current favorite total: 865
- result: stopped. Current category=7000/min500 page exposed only 11 products, drifted into large goods, and yielded 0 seller links.

## Continuation Round 10 - remaining children/toy unscanned gap
- favorite_delta: 12
- batches: 3
- fav/min: about 4.8
- current favorite total: 877
- result: useful small supplement, then declined. Batch deltas: 7, 1, 4; low-yield early stop triggered.

## Continuation Round 11 - default_min50 mid remaining
- favorite_delta: 6
- batches: 1
- fav/min: about 4.0
- current favorite total: 883
- result: small supplement only; default tail remains downweighted.

## Continuation Round 12 - constructors_7174_min50
- favorite_delta: 1
- batches: 2
- fav/min: about 0.5
- current favorite total: 887
- result: downweighted. Product pool looked relevant, but new sellers were mixed and low-yield. Batch deltas: 1, 0.

## Continuation Round 13 - dolls/BJD 31272 min50
- favorite_delta: 0
- batches: 1
- fav/min: 0.0
- current favorite total: 888
- result: BJD product relevance was high but seller pool was only 2 and produced no favorite increase; mark as high-quality low-efficiency.

## Continuation Round 14 - figures/accessories 7169 visible probe
- favorite_delta: 0
- batches: 1
- fav/min: 0.0
- current favorite total: 889
- result: downweighted. Category drifted into tools/food/large goods and only produced 1 fresh seller.

# High-Yield Continuation Final - 2026-06-17

## Status
- target favorite count: 1000
- final observed favorite count: 889
- remaining gap: 111
- decision: stop high-yield continuation here instead of violating the strategy by hard-scanning downweighted categories or default tail.

## Batch Results After 865
| round | source | fresh sellers | delta | fav after | judgment |
| --- | --- | ---: | ---: | ---: | --- |
| cont-8 | toys_games_7108_min1000 | 1 | 0 | 865 | exhausted_clean_high_price_segment |
| cont-9 | kids_toys_min500_deep2_retry | 0 | 0 | 865 | source_drift_and_zero_seller_extraction |
| cont-10 | children_toy_remaining_unscanned | 12 | 12 | 877 | remaining_high_yield_gap_declining |
| cont-11 | default_min50_mid_remaining_76_79 | 4 | 6 | 883 | small_supplement_only |
| cont-12 | constructors_7174_min50 | 7 | 1 | 887 | low_yield_despite_relevant_products |
| cont-13 | dolls_bjd_31272_min50 | 2 | 0 | 888 | high_relevance_low_efficiency |
| cont-14 | figures_7169_visible_probe | 1 | 0 | 889 | low_yield_category_drift |
| cont-15 | plush_7175_min50 | 0 | 0 | 889 | aborted_thin_unstable_source |
| cont-16 | toy_weapons_7141_min50 | 1 | 0 | 889 | low_yield_category_drift |
| cont-17 | visible_store_reverse_extracted_youbest01 | 1 | 0 | 889 | seller_filter_reverse_extraction_low_yield |
| cont-18 | hidden_seller_link_hikettle | 1 | 0 | 889 | hidden_seller_link_low_yield |

## Segment Conclusions
- keep long term: kids/toys high-price tail (`kids_toys_min500` mid/tail), mined pure toy tail sellers, and clean `Игрушки и игры` product entry when it still yields fresh sellers. These produced the only strong batches.
- keep but mark high-quality low-efficiency: BJD/dolls. Product relevance was high, but seller pool collapsed to 2 and favorite delta was 0. Use for quality scouting, not for fast favorite volume.
- supplement only: `default_min50` middle window. It still produced +6 in the remaining mid gap, but front/tail remain downweighted.
- downweight or early-stop: current constructors 7174, figures 7169, plush 7175, toy weapons 7141, outdoor 30726, school 7182, electronics, build/tools, pets, collectibles, default front/bridge/tail. They were either seller-concentrated, category-drifted, or low-yield.

## Current Default Strategy
1. Start from kids/toys high-price tail and previously mined pure toy-tail sellers.
2. Use `Игрушки и игры` only while fresh sellers appear; stop immediately when fresh pool falls below a useful batch or two low-yield batches occur.
3. Use default min50 only in the proven middle window as backup volume, never front or tail by default.
4. Treat BJD/RC/blocks as quality scouts; they are worth checking for profit, but current pages do not supply enough new sellers for 1000-favorite volume.
5. Do not spend time on broad electronics/build/collectibles/pets or large-goods children pages unless a new source signal proves otherwise.

## Bottleneck
- current largest bottleneck: source exhaustion and seller concentration, not scroll speed. The same C-group pacing was kept throughout.
- next single optimization point: build or add a source finder that can discover fresh seller clusters from Ozon filter/shop data, instead of repeatedly entering exhausted category pages.

# New Category Discovery - 2026-06-18

## Status
- target favorite count: 1000
- final observed favorite count: 1000
- result: completed.
- method: stopped hard-scanning exhausted toy/BJD/blocks sources and expanded into new China-highlight hobby segments.

## New Candidate Results
| round | source | segment | fresh sellers | favorite result | judgment |
| --- | --- | --- | ---: | --- | --- |
| new-1 | accessories_7697_refresh | broad accessories; mixed toy/card/apparel/welding/car-key sellers | 7 | +0 | downweight broad accessories, but it exposed tabletop/card signal |
| new-2 | playing_cards_13517_filtered_cards_tabletop | playing cards, DND, UNO, Bicycle, collectible cards | 9 | +14 seller-scan delta; product exploration also lifted total from 889 to 907 | effective medium; enter priority queue |
| new-3 | tabletop_13506_filtered_tabletop | tabletop/card-game sellers | 3 | +17 | strongest clean new seller segment; promote |
| new-4 | boardgame_accessories_dice_13523_filtered_dnd | DND dice / board-game accessories | 2 | seller scan +0, but product exploration lifted total from 948 to 975 | high-quality low-seller-volume; use for product exploration, not seller-scan volume |
| new-5 | paint_by_numbers_13568_china | paint by numbers / hobby painting | 0 | +0 | product pool clean but seller extraction failed; downweight for seller scanning |
| new-6 | hobby_creativity_13500_china | broad hobby parent: music gear, tabletop, keyboards, tools, phone accessories | 20 | observed total 975 -> 999 during partial scan; batch delta unreliable due Chrome count timeout | volume candidate with quality risk |
| new-7 | hobby_next4_tabletop_hobby_to_1000 | selected tabletop/hobby/creative sellers from 13500 | 4 | +1, reached 1000 | completed target; use only as controlled supplement |

## New High-Favorite Categories Found
- Strongest clean new segment: `Настольные и карточные игры` / tabletop and card games, especially `category=13506` after filtering to tabletop/card-game sellers. Small seller sample but high Maozi response: 3 sellers produced +17.
- Effective medium segment: `Игральные карты` / playing cards, `category=13517`, filtered to cards/DND/UNO/Bicycle/collectible-card products. 9 sellers produced +14 and the product exploration phase also triggered favorites.
- Quality scout, not volume source: `Аксессуары для настольных игр` / DND dice, `category=13523`. Product relevance is very clean and small/light, but seller pool is concentrated. Use for product browsing and profit quality, not fast seller scanning.
- Controlled supplement: broad `Хобби и творчество` / hobby and creativity, `category=13500`. It can create volume, but mixes large instruments, tools, keyboards, bags, phone accessories, and tabletop goods. It should be filtered or handpicked before scanning.

## Old Sources Confirmed Exhausted
- `kids_toys_min500` tail and mined pure toy tail remain historically best, but the current fresh pool is exhausted.
- `Игрушки и игры 7108` still gives clean products, but new sellers are too concentrated now.
- BJD/dolls, constructors, figures, plush, toy weapons: relevant products, weak new seller volume or low favorite delta.
- default front/bridge/tail, broad electronics, build/tools, pets, collectibles, school/learning, outdoor/large-goods children pages remain downweighted.

## Updated Default Priority
1. Start with fresh `kids/toys` high-price tail if a new seller cluster is available.
2. Then scan `tabletop/card games` (`13506`) and `playing cards` (`13517`) with text filtering for cards, DND, UNO, Bicycle, tabletop, collectible-card products.
3. Use DND dice (`13523`) as a product-quality scout, not as the main favorite-volume source.
4. Use broad hobby (`13500`) only as a controlled supplement: handpick tabletop/hobby/creative sellers and avoid expanding into musical-instrument or large-goods tails.
5. Keep low-yield early stop and keep profit/quality filters unchanged.

## Next Optimization Point
- Build a source selector that extracts Ozon breadcrumb/category IDs from successful products and then filters product text before seller extraction. The manual run showed this works: broad categories are noisy, but filtered tabletop/card-game products produce better seller segments.

# Long-Term Pool Memory

The high-yield findings from this run have been promoted from one-off notes into long-term pool memory:

- human-readable strategy: [docs/flow_b_pool_memory_strategy.md](/Users/mac/.codex/worktrees/3b6c/ozon/flow_b_codex_transfer_20260608/docs/flow_b_pool_memory_strategy.md)
- structured pool memory: [config/flow_b_pool_memory.json](/Users/mac/.codex/worktrees/3b6c/ozon/flow_b_codex_transfer_20260608/config/flow_b_pool_memory.json)

## Pool Memory Snapshot

| pool type | pools |
| --- | --- |
| main | `kids_toys_high_price_tail`, `tabletop_card_games`, `playing_cards_collectible_cards` |
| supplement | `default_min50_middle_window`, `hobby_creativity_controlled` |
| watch | `dnd_dice_quality_scout`, `bjd_dolls_quality_scout` |
| exhausted | current toys subcategory pages: `7108`, `7174`, `7169`, `7175`, `7141` |
| downweight | broad electronics, build/tools, collectibles current page, pets current page, outdoor children goods, school/learning, paint-by-numbers seller scan, broad accessories |

## Automatic Switching Rule

Start with the current main pool. If fresh sellers fall below 3, if 10 relevant products produce 2 or fewer fresh sellers, or if two consecutive scan batches have favorite delta below 5, mark that pool exhausted for the run and switch to the next main pool.

Main order:

1. `kids_toys_high_price_tail`
2. `tabletop_card_games`
3. `playing_cards_collectible_cards`

If main pools decay, switch to supplement pools:

1. `default_min50_middle_window`
2. `hobby_creativity_controlled`

If supplement pools also decay or quality risk becomes too high, use watch pools only to discover new category breadcrumbs. Do not hard-scan watch pools for volume unless a new validation shows stronger seller delta.

## Promotion Rule

A new candidate can enter the priority queue only after validation:

- two batches with average fav/min >= 8; or
- one small clean-seller validation with favorite_delta >= 15.

Otherwise it stays as supplement, watch, exhausted, or downweighted according to the pool memory file.
