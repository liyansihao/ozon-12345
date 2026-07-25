#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const runsRoot = path.join(root, "runs", "flow_b");
const outRoot = path.join(root, "docs", "evidence", "v120-v194");
fs.mkdirSync(outRoot, { recursive: true });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isoMs(value) {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function recordAt(row) {
  return isoMs(
    row?.data?.published_at ??
      row?.data?.reconciled_at ??
      row?.timestamp ??
      row?.at,
  );
}

function uniqSku(rows, predicate = () => true) {
  return new Set(
    rows
      .filter(predicate)
      .map((row) => String(row?.sku ?? row?.data?.sku ?? ""))
      .filter(Boolean),
  );
}

function countStage(rows, stage) {
  return uniqSku(rows, (row) => row.stage === stage).size;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function changedProductionFiles(previousCommit, commit) {
  if (!previousCommit || !commit || previousCommit === commit) return [];
  const output = git(["diff", "--name-only", previousCommit, commit, "--"]);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(
      (file) =>
        /(^|\/)(scripts|workers|src|lib)\//.test(file) &&
        !/(^|\/)(test|tests|fixtures)\//.test(file) &&
        !/\.test\.[cm]?[jt]s$/.test(file),
    );
}

const runDirs = fs
  .readdirSync(runsRoot)
  .map((name) => {
    const match = name.match(/_v(\d+)([a-z]*)$/);
    if (!match) return null;
    const versionNumber = Number(match[1]);
    if (versionNumber < 120 || versionNumber > 194) return null;
    return {
      name,
      dir: path.join(runsRoot, name),
      version: `v${match[1]}${match[2]}`,
      versionNumber,
      suffix: match[2],
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.name.localeCompare(b.name));

const runs = runDirs.map((run) => {
  const window = readJson(path.join(run.dir, "acceptance_window.json"));
  const acceptance = readJson(path.join(run.dir, "acceptance_summary.json"));
  const processInfo = readJson(path.join(run.dir, "process_info.json")) ?? {};
  const frozen = readJson(path.join(run.dir, "frozen_environment.json")) ?? {};
  const summary = readJson(path.join(run.dir, "summary.json")) ?? {};
  const stageSummary = readJson(path.join(run.dir, "stage_summary.json")) ?? {};
  const stageRows = readJsonl(path.join(run.dir, "stage_timings.jsonl"));
  const selectedRows = readJsonl(path.join(run.dir, "selected.jsonl"));
  const publishedRows = readJsonl(path.join(run.dir, "published.jsonl"));
  const failedRows = readJsonl(path.join(run.dir, "failed.jsonl"));
  const sourceRows = readJsonl(path.join(run.dir, "source_yield.jsonl"));
  const candidateRows = readJsonl(path.join(run.dir, "candidate_queue.jsonl"));
  const accessRows = readJsonl(path.join(run.dir, "ozon_access_timeline.jsonl"));
  const startMs = isoMs(window?.started_at);
  const endMs = isoMs(window?.ended_at);
  const durationHours =
    startMs != null && endMs != null && endMs > startMs
      ? (endMs - startMs) / 3_600_000
      : null;
  const commit =
    processInfo.frozen_commit ??
    frozen.FLOW_B_FROZEN_COMMIT ??
    processInfo.commit ??
    null;
  const valid =
    Boolean(window && acceptance && startMs && endMs) &&
    durationHours >= 0.15 &&
    Number.isFinite(Number(acceptance.success_count));
  const inWindowSkus = new Set(
    (acceptance?.skus ?? []).map(String).filter(Boolean),
  );
  const selected = uniqSku(
    selectedRows,
    (row) => {
      const at = isoMs(row?.data?.selected_at ?? row?.timestamp ?? row?.at);
      const profit = Number(row?.data?.profit_rate);
      return (
        at != null &&
        startMs != null &&
        endMs != null &&
        at >= startMs &&
        at <= endMs &&
        profit > 30
      );
    },
  );
  const submitted = countStage(stageRows, "maozi_publish_and_confirm");
  const incidents = {
    captcha: 0,
    softBlock: 0,
    browserCrash: 0,
    runtime: Number(acceptance?.runtime_error_count ?? 0),
  };
  const incidentText = JSON.stringify([
    acceptance?.failure_reasons ?? {},
    failedRows,
    accessRows,
  ]).toLowerCase();
  incidents.captcha = (incidentText.match(/captcha/g) ?? []).length;
  incidents.softBlock = (
    incidentText.match(/soft[-_ ]?block|soft[-_ ]?intercept/g) ?? []
  ).length;
  incidents.browserCrash = (
    incidentText.match(
      /browser[-_ ]?(crash|disconnect)|page[-_ ]?crash|target[-_ ]?closed/g,
    ) ?? []
  ).length;
  const errors =
    incidents.captcha +
    incidents.softBlock +
    incidents.browserCrash +
    incidents.runtime;

  return {
    ...run,
    window,
    acceptance,
    processInfo,
    frozen,
    summary,
    stageSummary,
    stageRows,
    selectedRows,
    publishedRows,
    failedRows,
    sourceRows,
    candidateRows,
    accessRows,
    startMs,
    endMs,
    durationHours,
    commit,
    valid,
    inWindowSkus,
    selected,
    submitted:
      submitted || Number(stageSummary?.maozi_publish_and_confirm?.count ?? 0),
    incidents,
    errors,
  };
});

// Build one strict final-confirmation timeline. The first confirmed record wins.
const confirmationBySku = new Map();
for (const run of runs) {
  for (const row of run.publishedRows) {
    const sku = String(row?.sku ?? row?.data?.sku ?? "");
    const at = recordAt(row);
    const profit = Number(row?.data?.profit_rate);
    const mode = String(
      row?.data?.shipping_mode ?? row?.data?.mode ?? row?.data?.preflight_mode ?? "",
    ).toUpperCase();
    const stock = Number(
      row?.data?.stock ?? row?.data?.online_product?.stock ?? 0,
    );
    const onlineStatus = String(
      row?.data?.online_status ?? row?.data?.online_product?.online_status ?? "",
    ).toLowerCase();
    if (
      !sku ||
      at == null ||
      row?.status !== "published" ||
      !(profit > 30) ||
      mode !== "FBS" ||
      !(stock > 0) ||
      onlineStatus !== "selling"
    ) {
      continue;
    }
    const prior = confirmationBySku.get(sku);
    if (!prior || at < prior.at) {
      confirmationBySku.set(sku, { sku, at, run: run.version, row });
    }
  }
}

// Attribute production to the first run that selected a SKU. This separates
// carry-in confirmations from work actually generated by the current version.
const selectedOrigin = new Map();
for (const run of runs) {
  for (const row of run.selectedRows) {
    const sku = String(row?.sku ?? row?.data?.sku ?? "");
    const selectedAt = isoMs(
      row?.data?.selected_at ?? row?.timestamp ?? row?.at,
    );
    if (!sku || selectedAt == null) continue;
    const prior = selectedOrigin.get(sku);
    if (!prior || selectedAt < prior.selectedAt) {
      selectedOrigin.set(sku, { sku, selectedAt, run });
    }
  }
}

let previousCommit = null;
for (const run of runs) {
  const candidateSkus = uniqSku(
    [...run.candidateRows, ...run.stageRows, ...run.selectedRows],
    (row) => {
      const at = isoMs(
        row?.at ??
          row?.timestamp ??
          row?.data?.selected_at ??
          row?.data?.prepared_at,
      );
      return (
        at != null &&
        run.startMs != null &&
        run.endMs != null &&
        at >= run.startMs &&
        at <= run.endMs
      );
    },
  );
  const recordedCandidateCount = Number(
    run.acceptance?.collection_attempt_count ?? 0,
  );
  const candidateCount = Math.max(recordedCandidateCount, candidateSkus.size);
  const pureFbs =
    countStage(run.stageRows, "profit_upper_bound") ||
    Number(run.stageSummary?.profit_upper_bound?.count ?? 0);
  const costQueries =
    countStage(run.stageRows, "1688_cost") ||
    Number(run.stageSummary?.["1688_cost"]?.count ?? 0);
  const reliableCost =
    countStage(run.stageRows, "profit_calculation") ||
    Number(run.stageSummary?.profit_calculation?.count ?? 0);
  const ownInWindow = [...run.inWindowSkus].filter(
    (sku) => selectedOrigin.get(sku)?.run === run,
  );
  const carryIn = [...run.inWindowSkus].filter(
    (sku) => selectedOrigin.get(sku)?.run !== run,
  );
  const late = [...run.selected].filter((sku) => {
    const confirmation = confirmationBySku.get(sku);
    return confirmation && run.endMs != null && confirmation.at > run.endMs;
  });
  const neverConfirmed = [...run.selected].filter(
    (sku) => !confirmationBySku.has(sku),
  );
  const attributableFinals = ownInWindow.length + late.length;
  const strictCount = run.valid ? run.inWindowSkus.size : null;
  const productionSpeed =
    run.valid && run.durationHours
      ? attributableFinals / run.durationHours
      : null;
  const strictSpeed =
    run.valid && run.durationHours ? strictCount / run.durationHours : null;
  const productionFiles = changedProductionFiles(previousCommit, run.commit);
  const configChanged = Boolean(
    run.processInfo.single_variable ||
      run.processInfo.source_strategy ||
      run.processInfo.source_checkpoint_seed,
  );
  const changeType = productionFiles.length
    ? configChanged
      ? "代码+配置"
      : "代码"
    : configChanged
      ? "配置"
      : "仅运行";
  if (run.commit) previousCommit = run.commit;

  Object.assign(run, {
    candidates: candidateCount,
    pureFbs,
    costQueries,
    reliableCost,
    profitPass: run.selected.size,
    inWindowCount: strictCount,
    ownInWindow,
    carryIn,
    late,
    neverConfirmed,
    attributableFinals,
    strictSpeed,
    productionSpeed,
    pureFbsRate:
      candidateCount > 0
        ? pureFbs / candidateCount
        : null,
    reliableCostRate: costQueries > 0 ? reliableCost / costQueries : null,
    finalConversion:
      run.selected.size > 0 ? attributableFinals / run.selected.size : null,
    productionFiles,
    changeType,
  });
}

const rows = runs.map((run) => ({
  version: run.version,
  run: run.name,
  valid: run.valid,
  commit: run.commit ?? "",
  change_type: run.changeType,
  unique_variable: run.processInfo.single_variable ?? "",
  window_minutes: run.durationHours == null ? "" : run.durationHours * 60,
  candidates: run.valid ? run.candidates : "",
  pure_fbs: run.valid ? run.pureFbs : "",
  reliable_cost: run.valid ? run.reliableCost : "",
  profit_pass: run.valid ? run.profitPass : "",
  submitted: run.valid ? run.submitted : "",
  in_window_confirmed: run.valid ? run.inWindowCount : "",
  carry_in_confirmed: run.valid ? run.carryIn.length : "",
  own_in_window_confirmed: run.valid ? run.ownInWindow.length : "",
  late_confirmed: run.valid ? run.late.length : "",
  attributable_finals: run.valid ? run.attributableFinals : "",
  strict_per_hour: run.valid ? Number(run.strictSpeed.toFixed(2)) : "",
  production_per_hour: run.valid
    ? Number(run.productionSpeed.toFixed(2))
    : "",
  pure_fbs_rate: run.pureFbsRate == null ? "" : run.pureFbsRate,
  reliable_1688_rate:
    run.reliableCostRate == null ? "" : run.reliableCostRate,
  final_conversion:
    run.finalConversion == null ? "" : run.finalConversion,
  captcha: run.incidents.captcha,
  soft_block: run.incidents.softBlock,
  browser_crash: run.incidents.browserCrash,
  runtime_error: run.incidents.runtime,
  production_files_changed: run.productionFiles.join(";"),
}));

const headers = Object.keys(rows[0]);
const csv = [
  headers.join(","),
  ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(",")),
].join("\n");
fs.writeFileSync(path.join(outRoot, "v120-v194-unified.csv"), `${csv}\n`);
fs.writeFileSync(
  path.join(outRoot, "v120-v194-unified.json"),
  `${JSON.stringify(rows, null, 2)}\n`,
);

const tableHeader =
  "| 版本 | 类型 | 唯一变量 | 时长(min) | 候选 | pure FBS | 可靠成本 | 利润通过 | 提交 | 窗口确认 | 其中承接 | 迟到确认 | 严格速度/h | 风控/错误 | commit |";
const tableRule =
  "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|";
const tableRows = runs.map((run) => {
  if (!run.valid) {
    return `| ${run.version} | ${run.changeType} | ${run.processInfo.single_variable ?? "—"} | — | — | — | — | — | — | **无有效实验** | — | — | — | — | ${run.commit ?? "未知"} |`;
  }
  const incident = [
    `C${run.incidents.captcha}`,
    `S${run.incidents.softBlock}`,
    `B${run.incidents.browserCrash}`,
    `R${run.incidents.runtime}`,
  ].join("/");
  return `| ${run.version} | ${run.changeType} | ${run.processInfo.single_variable ?? "—"} | ${(run.durationHours * 60).toFixed(0)} | ${run.candidates} | ${run.pureFbs} | ${run.reliableCost} | ${run.profitPass} | ${run.submitted} | ${run.inWindowCount} | ${run.carryIn.length} | ${run.late.length} | ${run.strictSpeed.toFixed(1)} | ${incident} | \`${run.commit ?? "未知"}\` |`;
});

const methodology = `# v120–v194 统一实验事实表

生成时间：${new Date().toISOString()}

统一口径：

- 候选：acceptance window 内 \`collection_attempt_count\` 与 candidate/stage/selected 唯一 SKU 并集两者的较大值；这样既保留列表页淘汰，也不会漏掉窗口起点已进入本 run 流水线的 SKU。
- pure FBS：详情确认后进入 \`profit_upper_bound\` 的唯一 SKU；不以列表页推断代替详情验证。
- 可靠成本：得到可靠 1688 成本并进入 \`profit_calculation\` 的唯一 SKU。
- 利润通过：\`selected.jsonl\` 中利润率严格大于 30% 且选择时间位于窗口内的唯一 SKU。
- 提交：进入 \`maozi_publish_and_confirm\` 的唯一 SKU。
- 窗口确认：窗口内 ERP/Ozon 最终 selling 且库存大于 0 的唯一 SKU。
- 其中承接：窗口确认中并非由本版本首次选择，而是前序窗口待确认的 SKU。
- 迟到确认：本版本窗口内选择、窗口结束后才首次严格确认的 SKU。
- 严格速度只使用窗口确认；“含迟到生产速度”另在 CSV/JSON 中按“本窗口自产确认 + 本窗口选择后迟到确认”归因，避免把前序积压算成本版本产能。
- C/S/B/R 分别为 CAPTCHA、soft-block、browser crash/disconnect、runtime error 的证据计数。
- 缺少完整 acceptance summary 的运行标记为“无有效实验”，不参与排名。

${tableHeader}
${tableRule}
${tableRows.join("\n")}
`;

fs.writeFileSync(
  path.join(outRoot, "v120-v194-unified-table.md"),
  methodology,
);

const validRuns = runs.filter((run) => run.valid);
const rank = (selector, filter = () => true) =>
  validRuns
    .filter(filter)
    .slice()
    .sort((a, b) => selector(b) - selector(a))
    .slice(0, 10)
    .map((run) => ({
      version: run.version,
      run: run.name,
      commit: run.commit,
      value: selector(run),
      candidates: run.candidates,
      selected: run.selected.size,
      inWindow: run.inWindowCount,
      carryIn: run.carryIn.length,
      late: run.late.length,
      incidents: run.errors,
    }));

const rankings = {
  strict_speed: rank((run) => run.strictSpeed),
  production_speed_with_late: rank((run) => run.productionSpeed),
  pure_fbs_rate: rank(
    (run) => run.pureFbsRate ?? -1,
    (run) => run.candidates >= 5,
  ),
  reliable_1688_rate: rank(
    (run) => run.reliableCostRate ?? -1,
    (run) => run.costQueries >= 5,
  ),
  final_conversion: rank(
    (run) => run.finalConversion ?? -1,
    (run) => run.selected.size >= 3,
  ),
  stability: rank(
    (run) =>
      (run.errors === 0 ? 1_000 : 0) +
      run.durationHours * 100 +
      run.inWindowCount,
    (run) => run.inWindowCount > 0,
  ),
};
fs.writeFileSync(
  path.join(outRoot, "rankings.json"),
  `${JSON.stringify(rankings, null, 2)}\n`,
);

console.log(
  JSON.stringify(
    {
      output: outRoot,
      runs: runs.length,
      valid: validRuns.length,
      invalid: runs.length - validRuns.length,
      top: Object.fromEntries(
        Object.entries(rankings).map(([key, value]) => [key, value[0] ?? null]),
      ),
    },
    null,
    2,
  ),
);
