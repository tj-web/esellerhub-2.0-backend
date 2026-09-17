import { body, query, param, validationResult } from "express-validator";
import validator from "validator";

const validateRequest = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({
            success: false,
            errors: errors.array(),
        });
    }
    next();
};

// ***************************************************************

export const validateChangePassword = [
    body("frmtype")
        .notEmpty()
        .withMessage("Form type is required")
        .equals("change_password")
        .withMessage("Invalid form type"),

    body("old_password").notEmpty().withMessage("Old password is required"),

    body("new_password")
        .notEmpty()
        .withMessage("New password is required")
        .isLength({ min: 8, max: 50 })
        .withMessage("Password must be between 8 and 50 characters"),

    body("confirm_password")
        .notEmpty()
        .withMessage("Confirm password is required")
        .custom((value, { req }) => {
            if (value !== req.body.new_password) {
                throw new Error("Passwords do not match");
            }
            return true;
        }),

    validateRequest,
];

// ***************************************************************

export const validateForgotPassword = [
    body("frmtype")
        .notEmpty()
        .withMessage("Form type is required")
        .equals("forget_password")
        .withMessage("Invalid form type"),

    body("email")
        .notEmpty()
        .withMessage("Email is required")
        .isEmail()
        .withMessage("Invalid email format")
        .isLength({ min: 5, max: 255 })
        .withMessage("Email must be between 5 and 255 characters")
        .trim()
        .toLowerCase(),

    validateRequest,
];

// ***************************************************************

export const validateLogin = [
    body("frmtype")
        .notEmpty()
        .withMessage("Form type is required")
        .equals("vendor_login")
        .withMessage("Invalid form type"),

    body("username")
        .notEmpty()
        .withMessage("Username is required")
        .isEmail()
        .withMessage("Username must be a valid email")
        .trim()
        .toLowerCase(),

    body("userpassword").notEmpty().withMessage("Password is required"),

    body("rememberme")
        .notEmpty()
        .withMessage("Remember me is required")
        .isIn(["0", "1", 0, 1, true, false])
        .withMessage("Remember me must be 0 or 1"),

    validateRequest,
];

// ***************************************************************

export const validateResetPassword = [
    query("token").notEmpty().withMessage("Token is required").trim(),

    body("new_password")
        .notEmpty()
        .withMessage("New password is required")
        .isLength({ min: 8, max: 50 })
        .withMessage("Password must be between 8 and 50 characters"),

    body("confirm_password")
        .notEmpty()
        .withMessage("Confirm password is required")
        .custom((value, { req }) => {
            if (value !== req.body.new_password) {
                throw new Error("Passwords do not match");
            }
            return true;
        }),

    validateRequest,
];

// ***************************************************************

export const validateSendOtp = [
    body("frmtype")
        .notEmpty()
        .withMessage("Form type is required")
        .equals("send_otp")
        .withMessage("Invalid form type"),

    body("phone_number")
        .notEmpty()
        .withMessage("Phone number is required")
        .custom((value) => {
            if (!validator.isMobilePhone(value, "any")) {
                throw new Error("Invalid phone number");
            }
            return true;
        })
        .trim(),

    validateRequest,
];

// ***************************************************************

export const validateSignup = [
    body("frmtype")
        .notEmpty()
        .withMessage("Form type is required")
        .equals("vendor_register")
        .withMessage("Invalid form type"),

    body("first_name")
        .notEmpty()
        .withMessage("First name is required")
        .isString()
        .withMessage("First name must be a string")
        .trim(),

    body("last_name")
        .notEmpty()
        .withMessage("Last name is required")
        .isString()
        .withMessage("Last name must be a string")
        .trim(),

    body("email")
        .notEmpty()
        .withMessage("Email is required")
        .isEmail()
        .withMessage("Invalid email format")
        .trim()
        .toLowerCase(),

    body("dial_code")
        .notEmpty()
        .withMessage("Dial code is required")
        .isIn(["+91", "+1", "+44"])
        .withMessage("Unsupported country code"),

    body("contact_number")
        .notEmpty()
        .withMessage("Contact number is required")
        .isLength({ min: 6, max: 15 })
        .withMessage("Invalid contact number"),

    body("password")
        .notEmpty()
        .withMessage("Password is required")
        .isLength({ min: 8 })
        .withMessage("Password must be at least 8 characters"),

    body("email").custom((value) => {
        const blockedDomains = [
            "gmail.com",
            "yahoo.com",
            "hotmail.com",
            "outlook.com",
            "live.com",
        ];

        const domain = value.split("@")[1];

        if (blockedDomains.includes(domain)) {
            throw new Error("Please use company email");
        }

        return true;
    }),

    validateRequest,
];

// ***************************************************************

export const validateVerifyEmail = [
    query("token").notEmpty().withMessage("Token is required").trim(),
    validateRequest,
];

// ***************************************************************

export const validateAutoLogin = [
    param("token").notEmpty().withMessage("Token is required"),
    validateRequest,
];

// ***************************************************************

export const validateVerifyOtp = [
    body("frmtype")
        .notEmpty()
        .withMessage("Form type is required")
        .equals("verify_otp")
        .withMessage("Invalid form type"),

    body("phone_number")
        .notEmpty()
        .withMessage("Phone number is required")
        .custom((value) => {
            if (!validator.isMobilePhone(value, "any")) {
                throw new Error("Invalid phone number");
            }
            return true;
        })
        .trim(),

    body("otp")
        .notEmpty()
        .withMessage("OTP is required")
        .isLength({ min: 4, max: 6 })
        .withMessage("OTP must be 4 to 6 digits")
        .isNumeric()
        .withMessage("OTP must be numeric"),

    validateRequest,
];
