import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadValidationSignedEvidenceReplayFromEnv,
  validationCandidateSetSha256,
  VALIDATION_SIGNED_EVIDENCE_REPLAY_CONTRACT,
} from "../scripts/flow_b_playwright/validation-signed-evidence-replay.mjs";

const candidate = Object.freeze({
  sku: "123",
  title: "Same product lamp L1",
  sell_price: 101,
  cover_image: "https://img.example/ozon-123.jpg",
});
const candidateFileText = JSON.stringify([candidate]);

function fixtureManifest() {
  const request = {
    expect_category: "tools lamps",
    expect_model: "l1",
    expect_price_cny: 100,
    expect_title: "same product lamp l1",
  };
  const evidence = JSON.stringify({
    contract: "1688-returned-same-item-v3",
    cost_source: "search_first_page_cluster_p70_similarity_filtered",
    request,
    rows: [{
      offer_id: "111",
      supplier_id: "supplier-1",
      supplier: "supplier 1",
      image_url: "https://img.example/offer-111.jpg",
      image: { available: true, score: 0.95, color_score: 0.96, dhash_score: 0.94 },
      rank: 1,
      price: 18,
      semantic_hits: { category: [], model: ["l1"], title: ["lamp"] },
      semantic_hits_v3: { model: ["l1"], high_information: ["lamp"], feature: [] },
      semantic_strength: "exact_model",
      specs: {},
      spec_conflicts: [],
      accessory_conflict: false,
      title: "same product lamp l1",
    }],
    selected_cluster: [{ offer_id: "111", supplier_id: "supplier-1", price: 18 }],
    selected_cost: 18,
    selected_offer_id: "111",
    balanced_match: {
      passed: true,
      match_type: "strong_single",
      reason: "test strict match",
      image_available: true,
      supporting_offer_ids: ["111"],
      expected_specs: {},
    },
  });
  const matchEvidenceKey = crypto.createHash("sha256").update(evidence).digest("hex");
  const output = [
    `SAME_ITEM_EVIDENCE ${evidence}`,
    `MATCH_EVIDENCE_KEY ${matchEvidenceKey}`,
    "SELECTED_OFFER_ID 111",
    "COST_SOURCE search_first_page_cluster_p70_similarity_filtered",
    "FILTERED_FIRST_PAGE_PRICES [18]",
    "P70_COST 18",
  ].join("\n");
  const cachePayload = {
    version: 7,
    image_url: candidate.cover_image,
    minimum_same_item_matches: 1,
    excluded_offer_ids: [],
    expect_title: candidate.title,
    expect_model: "l1",
    expect_category: "tools lamps",
    expect_price_cny: 100,
  };
  const sourceCacheKey = crypto.createHash("sha256")
    .update(JSON.stringify(cachePayload))
    .digest("hex");
  return {
    contract: VALIDATION_SIGNED_EVIDENCE_REPLAY_CONTRACT,
    candidate_file_sha256: crypto.createHash("sha256").update(candidateFileText).digest("hex"),
    candidate_set_sha256: validationCandidateSetSha256([candidate]),
    candidate_count: 1,
    minimum_same_item_matches: 1,
    entry_count: 1,
    entries: {
      123: {
        ...candidate,
        expect_model: "l1",
        expect_category: "tools lamps",
        source_validation_at: "2026-08-15T00:00:00.000Z",
        source_cache_key: sourceCacheKey,
        source_cache_key_payload: cachePayload,
        match_evidence_key: matchEvidenceKey,
        selected_offer_id: "111",
        source_output_sha256: crypto.createHash("sha256").update(output).digest("hex"),
        compact_output_sha256: crypto.createHash("sha256").update(output).digest("hex"),
        source_output: output,
        output,
      },
    },
    rejected: [],
  };
}

async function withManifest(manifest, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-signed-replay-"));
  try {
    const filename = path.join(directory, "replay.json");
    const candidateFilename = path.join(directory, "candidates.json");
    await fs.writeFile(filename, JSON.stringify(manifest));
    await fs.writeFile(candidateFilename, candidateFileText);
    return await callback(filename, candidateFilename);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function replayEnv(filename, candidateFilename) {
  return {
    FLOW_B_VALIDATION_ONLY: "1",
    FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE: "1",
    FLOW_B_VALIDATION_CANDIDATE_FILE: candidateFilename,
    FLOW_B_VALIDATION_SIGNED_EVIDENCE_REPLAY_FILE: filename,
  };
}

test("signed replay keeps product identity exact while rechecking cost against the current snapshot price", async () => {
  await withManifest(fixtureManifest(), async (filename, candidateFilename) => {
    const replay = await loadValidationSignedEvidenceReplayFromEnv(replayEnv(filename, candidateFilename), {
      candidates: [candidate],
      minimumSameItemMatches: 1,
    });
    const accepted = await replay.estimate({
      ...candidate,
      expect_title: candidate.title,
      expect_model: "L1",
      expect_category: "Tools Lamps",
    });
    const changedCategory = await replay.estimate({
      ...candidate,
      expect_title: candidate.title,
      expect_model: "L1",
      expect_category: "different category",
    });

    assert.deepEqual(replay.requestFor(candidate), {
      expect_title: "same product lamp l1",
      expect_model: "l1",
      expect_category: "tools lamps",
      expect_price_cny: 100,
    });
    assert.equal(replay.requestFor({ ...candidate, title: "different" }), null);
    assert.equal(accepted.used, true);
    assert.equal(accepted.result.ok, true);
    assert.equal(accepted.result.validation_signed_evidence_replay, true);
    assert.equal(accepted.result.selected_offer_id_origin, "signed-selected-offer-id-v1");
    assert.deepEqual(accepted.result.validation_signed_evidence_price_binding, {
      signed_request_price: 100,
      current_snapshot_price: 101,
      current_cost_bounds_rechecked: true,
    });
    assert.equal(changedCategory.used, false);
    assert.match(changedCategory.reason, /title, model, or category differs/u);
  });
});

test("signed replay is unavailable outside snapshot-price validation-only scope", async () => {
  await withManifest(fixtureManifest(), async (filename, candidateFilename) => {
    await assert.rejects(
      loadValidationSignedEvidenceReplayFromEnv({
        ...replayEnv(filename, candidateFilename),
        FLOW_B_VALIDATION_ONLY: "0",
      }, { candidates: [candidate], minimumSameItemMatches: 1 }),
      /allowed only when FLOW_B_VALIDATION_ONLY=1/u,
    );
    await assert.rejects(
      loadValidationSignedEvidenceReplayFromEnv({
        ...replayEnv(filename, candidateFilename),
        FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE: "0",
      }, { candidates: [candidate], minimumSameItemMatches: 1 }),
      /requires FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE=1/u,
    );
  });
});

test("signed replay rejects candidate-set and signed-output tampering at startup", async () => {
  const wrongSet = fixtureManifest();
  wrongSet.candidate_set_sha256 = "0".repeat(64);
  await withManifest(wrongSet, async (filename, candidateFilename) => {
    await assert.rejects(
      loadValidationSignedEvidenceReplayFromEnv(replayEnv(filename, candidateFilename), {
        candidates: [candidate],
        minimumSameItemMatches: 1,
      }),
      /candidate set digest does not match/u,
    );
  });

  await withManifest(fixtureManifest(), async (filename, candidateFilename) => {
    await fs.writeFile(candidateFilename, `${candidateFileText}\n`);
    await assert.rejects(
      loadValidationSignedEvidenceReplayFromEnv(replayEnv(filename, candidateFilename), {
        candidates: [candidate],
        minimumSameItemMatches: 1,
      }),
      /raw candidate file digest does not match/u,
    );
  });

  const tampered = fixtureManifest();
  tampered.entries[123].output = tampered.entries[123].output.replace("P70_COST 18", "P70_COST 17");
  await withManifest(tampered, async (filename, candidateFilename) => {
    await assert.rejects(
      loadValidationSignedEvidenceReplayFromEnv(replayEnv(filename, candidateFilename), {
        candidates: [candidate],
        minimumSameItemMatches: 1,
      }),
      /compact signed output digest mismatch/u,
    );
  });

  const originalTampered = fixtureManifest();
  originalTampered.entries[123].source_output += "\nUNSIGNED_DIAGNOSTIC changed";
  await withManifest(originalTampered, async (filename, candidateFilename) => {
    await assert.rejects(
      loadValidationSignedEvidenceReplayFromEnv(replayEnv(filename, candidateFilename), {
        candidates: [candidate],
        minimumSameItemMatches: 1,
      }),
      /original signed output digest mismatch/u,
    );
  });

  const wrongCandidateCount = fixtureManifest();
  wrongCandidateCount.candidate_count = 2;
  await withManifest(wrongCandidateCount, async (filename, candidateFilename) => {
    await assert.rejects(
      loadValidationSignedEvidenceReplayFromEnv(replayEnv(filename, candidateFilename), {
        candidates: [candidate],
        minimumSameItemMatches: 1,
      }),
      /candidate_count metadata does not match/u,
    );
  });

  const wrongEntryCount = fixtureManifest();
  wrongEntryCount.entry_count = 2;
  await withManifest(wrongEntryCount, async (filename, candidateFilename) => {
    await assert.rejects(
      loadValidationSignedEvidenceReplayFromEnv(replayEnv(filename, candidateFilename), {
        candidates: [candidate],
        minimumSameItemMatches: 1,
      }),
      /entry_count metadata does not match/u,
    );
  });

  const wrongSelectedOffer = fixtureManifest();
  wrongSelectedOffer.entries[123].selected_offer_id = "999";
  await withManifest(wrongSelectedOffer, async (filename, candidateFilename) => {
    await assert.rejects(
      loadValidationSignedEvidenceReplayFromEnv(replayEnv(filename, candidateFilename), {
        candidates: [candidate],
        minimumSameItemMatches: 1,
      }),
      /selected offer ID differs from the signed output/u,
    );
  });
});
