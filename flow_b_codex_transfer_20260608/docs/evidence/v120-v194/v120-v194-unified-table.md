# v120–v194 统一实验事实表

生成时间：2026-07-25T00:50:06.614Z

统一口径：

- 候选：acceptance window 内 `collection_attempt_count` 与 candidate/stage/selected 唯一 SKU 并集两者的较大值；这样既保留列表页淘汰，也不会漏掉窗口起点已进入本 run 流水线的 SKU。
- pure FBS：详情确认后进入 `profit_upper_bound` 的唯一 SKU；不以列表页推断代替详情验证。
- 可靠成本：得到可靠 1688 成本并进入 `profit_calculation` 的唯一 SKU。
- 利润通过：`selected.jsonl` 中利润率严格大于 30% 且选择时间位于窗口内的唯一 SKU。
- 提交：进入 `maozi_publish_and_confirm` 的唯一 SKU。
- 窗口确认：窗口内 ERP/Ozon 最终 selling 且库存大于 0 的唯一 SKU。
- 其中承接：窗口确认中并非由本版本首次选择，而是前序窗口待确认的 SKU。
- 迟到确认：本版本窗口内选择、窗口结束后才首次严格确认的 SKU。
- 严格速度只使用窗口确认；“含迟到生产速度”另在 CSV/JSON 中按“本窗口自产确认 + 本窗口选择后迟到确认”归因，避免把前序积压算成本版本产能。
- C/S/B/R 分别为 CAPTCHA、soft-block、browser crash/disconnect、runtime error 的证据计数。
- 缺少完整 acceptance summary 的运行标记为“无有效实验”，不参与排名。

| 版本 | 类型 | 唯一变量 | 时长(min) | 候选 | pure FBS | 可靠成本 | 利润通过 | 提交 | 窗口确认 | 其中承接 | 迟到确认 | 严格速度/h | 风控/错误 | commit |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| v120 | 配置 | restrict-source-dispatch-to-three-v119-full-funnel-sources | 10 | 18 | 3 | 2 | 0 | 0 | 2 | 2 | 0 | 12.0 | C0/S0/B0/R0 | `6cd21c8736cb09a1afb8509d5aece9236addc742` |
| v121 | 代码+配置 | require-listing-plugin-fbs-evidence-before-detail | 10 | 14 | 10 | 6 | 4 | 4 | 1 | 0 | 3 | 6.0 | C0/S0/B0/R0 | `c4d2943262b60f531b910c265669a8aa938a9c46` |
| v122 | 配置 | reuse-scanned-source-checkpoint-after-listing-fbs-evidence-gate | 10 | 4 | 4 | 1 | 0 | 0 | 3 | 3 | 0 | 18.0 | C0/S0/B0/R0 | `fb5226a1b452e33129df1015bfbc8ed323de865d` |
| v123 | 代码+配置 | inherit-confidence-limited-seller-family-score-for-unseen-url-variants | 10 | 4 | 3 | 2 | 1 | 1 | 0 | 0 | 1 | 0.0 | C0/S0/B0/R0 | `2488ac3e150724639232cbba2e045463bfc63271` |
| v124 | 配置 | count-only-gate-admissible-fbs-cards-for-source-exhaustion | — | — | — | — | — | — | **无有效实验** | — | — | — | — | 2488ac3e150724639232cbba2e045463bfc63271 |
| v124b | 代码+配置 | count-only-gate-admissible-fbs-cards-for-source-exhaustion | 10 | 6 | 5 | 4 | 2 | 2 | 2 | 0 | 0 | 12.0 | C0/S0/B0/R0 | `0b00ad60ca6fd678fdde7e1637971d10f88dd1e5` |
| v125 | 配置 | remove-bounded-deep-exemption-from-scan-exhaustion-penalty | 10 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `faff67ed07027acf4a84e725d59ba66f1652e8dc` |
| v126 | 配置 | seed-latest-strict-source-yield-across-runs | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `7448422a08689855b00b6fd33fbabf02bd72832c` |
| v127 | 配置 | exact-allowlist-latest-strict-derived-searches | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `9ee9548a656d0295076b0841e1886ba9c7e39532` |
| v128 | 配置 | replace-title-searches-with-next-unseen-productive-seller-pages | 10 | 2 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `365dc541fd5991b95e43fc7bf4fb4a2605a72c32` |
| v129 | 配置 | seed-only-untouched-exact-fbs-historical-cards | 10 | 4 | 3 | 1 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `f8c49e7bab204128769be7cbf5f3c9448fdb2fde` |
| v130 | 配置 | enable-bounded-retained-replay-12 | 10 | 21 | 16 | 13 | 9 | 9 | 4 | 0 | 4 | 24.0 | C0/S0/B0/R0 | `196394012d68c2a3317e1d70f8af5411307c2be7` |
| v131 | 配置 | formal-30m-window-after-v130-entry-gate | — | — | — | — | — | — | **无有效实验** | — | — | — | — | 5b352266d98ec61c4d210365a8cc36328d2b27bd |
| v131b | 配置 | correct-consumer-target-and-restart-full-30m | 30 | 46 | 22 | 7 | 5 | 6 | 6 | 3 | 2 | 12.0 | C0/S0/B0/R0 | `342696bb67e083ee76770ee60ea49062a6b05c9a` |
| v132 | 配置 | replace-retained-long-tail-with-proven-source-frontier | 10 | 12 | 10 | 9 | 7 | 7 | 4 | 3 | 5 | 24.0 | C0/S0/B0/R0 | `7a9e5902b606a83c579e0ca9ea9211852ad378d2` |
| v133 | 配置 | continue-v132-proven-source-frontier | 30 | 12 | 8 | 4 | 3 | 3 | 6 | 5 | 0 | 12.0 | C0/S0/B0/R0 | `cc296cb8192e81032655d4c667d485d3268e70e7` |
| v134 | 代码+配置 | exact-allowlist-preserves-explicit-page | 10 | 11 | 10 | 7 | 6 | 6 | 0 | 0 | 3 | 0.0 | C0/S0/B0/R0 | `1a51a6fe650d21db608f01e91628c151346433b8` |
| v135 | 配置 | continue-exact-page-dispatch-with-pending-reconciliation | 10 | 16 | 12 | 7 | 6 | 6 | 0 | 0 | 5 | 0.0 | C0/S0/B0/R0 | `6f783fc20d9144bfaa5a3263b2439f96d8f6d95a` |
| v136 | 配置 | continue-exact-page-dispatch-with-pending-reconciliation | 10 | 6 | 5 | 4 | 4 | 4 | 3 | 3 | 4 | 18.0 | C0/S0/B0/R0 | `db3fa7c5b7209e03d3beed835a737e22540c5bda` |
| v137 | 配置 | continue-exact-page-dispatch-with-pending-reconciliation | 10 | 4 | 1 | 1 | 1 | 1 | 4 | 4 | 1 | 24.0 | C0/S0/B0/R0 | `b57fb922b337edf339e400476e7e40cb621c5d9e` |
| v138 | 配置 | broaden-exact-frontier-across-top-full-funnel-sellers | — | — | — | — | — | — | **无有效实验** | — | — | — | — | c70e6a24d8d139cbad848807ca2faeba6c27a436 |
| v139 | 配置 | continue-exact-frontier-across-top-full-funnel-sellers | 30 | 24 | 20 | 17 | 12 | 12 | 10 | 3 | 3 | 20.0 | C0/S0/B0/R0 | `c70e6a24d8d139cbad848807ca2faeba6c27a436` |
| v140 | 配置 | narrow-frontier-to-v139-highest-candidate-yield-sellers | 10 | 5 | 5 | 4 | 3 | 3 | 4 | 1 | 0 | 24.0 | C0/S0/B0/R0 | `ed49e7ef4a91a80c19ffc88405e51f363de88782` |
| v141 | 配置 | candidate-queue-per-source-drain-2-to-4 | 10 | 25 | 12 | 11 | 5 | 5 | 2 | 0 | 1 | 12.0 | C0/S0/B0/R0 | `dcd590b9d869321f255a863432c3d047bf11ac97` |
| v142 | 配置 | query-variant-frontier-instead-of-base-seller-deep-pages | 10 | 16 | 10 | 8 | 6 | 6 | 3 | 1 | 1 | 18.0 | C0/S0/B0/R0 | `2211c78db47bd1072f0f32c1190e21106d5d1fd0` |
| v143 | 配置 | latest-full-funnel-source-reranking | 10 | 21 | 13 | 11 | 7 | 7 | 7 | 1 | 1 | 42.0 | C0/S0/B0/R0 | `7db6f8f9a66603f3e885dde110d1fef4638ec0d0` |
| v144 | 配置 | expand-v143-passing-source-frontier-for-30m | 30 | 9 | 6 | 4 | 1 | 1 | 2 | 1 | 0 | 4.0 | C0/S0/B0/R0 | `64e7291ba8f3fb4000787f2dc3f6dee18c63dbc7` |
| v145 | 配置 | replace-dry-deep-pages-with-historical-high-final-yield-pages | 10 | 23 | 14 | 10 | 6 | 6 | 1 | 0 | 3 | 6.0 | C0/S0/B0/R0 | `a3a71563b5935ac7868abc75dcdef0620408b589` |
| v146 | 配置 | shrink-and-rerank-to-pages-with-observed-candidate-headroom | 10 | 5 | 5 | 4 | 2 | 2 | 5 | 3 | 0 | 30.0 | C0/S0/B0/R0 | `99f8dacc277cc614290df099c31892b5894ec115` |
| v147 | 配置 | expand-passing-fresh-headroom-source-strategy-for-30m | 30 | 20 | 16 | 13 | 6 | 6 | 5 | 0 | 0 | 10.0 | C0/S0/B0/R0 | `3411e6b405167698f7fb433fe06c08e879c564a1` |
| v148 | 配置 | remove-zero-yield-sellers-and-focus-scan-on-miaowu | 10 | 6 | 6 | 5 | 3 | 3 | 1 | 0 | 1 | 6.0 | C0/S0/B0/R0 | `5a5dc11affb054cb01fc6d1fd6f07954468636ab` |
| v149 | 配置 | replace-miaowu-deep-pages-with-unexplored-proven-seller-pages | 10 | 5 | 5 | 1 | 1 | 1 | 1 | 1 | 0 | 6.0 | C0/S0/B0/R0 | `c9c97b733fb4200d2a34088e87c990498228ca78` |
| v150 | 配置 | max-retained-links-0-to-12 | 10 | 4 | 4 | 1 | 1 | 1 | 0 | 0 | 1 | 0.0 | C0/S0/B0/R0 | `e77f916ddb385ea82cd26a273666f0b17c89947c` |
| v151 | 配置 | listing-fbs-evidence-required-1-to-0 | 10 | 36 | 1 | 0 | 0 | 0 | 1 | 1 | 0 | 6.0 | C0/S0/B0/R0 | `eafcbe3a21d3fec4b6b60435551b9fc038094e19` |
| v152 | 配置 | replace-seller-deep-pages-with-strict-success-searches | 10 | 4 | 3 | 2 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `9ced96cd67a913087a5cc44adfd10b48bb909524` |
| v153 | 配置 | replace-strict-searches-with-sorted-catalog-variants | 10 | 3 | 2 | 2 | 1 | 1 | 0 | 0 | 1 | 0.0 | C0/S0/B0/R0 | `853de9c812316d57b2d61c41538d763be3cb2cb1` |
| v154 | 配置 | replace-exhausted-known-sellers-with-unconsumed-global-sellers | 10 | 9 | 6 | 2 | 0 | 0 | 1 | 1 | 0 | 6.0 | C0/S0/B0/R0 | `fdf28accf58eff7c64aee47f3aedbf5c33aff44b` |
| v155 | 配置 | replace-global-seller-batch1-with-unconsumed-global-seller-batch2 | 10 | 16 | 12 | 5 | 4 | 4 | 3 | 0 | 1 | 18.0 | C0/S0/B0/R0 | `dd325329d440363562d068f49ce2d4f6337bc807` |
| v156 | 配置 | rank-source-pages-by-v155-strict-final-yield | 10 | 23 | 11 | 9 | 7 | 7 | 6 | 1 | 2 | 36.0 | C0/S0/B0/R0 | `ec549c6e351bbc7346c9b5f5897074da22334b22` |
| v157 | 配置 | extend-the-v156-ranked-source-policy-to-a-30-minute-window | 30 | 49 | 32 | 12 | 7 | 7 | 6 | 2 | 1 | 12.0 | C0/S0/B0/R0 | `c043c8c255c7ad756cf0d07af2f1442786105673` |
| v158 | 配置 | replace-exhausted-winner-deep-pages-with-unconsumed-global-seller-batch3 | 10 | 19 | 11 | 2 | 1 | 1 | 1 | 1 | 1 | 6.0 | C0/S0/B0/R0 | `097352abcd561782edc2bbd00c43dca950b09e7b` |
| v159 | 配置 | replace-unproven-global-sellers-with-unscanned-pages-from-proven-seller-families | 10 | 10 | 9 | 6 | 2 | 2 | 2 | 0 | 0 | 12.0 | C0/S0/B0/R0 | `b908ffa6c4b0ee27f836046367e4740e5b26bdee` |
| v160 | 配置 | replace-sparse-deep-pages-with-unscanned-adjacent-pages-of-proven-price-sort-variants | 10 | 2 | 2 | 1 | 1 | 1 | 0 | 0 | 1 | 0.0 | C0/S0/B0/R0 | `a63ed3c06bcadff40081ce801876c2a7937f02ef` |
| v161 | 配置 | replace-exhausted-seller-pages-with-standardized-commodity-global-searches | 10 | 4 | 4 | 2 | 1 | 1 | 1 | 1 | 1 | 6.0 | C0/S0/B0/R0 | `8f37b30300f9e6f1017d5477c36dd959d071d451` |
| v162 | 配置 | admit-listing-mode-unknown-global-search-results-to-real-detail-fbs-verification | 10 | 38 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `f4e5a03df8ff22bd11b507b06cbceebc9ac86bc0` |
| v163 | 配置 | replace-standardized-searches-with-unscanned-observed-funnel-sellers | 10 | 13 | 11 | 6 | 3 | 3 | 2 | 0 | 1 | 12.0 | C0/S0/B0/R0 | `4b609e0085f526f67431619fb67835d27a07abb2` |
| v164 | 配置 | restrict-source-frontier-to-three-v163-sellers-that-produced-submissions | 10 | 3 | 2 | 1 | 1 | 1 | 2 | 1 | 0 | 12.0 | C0/S0/B0/R0 | `f7bdebc5f73b4ab1ad7b97182ab837e586b81bae` |
| v165 | 配置 | extend-unscanned-ordinary-pages-of-historically-proven-sellers | 10 | 4 | 4 | 3 | 2 | 2 | 2 | 0 | 0 | 12.0 | C0/S0/B0/R0 | `16c5b1fa75fc3bd2f03a2362f49db51bbc0f4c77` |
| v166 | 配置 | move-from-v165-negative-frontiers-to-unvisited-proven-seller-frontiers | 10 | 2 | 2 | 1 | 1 | 1 | 1 | 0 | 0 | 6.0 | C0/S0/B0/R0 | `9d5352c71a6cfad2a93172fe73484d9a121f9845` |
| v167 | 配置 | replace-depleted-known-frontiers-with-never-scanned-seller-pages | 10 | 3 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `88f6ee985ec70b672dfadb26e534e042b9cda742` |
| v168 | 配置 | replace-seller-sources-with-tovary-iz-kitaya-odezhda-category-pages | 10 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `0ffbb3ce2fd8e7c97b8934ed36b1db1bb8b13d85` |
| v169 | 配置 | admit-listing-mode-unknown-only-from-four-public-import-seller-pages | 10 | 45 | 4 | 3 | 3 | 3 | 0 | 0 | 3 | 0.0 | C0/S0/B0/R0 | `6efbf6aad3c5d8e24e1113eec936daf435c0095b` |
| v170 | 代码+配置 | prefilter-listing-unknown-candidates-to-v169-productive-standardized-title-families | 10 | 35 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 6.0 | C0/S0/B0/R0 | `12f010ee2e090bcb0ed57e89f4a7a41df40255b5` |
| v171 | 代码+配置 | switch-from-v170-public-import-sellers-to-miaowu-page58-plus | 10 | 7 | 4 | 2 | 1 | 1 | 0 | 0 | 1 | 0.0 | C0/S0/B0/R0 | `41701b56152a9b67e46f9af4d712b59085c868fd` |
| v172 | 代码+配置 | refresh-uniquely-verified-warehouse-mapping-for-stores-106640-and-106644 | 10 | 6 | 4 | 3 | 1 | 1 | 10 | 10 | 1 | 60.0 | C0/S0/B0/R0 | `8a5766ae56319536faca9aef4dd8eaef384e94fc` |
| v173 | 配置 | — | 30 | 0 | 0 | 0 | 0 | 0 | 7 | 7 | 0 | 14.0 | C0/S0/B0/R0 | `93ca7a493061203c5d6346c47fa6b3e7b7713ecc` |
| v174 | 配置 | replace-depleted-source-set-with-unscanned-strict-final-sellers | 10 | 9 | 6 | 2 | 2 | 2 | 2 | 0 | 0 | 12.0 | C0/S0/B0/R0 | `c656af55d4bee2cbad9340617702861edb9ad12e` |
| v175 | 配置 | source-set-to-high-reliable-underwear-frontier | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `f913f0db7b664c609ab3c2e915da019a05743e17` |
| v176 | 配置 | source-set-to-v156-strict-winner-title-searches | 10 | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `c7d7914bbc1096fff195dc9294f6fe5496f1cf3a` |
| v177 | 配置 | source-set-to-unscanned-reliable-cost-sellers | 10 | 8 | 2 | 2 | 2 | 2 | 0 | 0 | 1 | 0.0 | C0/S0/B0/R0 | `e2dcfd761ecfe1657db1ec56a3749c894d07dc5f` |
| v178 | 代码+配置 | portfolio-interleave-inherits-exhausted-scan-family-demotion | 10 | 6 | 4 | 3 | 1 | 1 | 1 | 1 | 1 | 6.0 | C0/S0/B0/R0 | `6bcd9e07a23fb83480fda248c0e3aac2705d485e` |
| v179 | 代码+配置 | bounded-deep-protection-yields-after-two-bounded-dry-pages | 10 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 6.0 | C0/S0/B0/R0 | `c3aa1ebc404999ddec20871e0ac5ead7b37cbd96` |
| v180 | 代码+配置 | all-source-families-yield-after-two-consecutive-dry-pages | 10 | 3 | 2 | 2 | 2 | 2 | 2 | 0 | 0 | 12.0 | C0/S0/B0/R0 | `99f4535d3fca2516a6e06b2574843b12b668e608` |
| v181 | 配置 | source-set-to-all-remaining-unscanned-pure-fbs-sellers | 10 | 12 | 11 | 4 | 4 | 4 | 3 | 0 | 0 | 18.0 | C0/S0/B0/R0 | `e92af8bb1ba9ef4ba64b04647e2ecc0112243441` |
| v182 | 配置 | source-set-to-adjacent-pages-of-final-publish-winners | 10 | 8 | 7 | 4 | 3 | 3 | 3 | 0 | 0 | 18.0 | C0/S0/B0/R0 | `038c2d9919d9509ce6d7a9608f6a08d4e1637737` |
| v183 | 配置 | source-set-to-v181-unreached-unscanned-pure-fbs-sellers | 10 | 10 | 8 | 6 | 3 | 3 | 1 | 0 | 2 | 6.0 | C0/S0/B0/R0 | `d416ebaa9a8cd8d05f81ec0da513b33d9b5bf7e8` |
| v184 | 配置 | source-set-to-highest-eligible-density-v183-seller | 10 | 3 | 2 | 1 | 0 | 0 | 2 | 2 | 0 | 12.0 | C0/S0/B0/R0 | `fe25084c074977bf0de5f721e4cc0559a5018e82` |
| v185 | 配置 | source-set-to-interleaved-unscanned-discount-frontiers | 10 | 4 | 4 | 2 | 0 | 0 | 0 | 0 | 0 | 0.0 | C0/S0/B0/R0 | `28957bcae524ea9f81ea75a6479e9077df87b325` |
| v186 | 配置 | source-set-to-standardized-historical-winner-title-searches | 10 | 8 | 8 | 5 | 4 | 4 | 3 | 0 | 0 | 18.0 | C0/S0/B0/R0 | `5f9f33560c37ff689db453ef765dbca8e26d3a60` |
| v187 | 配置 | source-set-to-unconsumed-sock-title-variants | 10 | 12 | 11 | 8 | 8 | 8 | 3 | 1 | 5 | 18.0 | C0/S0/B0/R0 | `51e416dc2b34cf475978dd2c989b26a822a221c2` |
| v188 | 配置 | source-set-to-five-validated-dense-sock-pages | 10 | 0 | 0 | 0 | 0 | 0 | 5 | 5 | 0 | 30.0 | C0/S0/B0/R0 | `10e75d260b33a3eb2ce0ca22586b22ce79ae3b23` |
| v189 | 代码+配置 | formal-source-set-to-unconsumed-sock-title-and-deep-page-variants | 30 | 24 | 23 | 10 | 8 | 8 | 7 | 0 | 1 | 14.0 | C0/S0/B0/R0 | `0bf1d105565aa075446a79afcf68246969d46896` |
| v190 | 配置 | replace-low-yield-search-variants-with-historical-final-success-seller-pages | 10 | 17 | 14 | 9 | 4 | 4 | 2 | 1 | 3 | 12.0 | C0/S0/B0/R0 | `2652411b486bf4cdd2b971f7356727ea6e176625` |
| v191 | 配置 | remove-v190-dry-pages-and-use-remaining-unscanned-final-success-sellers | 10 | 16 | 8 | 4 | 4 | 4 | 7 | 3 | 0 | 42.0 | C0/S0/B0/R0 | `d0c2614a91533fec5f7e447ccd5be98cbc6158e9` |
| v192 | 配置 | formal-continuation-of-v191-final-success-seller-source-strategy | 30 | 12 | 9 | 5 | 3 | 3 | 2 | 0 | 1 | 4.0 | C0/S0/B0/R0 | `b452e3faa4d836277334b41830331af112dd3c22` |
| v193 | 配置 | replace-dry-unscanned-depth-with-logged-high-density-underconsumed-pages | 10 | 7 | 6 | 5 | 3 | 3 | 2 | 1 | 1 | 12.0 | C0/S0/B0/R0 | `0f226eea4638d583993d9ec8444a3c4fd3c7d990` |
| v194 | 配置 | newest-sort-on-historical-final-success-sellers | 10 | 2 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 6.0 | C0/S0/B0/R0 | `37955273cb3a5368fab7484145be0eaf1ac9e851` |
