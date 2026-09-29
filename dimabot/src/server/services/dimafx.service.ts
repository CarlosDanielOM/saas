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
export type DimafxQuickPurchasePriority = "credits_first" | "bits_first";

export interface DimafxViewerConfig {
  quickPurchasePriority: DimafxQuickPurchasePriority;
  quickPurchaseAction: DimafxPurchaseAction;
}

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

export function normalizeDimafxViewerConfig(
  incoming: {
    quickPurchasePriority?: unknown;
    quickPurchaseAction?: unknown;
  },
  current: DimafxViewerConfig,
): DimafxViewerConfig {
  return {
    quickPurchasePriority:
      incoming.quickPurchasePriority === "bits_first"
        ? "bits_first"
        : incoming.quickPurchasePriority === "credits_first"
          ? "credits_first"
          : current.quickPurchasePriority,
    quickPurchaseAction:
      incoming.quickPurchaseAction === "save"
        ? "save"
        : incoming.quickPurchaseAction === "use_now"
          ? "use_now"
          : current.quickPurchaseAction,
  };
}

export function selectRedeemCandidate<
  T extends {
    channelExtensionItemID: unknown;
    quantity: number;
    acquiredAt: Date | string;
  },
>(items: T[], itemID: string): T | null {
  const candidates = items
    .filter(
      (item) =>
        String(item.channelExtensionItemID) === itemID &&
        Number(item.quantity || 0) > 0,
    )
    .sort(
      (a, b) =>
        new Date(b.acquiredAt).getTime() - new Date(a.acquiredAt).getTime(),
    );

  return candidates[0] || null;
}

export const DIMAFX_TTS_FIXED_TEXT_MAX = 500;
export const DIMAFX_TTS_VIEWER_TEXT_MAX = 280;

// Piper voice IDs look like "en_US-ryan-medium". The pattern doubles as a
// safety guard: the voice is passed to the Piper CLI/HTTP API, so reject
// anything that could be parsed as a flag or path.
const PIPER_VOICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;

export function isValidDimafxTtsVoice(value: unknown): value is string {
  return typeof value === "string" && PIPER_VOICE_PATTERN.test(value.trim());
}

/**
 * Normalizes the broadcaster-authored TTS config for a DimaFX item.
 * Returns null when the incoming value is not an object (callers decide
 * whether TTS config is required). Throws Error with a user-safe message
 * when fields are invalid.
 */
export function normalizeDimafxTtsConfig(
  value: unknown,
): import("../../schemas/channel_extension_item.schema.js").ChannelExtensionItemTtsConfig | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object") {
    throw new Error("Invalid TTS configuration");
  }

  const input = value as Record<string, unknown>;
  const mode = input.mode === "fixed" ? "fixed" : "custom";
  const language = input.language === "es" ? "es" : "en";

  const text = typeof input.text === "string" ? input.text.trim().replace(/\s+/g, " ") : "";
  if (mode === "fixed" && !text) {
    throw new Error("Fixed TTS items require text");
  }
  if (text.length > DIMAFX_TTS_FIXED_TEXT_MAX) {
    throw new Error(`TTS text must be ${DIMAFX_TTS_FIXED_TEXT_MAX} characters or fewer`);
  }

  const voice = typeof input.voice === "string" ? input.voice.trim() : "";
  if (voice && !isValidDimafxTtsVoice(voice)) {
    throw new Error("Invalid TTS voice");
  }

  return { mode, text, voice, language };
}

/**
 * Sanitizes viewer-supplied TTS text at purchase time: trims, collapses
 * whitespace, strips links, and enforces the length cap. Returns the cleaned
 * text (possibly empty — callers decide whether empty is acceptable).
 */
export function sanitizeDimafxViewerTtsText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DIMAFX_TTS_VIEWER_TEXT_MAX);
}
