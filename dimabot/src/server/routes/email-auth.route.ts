import express, { type Request, type Response } from "express";
import UsersSchema from "../../schemas/users.schema.js";
import { verifyEmailActivationToken } from "../../utils/email/email-activation-token.js";

const router = express.Router();

/**
 * Public endpoint used by activation email links.
 * Accepts a short-lived signed JWT (?token=...).
 * - Validates the token (1h expiry)
 * - Looks up the user
 * - If not found or invalid → redirect to login with error
 * - If already activated → redirect to login page (frontend will show "already activated" toast via sessionStorage)
 * - If not activated → redirect to the exact same Twitch authorize flow the dashboard "Activate Bot" button uses
 */
router.get("/auth", async (req: Request<{}, {}, {}, { token?: string }>, res: Response) => {
  const token = req.query.token;

  if (!token) {
    return res.redirect("https://domdimabot.com/login?error=invalid_activation_link");
  }

  const verified = verifyEmailActivationToken(token);
  if (!verified) {
    return res.redirect("https://domdimabot.com/login?error=invalid_activation_link");
  }

  const { userId, login } = verified;

  try {
    const user = await UsersSchema.findById(userId).lean();
    if (!user) {
      return res.redirect("https://domdimabot.com/login?error=invalid_activation_link");
    }

    const twitchAccount = (user as any).accounts?.find((acc: any) => acc.type === "twitch");
    if (!twitchAccount) {
      return res.redirect("https://domdimabot.com/login?error=invalid_activation_link");
    }

    const isActive = !!twitchAccount.actived;

    if (isActive) {
      // Already active: send to login page.
      // The Angular login page will persist the action to sessionStorage so that once
      // the user has a valid session (or after they log in), the authenticated layout
      // can show a toast: "Account is already activated."
      return res.redirect("https://domdimabot.com/login?emailAction=alreadyActivated");
    }

    // Inactive → drive the user through the same flow as the navbar "Activate Bot" button.
    // This reuses /auth/authorize?action=activate which points Twitch back to /auth/register.
    const stateName = twitchAccount.name || login || "";
    const params = new URLSearchParams({
      state: stateName,
      action: "activate"
    });

    const host = req.get("host") || "api.domdimabot.com";
    const protocol = host.includes("localhost") ? "http" : "https";
    const apiBase = `${protocol}://${host}`;

    return res.redirect(`${apiBase}/auth/authorize?${params.toString()}`);
  } catch (err) {
    console.error("[EMAIL-AUTH] Error processing activation token:", {
      error: err instanceof Error ? err.message : String(err),
      userId,
      timestamp: new Date().toISOString()
    });
    return res.redirect("https://domdimabot.com/login?error=invalid_activation_link");
  }
});

export const emailAuthRoute = router;
