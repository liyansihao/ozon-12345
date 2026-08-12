function importErrorMessages(log) {
  const messages = [];
  for (const value of [log?.error_msg, ...(Array.isArray(log?.skus) ? log.skus.map((row) => row?.error_msg) : [])]) {
    const message = typeof value === "string" ? value : value?.message || value?.msg || value?.error;
    if (String(message || "").trim()) messages.push(String(message).trim());
  }
  return messages;
}

export function importFailureReason(log) {
  const evidence = importErrorMessages(log).join(" | ");
  if (/суточн(?:ый|ого)\s+лимит|исчерпал\S*\s+суточн|daily\s+(?:product\s+)?limit/i.test(evidence)) {
    return "daily-product-limit";
  }
  if (/(?:^|\D)(?:408|425|429|5\d\d)(?:\D|$)|API\s*请求失败|request\s+failed|network|timeout|temporar|gateway|connection|ECONN(?:RESET|REFUSED)/i.test(evidence)) {
    return "import-transient-error";
  }
  return "import-failed";
}

export function hasTerminalModerationDecline(product) {
  return Array.isArray(product?.errors) && product.errors.some((error) => {
    const level = String(error?.level || "").toUpperCase();
    const state = String(error?.state || "").toLowerCase();
    const code = String(error?.code || "").toUpperCase();
    return level === "ERROR_LEVEL_ERROR" || state === "declined" || code.endsWith("_DECLINE");
  });
}

export function hasTerminalStockActivationRejection(stockUpdate) {
  return (stockUpdate?.result || []).some((row) => (row?.errors || []).some((error) => (
    String(error?.code || "").toUpperCase() === "CB_DELIVERY_ONLY_FBP"
  )));
}

export function isTerminalSubmittedFailure(entry) {
  const data = entry?.data || entry || {};
  if (data.terminal === true) return true;
  const reason = String(data.reason || "");
  if (reason === "import-failed" && importFailureReason(data.import_log) === "import-transient-error") return false;
  if (["daily-product-limit", "import-failed", "reconciliation-store-not-configured", "stock-activation-terminal-rejected", "fbs-evidence-missing"].includes(reason)) return true;
  if (reason === "stock-activation-rejected"
    && hasTerminalStockActivationRejection(data?.final_result?.stock_update || data?.stock_update)) return true;
  const moderationProduct = data?.final_result?.online_product || data?.online_product;
  const targetStoreId = Number(data?.store_id);
  const evidenceStoreId = Number(moderationProduct?.shop_id);
  const evidenceBelongsToAnotherStore = targetStoreId > 0
    && evidenceStoreId > 0
    && targetStoreId !== evidenceStoreId;
  if (reason === "online-product-rejected") return !evidenceBelongsToAnotherStore;
  return !evidenceBelongsToAnotherStore && hasTerminalModerationDecline(moderationProduct);
}
