import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function evidenceKey(row) {
  return [row.run_id, row.at, row.sku, row.status, row.source_url].map((value) => String(value || "")).join("\0");
}

export async function buildFbsSourceHistory({ runRoot, outputFile }) {
  const root = path.resolve(runRoot);
  const output = path.resolve(outputFile);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const rows = [];
  const seen = new Set();
  let files = 0;
  for (const entry of entries.filter((value) => value.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const filename = path.join(root, entry.name, "favorite_collection.jsonl");
    let text;
    try {
      text = await fs.readFile(filename, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    files += 1;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!["favorited", "rejected", "failed"].includes(String(row?.status || ""))) continue;
      if (!row?.source_url || !row?.sku) continue;
      const event = { ...row, run_id: String(row.run_id || entry.name) };
      const key = evidenceKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(event);
    }
  }
  rows.sort((left, right) => (Date.parse(left?.at || "") || 0) - (Date.parse(right?.at || "") || 0)
    || evidenceKey(left).localeCompare(evidenceKey(right)));
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  await fs.writeFile(temporary, rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
  await fs.rename(temporary, output);
  return { files, rows: rows.length, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const runRoot = path.resolve(process.argv[2] || path.join(projectRoot, "runs/flow_b"));
  const outputFile = path.resolve(process.argv[3] || path.join(projectRoot, "data/flow_b/fbs_source_history.jsonl"));
  const result = await buildFbsSourceHistory({ runRoot, outputFile });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
