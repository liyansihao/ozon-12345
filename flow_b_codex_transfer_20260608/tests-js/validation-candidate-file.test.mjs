import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadValidationCandidateFile,
  loadValidationCandidatesFromEnv,
  withValidationCandidateFavorites,
} from "../scripts/flow_b_playwright/validation-candidate-file.mjs";

const firstCandidate = Object.freeze({
  sku: 3192898349,
  title: " Black four-head GU10 spotlight ",
  sell_price: 234.4,
  cover_image: "https://ir.ozone.ru/source.jpg",
});

async function withTempDir(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "flow-b-validation-candidates-"));
  try {
    return await operation(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("validation candidate JSON input is normalized to the four inert source fields", async () => {
  await withTempDir(async (directory) => {
    const filename = path.join(directory, "candidates.json");
    await fs.writeFile(filename, JSON.stringify([
      firstCandidate,
      {
        sku: "01623709047",
        title: "Square black GX53 spotlight",
        sell_price: 56.96,
        cover_image: "https://ir.ozone.ru/second.jpg?size=300",
      },
    ]));

    const candidates = await loadValidationCandidateFile(filename, { validationOnly: true });
    assert.deepEqual(candidates, [
      {
        sku: "3192898349",
        title: "Black four-head GU10 spotlight",
        sell_price: 234.4,
        cover_image: "https://ir.ozone.ru/source.jpg",
      },
      {
        sku: "01623709047",
        title: "Square black GX53 spotlight",
        sell_price: 56.96,
        cover_image: "https://ir.ozone.ru/second.jpg?size=300",
      },
    ]);
    assert.equal(Object.isFrozen(candidates), true);
    assert.equal(Object.isFrozen(candidates[0]), true);

    const fromEnv = await loadValidationCandidatesFromEnv({
      FLOW_B_VALIDATION_CANDIDATE_FILE: filename,
      FLOW_B_VALIDATION_ONLY: "1",
      FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE: "1",
    });
    assert.deepEqual(fromEnv, candidates);
  });
});

test("validation candidate JSONL accepts non-empty lines and reports physical line numbers", async () => {
  await withTempDir(async (directory) => {
    const filename = path.join(directory, "candidates.jsonl");
    await fs.writeFile(filename, `${JSON.stringify(firstCandidate)}\n\n{broken}\n`);
    await assert.rejects(
      loadValidationCandidateFile(filename, { validationOnly: true }),
      /line 3 is not valid JSON/u,
    );

    await fs.writeFile(filename, `${JSON.stringify(firstCandidate)}\n\n${JSON.stringify({
      sku: "1623709047",
      title: "Square black GX53 spotlight",
      sell_price: 56.96,
      cover_image: "https://ir.ozone.ru/second.jpg",
    })}\n`);
    const candidates = await loadValidationCandidateFile(filename, { validationOnly: true });
    assert.equal(candidates.length, 2);
    assert.equal(candidates[1].sku, "1623709047");
  });
});

test("candidate-file environment fails closed outside an explicitly validation-only session", async () => {
  assert.equal(await loadValidationCandidatesFromEnv({}), null);
  await assert.rejects(
    loadValidationCandidatesFromEnv({
      FLOW_B_VALIDATION_CANDIDATE_FILE: "/does/not/need/to/exist.json",
      FLOW_B_VALIDATION_ONLY: "0",
    }),
    /allowed only when FLOW_B_VALIDATION_ONLY=1/u,
  );
  await assert.rejects(
    loadValidationCandidateFile("/does/not/need/to/exist.json"),
    /allowed only when FLOW_B_VALIDATION_ONLY=1/u,
  );
  assert.throws(
    () => withValidationCandidateFavorites({ listFavorites: async () => [] }, [firstCandidate]),
    /allowed only when FLOW_B_VALIDATION_ONLY=1/u,
  );
  await assert.rejects(
    loadValidationCandidatesFromEnv({
      FLOW_B_VALIDATION_ONLY: "1",
      FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE: "1",
    }),
    /FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE=1 requires a loaded FLOW_B_VALIDATION_CANDIDATE_FILE/u,
  );
  await assert.rejects(
    loadValidationCandidatesFromEnv({
      FLOW_B_VALIDATION_CANDIDATE_FILE: "/does/not/need/to/exist.json",
      FLOW_B_VALIDATION_ONLY: "0",
      FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE: "1",
    }),
    /FLOW_B_VALIDATION_USE_SNAPSHOT_PRICE=1 is allowed only when FLOW_B_VALIDATION_ONLY=1/u,
  );
});

test("candidate file rejects active-control fields, malformed values, duplicates, and unsupported formats", async () => {
  await withTempDir(async (directory) => {
    const cases = [
      ["missing.json", [{ ...firstCandidate, title: undefined }], /missing required field\(s\): title/u],
      ["control.json", [{ ...firstCandidate, submitted: true }], /unsupported field\(s\): submitted/u],
      ["sku.json", [{ ...firstCandidate, sku: "sku-1" }], /sku must be/u],
      ["title.json", [{ ...firstCandidate, title: " " }], /title must be/u],
      ["price.json", [{ ...firstCandidate, sell_price: "234.4" }], /sell_price must be/u],
      ["image.json", [{ ...firstCandidate, cover_image: "http:\/\/ir.ozone.ru\/source.jpg" }], /HTTPS URL/u],
      ["credentials.json", [{ ...firstCandidate, cover_image: "https:\/\/user:pass@ir.ozone.ru\/source.jpg" }], /credential-free HTTPS URL/u],
      ["duplicates.json", [firstCandidate, { ...firstCandidate, sku: "3192898349" }], /duplicates sku 3192898349/u],
      ["root.json", { ...firstCandidate }, /must contain a JSON array/u],
      ["empty.json", [], /contains no candidates/u],
    ];
    for (const [basename, value, expected] of cases) {
      const filename = path.join(directory, basename);
      await fs.writeFile(filename, JSON.stringify(value));
      await assert.rejects(loadValidationCandidateFile(filename, { validationOnly: true }), expected);
    }

    const unsupported = path.join(directory, "candidates.txt");
    await fs.writeFile(unsupported, JSON.stringify([firstCandidate]));
    await assert.rejects(
      loadValidationCandidateFile(unsupported, { validationOnly: true }),
      /must point to a \.json or \.jsonl file/u,
    );
  });
});

test("validation client replaces only listFavorites, never calls the live source, and returns fresh rows", async () => {
  let liveCalls = 0;
  const client = {
    listFavorites: async () => {
      liveCalls += 1;
      return [{ sku: "live" }];
    },
    publish: async () => "unchanged",
  };
  const candidates = [{
    sku: "3192898349",
    title: "Black four-head GU10 spotlight",
    sell_price: 234.4,
    cover_image: "https://ir.ozone.ru/source.jpg",
  }];
  const validationClient = withValidationCandidateFavorites(client, candidates, { validationOnly: true });

  const first = await validationClient.listFavorites();
  first[0].title = "mutated by consumer";
  const second = await validationClient.listFavorites();
  assert.equal(liveCalls, 0);
  assert.equal(second[0].title, "Black four-head GU10 spotlight");
  assert.equal(await validationClient.publish(), "unchanged");
  assert.notEqual(validationClient, client);
});
