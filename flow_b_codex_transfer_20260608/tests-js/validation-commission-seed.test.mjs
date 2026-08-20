import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadValidationCandidateFile } from "../scripts/flow_b_playwright/validation-candidate-file.mjs";
import {
  loadValidationCommissionSeedFromEnv,
  VALIDATION_COMMISSION_SEED_CONTRACT,
  VALIDATION_COMMISSION_SEED_ENV,
} from "../scripts/flow_b_playwright/validation-commission-seed.mjs";
import { validationCandidateSetSha256 } from "../scripts/flow_b_playwright/validation-signed-evidence-replay.mjs";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fixture(t, mutate = () => {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-commission-seed-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const candidateFile = path.join(directory, "candidates.json");
  const sourceFile = path.join(directory, "category-source.jsonl");
  const seedFile = path.join(directory, "commission-seed.json");
  const rows = [{
    sku: "3832171441",
    title: "Светильник настенный 12W 3000K",
    sell_price: 42.23,
    cover_image: "https://img.example/3832171441.jpg",
  }];
  const candidateBytes = Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, "utf8");
  const sourceBytes = Buffer.from('{"sku":"3832171441","cate":[17027482,200001698,"1,12.00"]}\n', "utf8");
  await fs.writeFile(candidateFile, candidateBytes);
  await fs.writeFile(sourceFile, sourceBytes);
  const candidates = await loadValidationCandidateFile(candidateFile, { validationOnly: true });
  const manifest = {
    contract: VALIDATION_COMMISSION_SEED_CONTRACT,
    created_at: "2026-08-16T08:59:00.000Z",
    ttl_ms: 6 * 60 * 60 * 1000,
    candidate_file_sha256: sha256(candidateBytes),
    candidate_set_sha256: validationCandidateSetSha256(candidates),
    candidate_count: 1,
    source_files: [{ path: sourceFile, sha256: sha256(sourceBytes) }],
    entry_count: 1,
    entries: {
      3832171441: {
        sku: "3832171441",
        top_category: { cate_id: 17027482, label: "建筑和装修" },
        second_category: { cate_id: 200001698, label: "家居照明配饰和配件" },
        tier: { value: "1,12.00", label: "售价 ≤ 1500₽ (12.00%)" },
      },
    },
  };
  await mutate({ manifest, rows, candidates, candidateFile, sourceFile, seedFile });
  await fs.writeFile(seedFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const env = {
    FLOW_B_VALIDATION_ONLY: "1",
    FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE: "1",
    FLOW_B_VALIDATION_CANDIDATE_FILE: candidateFile,
    [VALIDATION_COMMISSION_SEED_ENV]: seedFile,
  };
  return { candidates, env, manifest, candidateFile, sourceFile, seedFile };
}

test("validation commission seed binds candidates, provenance, TTL, and a minimal hierarchy", async (t) => {
  const { candidates, env, sourceFile } = await fixture(t);
  const seed = await loadValidationCommissionSeedFromEnv(env, {
    candidates,
    now: new Date("2026-08-16T09:00:00.000Z"),
  });
  assert.equal(seed.entry_count, 1);
  assert.equal(seed.source_files[0].path, sourceFile);
  assert.deepEqual(seed.categoryForSku("3832171441").expected_category_hierarchy, [
    17027482,
    200001698,
  ]);
  assert.deepEqual(seed.commissionTree, [{
    cate_id: 17027482,
    label: "建筑和装修",
    children: [{
      cate_id: 200001698,
      label: "家居照明配饰和配件",
      children: [{ value: "1,12.00", label: "售价 ≤ 1500₽ (12.00%)" }],
    }],
  }]);
});

test("validation commission seed is unavailable outside candidate snapshot validation", async (t) => {
  const { candidates, env } = await fixture(t);
  await assert.rejects(
    loadValidationCommissionSeedFromEnv({ ...env, FLOW_B_VALIDATION_ONLY: "0" }, { candidates }),
    /allowed only when FLOW_B_VALIDATION_ONLY=1/u,
  );
  await assert.rejects(
    loadValidationCommissionSeedFromEnv({ ...env, FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE: "0" }, { candidates }),
    /requires FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE=1/u,
  );
  await assert.rejects(
    loadValidationCommissionSeedFromEnv({ ...env, FLOW_B_VALIDATION_CANDIDATE_FILE: "" }, { candidates }),
    /requires FLOW_B_VALIDATION_CANDIDATE_FILE/u,
  );
});

test("validation commission seed fails closed on candidate raw or canonical digest mismatch", async (t) => {
  await t.test("raw digest", async (subtest) => {
    const { candidates, env } = await fixture(subtest, ({ manifest }) => {
      manifest.candidate_file_sha256 = "0".repeat(64);
    });
    await assert.rejects(
      loadValidationCommissionSeedFromEnv(env, { candidates, now: new Date("2026-08-16T09:00:00Z") }),
      /raw candidate file digest/u,
    );
  });
  await t.test("canonical digest", async (subtest) => {
    const { candidates, env } = await fixture(subtest, ({ manifest }) => {
      manifest.candidate_set_sha256 = "0".repeat(64);
    });
    await assert.rejects(
      loadValidationCommissionSeedFromEnv(env, { candidates, now: new Date("2026-08-16T09:00:00Z") }),
      /candidate set digest/u,
    );
  });
});

test("validation commission seed fails closed on stale or modified provenance", async (t) => {
  await t.test("expired", async (subtest) => {
    const { candidates, env } = await fixture(subtest, ({ manifest }) => {
      manifest.ttl_ms = 60_000;
    });
    await assert.rejects(
      loadValidationCommissionSeedFromEnv(env, { candidates, now: new Date("2026-08-16T09:01:00Z") }),
      /has expired/u,
    );
  });
  await t.test("source digest", async (subtest) => {
    const { candidates, env, sourceFile } = await fixture(subtest);
    await fs.appendFile(sourceFile, "modified\n");
    await assert.rejects(
      loadValidationCommissionSeedFromEnv(env, { candidates, now: new Date("2026-08-16T09:00:00Z") }),
      /source_files\[0\] digest mismatch/u,
    );
  });
});

test("validation commission seed requires exactly one entry for every candidate", async (t) => {
  const { candidates, env } = await fixture(t, ({ manifest }) => {
    manifest.entry_count = 0;
    manifest.entries = {};
  });
  await assert.rejects(
    loadValidationCommissionSeedFromEnv(env, { candidates, now: new Date("2026-08-16T09:00:00Z") }),
    /entry_count must equal the exact validation candidate count/u,
  );
});
