import { AdminSchema } from "../../schemas/admin.schema.js";
import { hasGlobalChannelOwnerAccess } from "../../middleware/admin.middleware.js";

const DEFAULT_SKU_MAP: Record<number, string> = {
  0: "free",
  5: "dimafx_bits_5",
  10: "dimafx_bits_10",
  25: "dimafx_bits_25",
  50: "dimafx_bits_50",
  100: "dimafx_bits_100",
};

export type DimafxPurchaseAction = "use_now" | "save";

export function getDimafxSkuMap(): Record<number, string> {
  const rawMap = process.env.DIMAFX_SKU_MAP;
  if (!rawMap) {
    return DEFAULT_SKU_MAP;
  }

  try {
    const parsed = JSON.parse(rawMap) as Record<string, unknown>;
    const normalized: Record<number, string> = {};
    for (const [price, sku] of Object.entries(parsed)) {
      const numericPrice = Number(price);
      if (
        Number.isFinite(numericPrice) &&
        numericPrice >= 0 &&
        typeof sku === "string" &&
        sku.trim()
      ) {
        normalized[numericPrice] = sku.trim();
      }
    }

    return Object.keys(normalized).length > 0 ? normalized : DEFAULT_SKU_MAP;
  } catch (error) {
    console.error("Invalid DIMAFX_SKU_MAP, using defaults:", {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    return DEFAULT_SKU_MAP;
  }
}

export function getDimafxSkuForBitsPrice(bitsPrice: number): string | null {
  return getDimafxSkuMap()[bitsPrice] || null;
}

export function getAllowedDimafxBitPrices(): number[] {
  return Object.keys(getDimafxSkuMap())
    .map(Number)
    .sort((a, b) => a - b);
}

export async function hasDimafxPermission(
  requesterID: string,
  channelID: string,
  requiredPermissions: string[],
): Promise<boolean> {
  if (requesterID === channelID) {
    return true;
  }

  if (await hasGlobalChannelOwnerAccess(requesterID, channelID)) {
    return true;
  }

  const permissionsToCheck = ["*", "dimafx:all", ...requiredPermissions];
  const admin = await AdminSchema.findOne({
    channelID,
    adminID: requesterID,
    actived: true,
    permissions: { $in: permissionsToCheck },
  }).lean();

  return Boolean(admin);
}

export function normalizeDimafxPurchaseAction(
  value: unknown,
): DimafxPurchaseAction {
  return value === "save" ? "save" : "use_now";
}
