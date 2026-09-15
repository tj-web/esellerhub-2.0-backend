import { AppError } from "../utilis/appError.js";
import { attachResponseMeta } from "./authMiddleware.js";

/**
 * Access rules based on vendor_mode
 * Mode 0: Agreement/Setup pending. Only auth, setup, help and company info allowed.
 * Mode 1: Onboarding incomplete. Restricted access to orders and agreement.
 * Mode 2: Fully active. Full access to all modules.
 */
const ACCESS_RULES = {
  0: {
    allowedPaths: [
      "/auth",
      "/help-support",
      "/partner-setup",
    ],
    message: "Please complete your partner setup to access this feature."
  },
  1: {
    blockedPaths: [
      "/orders",
      "/eseller-agreement",
    ],
    message: "This feature is restricted for your account mode."
  },
  2: {
    allowedPaths: ["*"], // Full access
  }
};

export const vendorModeMiddleware = (req, res, next) => {
  // Extract vendor_mode from the authenticated user (attached by auth middleware)
  const vendorMode = req.user?.vendor_mode ?? 0;
  
  // Get the base path of the request
  const path = req.baseUrl; 

  // Strip API version prefix if configured (e.g., /api/v1)
  const apiPrefix = process.env.API_VERSION_PATH || "";
  const relativePath = path.startsWith(apiPrefix) ? path.slice(apiPrefix.length) : path;

  const rules = ACCESS_RULES[vendorMode] || ACCESS_RULES[0];

  // If the mode has allowedPaths defined, check if current path is in it
  if (rules.allowedPaths) {
    if (rules.allowedPaths.includes("*")) return next();
    
    const isAllowed = rules.allowedPaths.some(p => relativePath.startsWith(p));
    if (isAllowed) return next();
    
    attachResponseMeta(res, {
      refreshed: false,
      vendorModeChanged: true,
      vendorMode,
    });
    return next(new AppError(rules.message || "Access denied for current vendor mode.", 403));
  }

  // If the mode has blockedPaths defined, check if current path is in it
  if (rules.blockedPaths) {
    const isBlocked = rules.blockedPaths.some(p => relativePath.startsWith(p));
    if (isBlocked) {
      attachResponseMeta(res, {
        refreshed: false,
        vendorModeChanged: true,
        vendorMode,
      });
      return next(new AppError(rules.message || "Access denied for current vendor mode.", 403));
    }
  }

  next();
};
