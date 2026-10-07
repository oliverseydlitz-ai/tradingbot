export type Category = "Stock" | "ETF" | "Bond ETF";

/** Alpaca assets carry no ETF/bond flag, so classify by the asset name. */
export function categorize(name: string | undefined | null): Category {
  const n = name ?? "";
  const fund = /\b(etf|etn|fund|trust|shares)\b/i.test(n);
  const bond = /\b(bond|bonds|treasury|treasuries|aggregate|fixed income|tips|municipal|muni|credit)\b/i.test(n);
  if (fund && bond) return "Bond ETF";
  if (fund) return "ETF";
  return "Stock";
}
