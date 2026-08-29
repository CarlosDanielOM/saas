import { registerFunction, type FunctionHandler } from "../evaluator.js";
import type { FunctionMetadata } from "../types.js";
import * as ChatFunctions from "../../../functions/chats/index.js";
import { error as logError } from "../../../utils/logger.js";

const MIN_PIN_DURATION_SECONDS = 30;
const MAX_PIN_DURATION_SECONDS = 1800;

/**
 * Parses duration from arguments.
 * If first argument is a number in valid range [30, 1800], it's treated as duration.
 * Returns { duration, message } where duration may be undefined.
 */
function parsePinArguments(
  args: unknown[],
  fallback?: string,
): { duration: number | undefined; message: string } {
  const rawArgs =
    args.length > 0
      ? args
          .map((arg) => String(arg))
          .join(" ")
          .trim()
      : String(fallback || "").trim();

  if (!rawArgs) {
    return { duration: undefined, message: "" };
  }

  const tokens = rawArgs.split(/\s+/);
  const firstToken = tokens[0];
  const firstNumber = Number.parseInt(firstToken, 10);

  if (
    Number.isFinite(firstNumber) &&
    firstNumber >= MIN_PIN_DURATION_SECONDS &&
    firstNumber <= MAX_PIN_DURATION_SECONDS
  ) {
    // First token is a valid duration
    const message = tokens.slice(1).join(" ");
    return { duration: firstNumber, message };
  }

  // No valid duration prefix
  return { duration: undefined, message: rawArgs };
}

/**
 * Gets the current pinned message ID for a channel.
 * Returns undefined if no message is pinned.
 */
async function getCurrentPinnedMessageId(
  channelID: string,
): Promise<string | undefined> {
  const result = await ChatFunctions.getPinnedChatMessage(channelID);
  if (result.error || !result.data || result.data.length === 0) {
    return undefined;
  }
  return result.data[0].message_id;
}

// ============================================================================
// pin.create handler
// ============================================================================
const pinCreateHandler: FunctionHandler = async (args, ctx) => {
  const { duration, message } = parsePinArguments(args, ctx.argument);

  if (!message) {
    return "Usage: $(pin.create [duration] message) or $(pin [duration] message)";
  }

  // Send the message to chat
  const sendResult = await ChatFunctions.sendTwitchChatMessage(
    ctx.broadcasterId,
    message,
  );

  if (sendResult.error) {
    await logError(
      {
        function: "pin.create",
        channelID: ctx.broadcasterId,
        userID: ctx.userId,
        operation: "send_message",
        error: sendResult.message,
      },
      { channelId: ctx.broadcasterId, destination: "both" },
    );

    return `pin.create: Failed to send message - ${sendResult.message}`;
  }

  // Extract message_id from the send result
  const messageId = sendResult.data?.message_id;
  if (!messageId) {
    await logError(
      {
        function: "pin.create",
        channelID: ctx.broadcasterId,
        userID: ctx.userId,
        operation: "get_message_id",
        error: "No message_id in send result",
      },
      { channelId: ctx.broadcasterId, destination: "both" },
    );

    return "pin.create: Failed to get message ID from sent message";
  }

  // Pin the message
  const pinResult = await ChatFunctions.pinChatMessage(
    ctx.broadcasterId,
    messageId,
    duration,
  );

  if (pinResult.error) {
    await logError(
      {
        function: "pin.create",
        channelID: ctx.broadcasterId,
        userID: ctx.userId,
        messageID: messageId,
        duration,
        operation: "pin_message",
        error: pinResult.message,
      },
      { channelId: ctx.broadcasterId, destination: "both" },
    );

    return `pin.create: Failed to pin message - ${pinResult.message}`;
  }

  return "";
};

// ============================================================================
// pin.update handler
// ============================================================================
const pinUpdateHandler: FunctionHandler = async (args, ctx) => {
  const rawArgs =
    args.length > 0
      ? args
          .map((arg) => String(arg))
          .join(" ")
          .trim()
      : String(ctx.argument || "").trim();

  if (!rawArgs) {
    return "Usage: $(pin.update duration)";
  }

  const duration = Number.parseInt(rawArgs, 10);

  if (
    !Number.isFinite(duration) ||
    duration < MIN_PIN_DURATION_SECONDS ||
    duration > MAX_PIN_DURATION_SECONDS
  ) {
    return `pin.update: Duration must be between ${MIN_PIN_DURATION_SECONDS} and ${MAX_PIN_DURATION_SECONDS} seconds`;
  }

  // Get current pinned message
  const pinnedMessageId = await getCurrentPinnedMessageId(ctx.broadcasterId);

  if (!pinnedMessageId) {
    return "pin.update: No message is currently pinned";
  }

  // Update the pinned message duration
  const updateResult = await ChatFunctions.updatePinnedChatMessage(
    ctx.broadcasterId,
    pinnedMessageId,
    duration,
  );

  if (updateResult.error) {
    await logError(
      {
        function: "pin.update",
        channelID: ctx.broadcasterId,
        userID: ctx.userId,
        messageID: pinnedMessageId,
        duration,
        operation: "update_pinned_message",
        error: updateResult.message,
      },
      { channelId: ctx.broadcasterId, destination: "both" },
    );

    return `pin.update: Failed to update pinned message - ${updateResult.message}`;
  }

  return "";
};

// ============================================================================
// pin.delete handler
// ============================================================================
const pinDeleteHandler: FunctionHandler = async (_args, ctx) => {
  // Get current pinned message
  const pinnedMessageId = await getCurrentPinnedMessageId(ctx.broadcasterId);

  if (!pinnedMessageId) {
    return "pin.del: No message is currently pinned";
  }

  // Unpin the message
  const deleteResult = await ChatFunctions.unpinChatMessage(
    ctx.broadcasterId,
    pinnedMessageId,
  );

  if (deleteResult.error) {
    await logError(
      {
        function: "pin.delete",
        channelID: ctx.broadcasterId,
        userID: ctx.userId,
        messageID: pinnedMessageId,
        operation: "unpin_message",
        error: deleteResult.message,
      },
      { channelId: ctx.broadcasterId, destination: "both" },
    );

    return `pin.del: Failed to unpin message - ${deleteResult.message}`;
  }

  return "";
};

// ============================================================================
// pin handler (default - same as pin.create)
// ============================================================================
const pinHandler: FunctionHandler = async (args, ctx) => {
  // pin without subcommand acts exactly like pin.create
  return pinCreateHandler(args, ctx);
};

// ============================================================================
// Register all pin functions
// ============================================================================
export function registerPinFunctions(): void {
  const pinCreateMetadata: FunctionMetadata = {
    description: 'Sends a message to chat and pins it. Optional duration in seconds (30-1800) as first argument.',
    syntax: 'pin.create [duration] message',
    category: 'pin',
    examples: ['pin.create Giveaway ends at 9pm', 'pin.create 300 Rules: be kind'],
    minUserLevel: 7,
    keywords: ['pin message', 'pin chat', 'fijar mensaje', 'mensaje fijado']
  };
  registerFunction("pin", pinHandler, { ...pinCreateMetadata, aliasOf: "pin.create" });
  registerFunction("pin.create", pinCreateHandler, pinCreateMetadata);
  registerFunction("pin.update", pinUpdateHandler, {
    description: 'Updates the duration of the currently pinned message (30-1800 seconds).',
    syntax: 'pin.update duration',
    category: 'pin',
    examples: ['pin.update 600'],
    minUserLevel: 7,
    keywords: ['update pin', 'pin duration', 'cambiar duracion del pin']
  });
  const pinDeleteMetadata: FunctionMetadata = {
    description: 'Unpins the currently pinned chat message.',
    syntax: 'pin.del',
    category: 'pin',
    examples: ['pin.del'],
    minUserLevel: 7,
    destructive: true,
    keywords: ['unpin', 'remove pin', 'quitar pin', 'desfijar']
  };
  registerFunction("pin.del", pinDeleteHandler, pinDeleteMetadata);
  registerFunction("pin.delete", pinDeleteHandler, { ...pinDeleteMetadata, aliasOf: "pin.del" }); // Alias for pin.del
}
