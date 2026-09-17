import express from "express";
import {
  login,
  signup,
  forgotPassword,
  logOut,
  resetPassword,
  changePassword,
  verifyEmail,
  sendOtp,
  verifyOtp,
  autoLogin,
} from "./auth.controller.js";
import {
  validateLogin,
  validateSignup,
  validateForgotPassword,
  validateResetPassword,
  validateChangePassword,
  validateSendOtp,
  validateVerifyOtp,
  validateVerifyEmail,
  validateAutoLogin,
} from "./auth.validation.js";
import { authenticate } from "../../middlewares/authMiddleware.js";
import linkedinrouter from "./linkedin.routes.js";

const router = express.Router();

router.post("/signup", validateSignup, signup);

router.post("/login", validateLogin, login);

router.post("/forgot-password", validateForgotPassword, forgotPassword);

router.post("/reset-password", validateResetPassword, resetPassword);

router.get("/verify-email", validateVerifyEmail, verifyEmail);

router.get("/auto-login/:token", validateAutoLogin, autoLogin);

router.post("/send-otp", validateSendOtp, sendOtp);

router.post("/verify-otp", validateVerifyOtp, verifyOtp);

router.post("/logout", logOut);

router.post("/change-password", validateChangePassword, authenticate, changePassword);

router.use("/linkedin", linkedinrouter);

export default router;
