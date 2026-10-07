import { describe, expect, it } from "vitest";
import { categorize } from "../supabase/functions/mcp/categorize.ts";

describe("categorize", () => {
  it.each([
    ["SPDR S&P 500 ETF Trust", "ETF"],
    ["Invesco QQQ Trust, Series 1", "ETF"],
    ["iShares 20+ Year Treasury Bond ETF", "Bond ETF"],
    ["iShares Core U.S. Aggregate Bond ETF", "Bond ETF"],
    ["Vanguard Total Bond Market ETF", "Bond ETF"],
    ["iShares iBoxx $ High Yield Corporate Bond ETF", "Bond ETF"],
    ["Apple Inc. Common Stock", "Stock"],
    ["Space Exploration Technologies Corp. Class A Common Stock", "Stock"],
    [undefined, "Stock"],
  ])("%s -> %s", (name, cat) => expect(categorize(name as string | undefined)).toBe(cat));
});
