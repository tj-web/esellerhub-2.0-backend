import sequelize from "../../db/connection.js";
import { hashPassword, generateToken } from "../../helpers/cryptoHelper.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import {
  isEmailExists,
  isPhoneExists,
  createVendor,
  createVendorAuth,
  findUserByEmail,
  createVendorDetails,
  createVendorLeads,
} from "../common/service/userService.js";
import { sendVerificationEmail, sendAdminNotification } from "../common/service/emailService.js";
import { renderTemplate } from "../../helpers/emailHelper.js";
import validator from "validator";
import Vendor from "../../models/vendor.model.js";
import PasswordReset from "../../models/passwordReset.model.js";
import LoginHistory from "../../models/loginHistory.model.js";
import VendorAuth from "../../models/vendorAuth.model.js";
import { AppError } from "../../utilis/appError.js";
import StatusCodes from "../../utilis/statusCodes.js";
import SystemResponse from "../../utilis/systemResponse.js";
import { publishEmailToQueue } from "../../config/rabbitmq.producer.js";
import engagementEvent from "../../helpers/engagementEvent.js";

export const handleResetPassword = async (token, newPassword) => {
  const record = await PasswordReset.findOne({
    where: { token },
  });

  if (!record) {
    throw new AppError("Invalid or expired token", 400);
  }

  const now = new Date();
  const createdAt = new Date(record.created_at);

  const diffHours = (now - createdAt) / (1000 * 60 * 60);

  if (diffHours > 24) {
    throw new AppError("Token expired", 400);
  }

  const user = await VendorAuth.findOne({
    where: { email: record.email },
  });

  if (!user) {
    throw new AppError("User not found", 400);
  }

  const hashedPassword = await hashPassword(newPassword);

  const transaction = await sequelize.transaction();

  try {
    await VendorAuth.update(
      { password: hashedPassword },
      {
        where: { email: record.email },
        transaction,
      }
    );

    // Update vendor table password
    await Vendor.update(
      { password: hashedPassword },
      {
        where: { id: user.vendor_id },
        transaction,
      }
    );

    await transaction.commit();
    await clearAllSessionsByVendorId(user.vendor_id);

    return true;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};


export const logoutService = async (refreshToken) => {
  if (!refreshToken) {
    return { message: "Already logged out", expired: true };
  }

  try {
    const record = await LoginHistory.findOne({
      where: { auth_token: refreshToken, login_status: 1 }
    });

    if (!record) {
      return { message: "Session already expired", expired: true };
    }

    await LoginHistory.update({ login_status: 0, auth_token: null }, { where: { id: record.id } });
  } catch (err) {
    console.error("Login history update error:", err);
  }

  return {
    message: "Logout successful",
    expired: false,
  };
};



export const handleForgotPassword = async (email) => {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await findUserByEmail(normalizedEmail);

  if (!user) {
    throw new AppError("User not found", 400);
  }

  const { token } = generateToken();

  await PasswordReset.create({
    email: normalizedEmail,
    token,
    created_at: new Date(),
  });

  const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  const mainsiteUrl = process.env.MAINSITE_URL || "https://www.techjockey.com/";
  const assetUrl = `${mainsiteUrl}assets/images/`;
  const tjassetUrl = `${mainsiteUrl}assets/nw-wb/emailer_img/`;

  const emailBody = await renderTemplate("reset-password", {
    assetUrl,
    normalizedEmail,
    resetLink,
    mainsiteUrl,
    tjassetUrl,
  });

  await publishEmailToQueue({
    rawHtml: emailBody,
    subject: "Reset Password",
    emailType: "forget_password",
    to: normalizedEmail,
  });

  return true;
};


export const registerVendor = async (data) => {
  const {
    frmtype,
    first_name,
    last_name,
    email,
    dial_code,
    contact_number,
    password,
    company_name,
  } = data;

  const normalizedEmail = email.trim().toLowerCase();
  const countryMap = {
    "+91": "en-IN",
    "+1": "en-US",
    "+44": "en-GB",
  };

  const locale = countryMap[dial_code];

  if (!locale) {
    throw new AppError("Unsupported country code", 400);
  }

  let number = contact_number;

  if (number.startsWith("0")) {
    number = number.substring(1);
  }

  const fullNumber = `${dial_code}${number}`;

  if (!validator.isMobilePhone(fullNumber, locale, { strictMode: true })) {
    throw new AppError("Invalid phone number", 400);
  }

  if (await isEmailExists(normalizedEmail)) {
    throw new AppError("Your email is already registered", 400);
  }

  if (await isPhoneExists(dial_code, number)) {
    throw new AppError("Your phone is already registered", 400);
  }

  const hashedPassword = await hashPassword(password);
  const { token, hash } = generateToken();

  const transaction = await sequelize.transaction();

  try {
    const vendor = await createVendor(
      {
        first_name,
        last_name,
        email: normalizedEmail,

        hash_string: hash,

        dial_code,
        phone: number,

        password: hashedPassword,

        vendor_type: 0,
        signup_progress: 2,

        email_verified: 0,
        status: 1,
        admin_verified: 1,
        is_deleted: 0,
        is_temp: 1,

        app_dec_comment: "",
        show_popup_date: new Date(),
        registration_source: "1",
        creation_source: 1,

        created_at: new Date(),
      },
      transaction
    );

    const vendorAuth = await createVendorAuth(
      {
        vendor_id: vendor.id,

        first_name,
        last_name,
        email: normalizedEmail,

        dial_code,
        phone: number,

        password: hashedPassword,

        created_at: new Date(),

        hash_string: hash,

        email_verified: 0,
        status: 1,
        is_deleted: 0,

        is_admin: 1,
        is_acd: 1,
        admin_verified: 1,

        sort_order: 0,
      },
      transaction
    );

    await createVendorDetails(
      {
        vendor_id: vendor.id,
        company: company_name || "",
        country: 99,
      },
      transaction
    );

    await createVendorLeads(
      {
        vendor_id: vendor.id,
        first_name,
        last_name,
        email: normalizedEmail,
        dial_code,
        phone: number,
        created_at: new Date(),
        creation_source: 1,
        company: "NA",
        is_deleted: 0,
      },
      transaction
    );

    await sendVerificationEmail(normalizedEmail, token, vendor.id, transaction);

    await sendAdminNotification(
      first_name,
      last_name,
      normalizedEmail,
      dial_code,
      number,
      vendor.id,
      transaction
    );

    await transaction.commit();

    /* Trigger MoEngage OEM Signup Event */
   await engagementEvent.oemSignupEvent({
      id: vendorAuth.id,
      vendor_id: vendor.id,
      first_name,
      last_name,
      email: normalizedEmail,
      dial_code,
      phone: number,
    }, "Web");

    return {
      message: "Signup successful. Verification email sent , check your email !",
      vendor_id: vendor.id,
      profile_id: vendorAuth.id,
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

/**
 * Generates auth and refresh tokens for a user.
 */
export const generateAuthTokens = (user) => {
  if (!process.env.ACCESS_TOKEN_SECRET) {
    throw new Error("Missing ACCESS_TOKEN_SECRET");
  }
  if (!process.env.REFRESH_TOKEN_SECRET) {
    throw new Error("Missing REFRESH_TOKEN_SECRET");
  }

  const payload = {
    vendor_id: user.vendor_id,
    profile_id: user.id,
    v_email: user.email,
    vendor_mode: user.Vendor?.vendor_mode ?? user.vendor_mode ?? user.vendorMode ?? 0,
  };

  const accessToken = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, { expiresIn: "15m" });

  const refreshToken = jwt.sign(
    { vendor_id: user.vendor_id, email: user.email },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: "10d" }
  );
  return { accessToken, refreshToken };
};

export const createLoginHistory = async (
  user,
  ip,
  deviceId,
  refreshToken,
  loginVia = "native_auth"
) => {
  try {
    const record = await LoginHistory.create({
      email_id: user.email,
      source: "website",
      login_via: loginVia,
      ip,
      device_id: deviceId,
      login_status: 1,
      profile_id: user.id ,
      auth_token: refreshToken,
    });

    const now = new Date();
    await VendorAuth.update({ last_login_date: now }, { where: { id: user.id } });
    await Vendor.update({ last_login_date: now }, { where: { id: user.vendor_id } });

    return record.id;
  } catch (e) {
    console.error("Login history error:", e);
    return null;
  }
};

/**
 * Verifies the provided password against the database hash.
 */export const verifyPassword = async (inputPassword, dbPassword) => {
  const hashed = await hashPassword(inputPassword);
  return hashed === dbPassword;
};

export const clearAllSessionsByVendorId = async (vendorId) => {
  const user = await VendorAuth.findOne({ where: { vendor_id: vendorId } });
  if (user) {
    await LoginHistory.update(
      { login_status: 0, auth_token: null },
      { where: { email_id: user.email } }
    );
  }
};

export const handleChangePassword = async (vendorId, oldPassword, newPassword) => {
  if (!vendorId) {
    throw new AppError("Unauthorized", 401);
  }

  const user = await VendorAuth.findOne({
    where: {
      vendor_id: vendorId,
      is_deleted: 0,
    },
  });

  if (!user) {
    throw new AppError("User not found", 404);
  }

  const oldHashed = await hashPassword(oldPassword);

  if (user.password !== oldHashed) {
    throw new AppError("Old password incorrect", 400);
  }

  if (oldPassword === newPassword) {
    throw new AppError("New password must be different", 400);
  }

  const newHashed = await hashPassword(newPassword);

  const transaction = await sequelize.transaction();

  try {
    await VendorAuth.update(
      { password: newHashed },
      { where: { vendor_id: vendorId }, transaction }
    );

    await Vendor.update({ password: newHashed }, { where: { id: vendorId }, transaction });

    await transaction.commit();
    await clearAllSessionsByVendorId(vendorId);

    return true;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};
