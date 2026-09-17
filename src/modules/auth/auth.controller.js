import { v4 as uuidv4 } from "uuid";
import VendorAuth from "../../models/vendorAuth.model.js";
import Vendor from "../../models/vendor.model.js";
import { verifyEmailService } from "../common/service/emailService.js";
import { verifyOtpService, sendOtpService } from "../common/service/otpService.js";
import { AppError } from "../../utilis/appError.js";
import { findUserByEmail } from "../common/service/userService.js";
import StatusCodes from "../../utilis/statusCodes.js";
import SystemResponse from "../../utilis/systemResponse.js";
import {
  generateAuthTokens,
  createLoginHistory,
  verifyPassword,
  registerVendor,
  handleResetPassword,
  handleForgotPassword,
  handleChangePassword,
  logoutService,
  autoLoginService,
} from "./auth.service.js";
import LoginHistory from "../../models/loginHistory.model.js";
import engagementEvent from "../../helpers/engagementEvent.js";

VendorAuth.belongsTo(Vendor, { foreignKey: "vendor_id" });

/* ======================================================
   LOGIN FUNCTION
 ====================================================== */
export const login = async (req, res, next) => {
  const { frmtype, username, userpassword, rememberme } = req.body;

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  const deviceId = req.headers["x-device-id"] || null;

  try {
    const user = await findUserByEmail(username);

    if (!user) {
      throw new AppError("Invalid credentials", 400);
    }

    const isValid = await verifyPassword(userpassword, user.password);

    if (!isValid) {
      throw new AppError("Invalid credentials", 400);
    }

    if (user.Vendor?.status === 0) {
      throw new AppError("Account disabled", 403);
    }

    const { accessToken, refreshToken } = generateAuthTokens(user);

    await createLoginHistory(user, ip, deviceId, refreshToken);

    /* Trigger MoEngage OEM Login Event */
    await engagementEvent.oemLoginEvent(user, "Web");
    const isProd = process.env.NODE_ENV === "production";
    res.cookie("access_token", accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 15 * 60 * 1000,
    });

    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 10 * 24 * 60 * 60 * 1000,
    });

    return res.status(StatusCodes.SUCCESS).json(
      SystemResponse.success("Login successful", {
        id: user.vendor_id,
        email: user.email,
        name: `${user.Vendor?.first_name} ${user.Vendor?.last_name}`,
        vendor_mode: user.Vendor?.vendor_mode ?? 0,
      })
    );
  } catch (error) {
    console.error("Login Error:", error);
    if (error.statusCode === 400 || error.statusCode === 403) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError(error.message));
    }
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError(error.message || "Internal Server Error"));
  }
};

/* ======================================================
   AUTO LOGIN FUNCTION (magic link)
 ====================================================== */
export const autoLogin = async (req, res, next) => {
  const { token } = req.params;

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  const deviceId = req.headers["x-device-id"] || null;

  try {
    const result = await autoLoginService(token, ip, deviceId);

    const isProd = process.env.NODE_ENV === "production";
    res.cookie("access_token", result.accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 15 * 60 * 1000,
    });

    res.cookie("refresh_token", result.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 10 * 24 * 60 * 60 * 1000,
    });

    return res.status(StatusCodes.SUCCESS).json(
      SystemResponse.success("Login successful", {
        id: result.user.vendor_id,
        email: result.user.email,
        name: `${result.user.Vendor?.first_name} ${result.user.Vendor?.last_name}`,
        vendor_mode: result.user.Vendor?.vendor_mode ?? 0,
        redirect_uri: result.redirect_uri,
      })
    );
  } catch (error) {
    console.error("AutoLogin Error:", error);
    if (error.statusCode === 403) {
      return res
        .status(StatusCodes.FORBIDDEN)
        .json(SystemResponse.forbiddenError(error.message));
    }
    if (error.statusCode && error.statusCode < 500) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError(error.message));
    }
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError(error.message || "Internal Server Error"));
  }
};

/* ======================================================
   SIGNUP FUNCTION
 ====================================================== */
export const signup = async (req, res, next) => {
  try {
    const result = await registerVendor(req.body);
    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success("Signup successful", result));
  } catch (error) {
    if (error.statusCode === 400) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError(error.message));
    }
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError(error.message || "Internal Server Error"));
  }
};

/* ======================================================
   FORGOT PASSWORD FUNCTION
 ====================================================== */
export const forgotPassword = async (req, res, next) => {
  const { email } = req.body;

  try {
    await handleForgotPassword(email);

    return res.status(StatusCodes.SUCCESS).json(SystemResponse.success("Please check your Email."));
  } catch (error) {
    if (error.statusCode && error.statusCode !== 500) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError(error.message));
    }
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError(error.message || "Internal Server Error"));
  }
};

export const resetPassword = async (req, res, next) => {
  const { new_password, confirm_password } = req.body;
  const rawToken = req.query.token;

  const token = rawToken ? decodeURIComponent(rawToken).replace(/^"|"$/g, "").trim() : null;

  try {
    await handleResetPassword(token, new_password);

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success("Password reset successful"));
  } catch (error) {
    if (error.statusCode && error.statusCode !== 500) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError(error.message));
    }
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError(error.message || "Internal Server Error"));
  }
};

/* ======================================================
   LOGOUT FUNCTION
 ====================================================== */
export const logOut = async (req, res, next) => {
  try {
    const refreshToken = req.cookies.refresh_token;

    if (refreshToken) {
      await logoutService(refreshToken);
    }

    const isProd = process.env.NODE_ENV === "production";
    res.clearCookie("access_token", {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
    });
    res.clearCookie("refresh_token", {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
    });

    return res.status(StatusCodes.SUCCESS).json(SystemResponse.success("Logged out successfully"));
  } catch (error) {
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError(error.message || "Internal Server Error"));
  }
};

/* ======================================================
    CHANGE PASSWORD FUNCTION
 ====================================================== */
export const changePassword = async (req, res, next) => {
  const { old_password, new_password } = req.body;

  try {
    const vendorId = req.user.vendor_id;

    await handleChangePassword(vendorId, old_password, new_password);

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success("Password changed successfully"));
  } catch (error) {
    if (error.statusCode && error.statusCode !== 500) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError(error.message));
    }
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError(error.message || "Internal Server Error"));
  }
};

export const verifyEmail = async (req, res, next) => {
  try {
    const token = req.query.token;

    await verifyEmailService(token);

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success("Email verified successfully"));
  } catch (error) {
    if (error.statusCode && error.statusCode !== 500) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError(error.message));
    }
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError(error.message || "Internal Server Error"));
  }
};

/* ======================================================
    OTP FUNCTION
 ====================================================== */

export const sendOtp = async (req, res, next) => {
  const { phone_number, dial_code } = req.body;

  try {
    await sendOtpService(phone_number, dial_code);

    return res.status(StatusCodes.SUCCESS).json(SystemResponse.success("OTP sent successfully"));
  } catch (error) {
    if (error.statusCode && error.statusCode !== 500) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError(error.message));
    }
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError(error.message || "Internal Server Error"));
  }
};

export const verifyOtp = async (req, res, next) => {
  const { phone_number, otp, dial_code } = req.body;

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

  const deviceId = req.headers["x-device-id"] || null;

  try {
    const result = await verifyOtpService(phone_number, otp, ip, deviceId, dial_code);

    const isProd = process.env.NODE_ENV === "production";
    res.cookie("access_token", result.accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 15 * 60 * 1000,
    });

    res.cookie("refresh_token", result.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 10 * 24 * 60 * 60 * 1000,
    });

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success("Login successful via OTP", {
        ...result.user,
        vendor_mode: result.user.Vendor?.vendor_mode ?? 0
      }));
  } catch (error) {
    console.error("Verify OTP Error:", error);
    if (error.statusCode && error.statusCode !== 500) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError(error.message));
    }
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError(error.message || "Internal Server Error"));
  }
};
