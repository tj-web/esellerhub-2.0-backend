import { body, validationResult } from "express-validator";
import StatusCodes from "../../utilis/statusCodes.js";

const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(StatusCodes.UNPROCESSABLE_ENTITY).json({  
      success: false,
      errors: errors.array(),
    });
  }
  next();
};

// Helper to validate array or comma-separated string selections (for specifications)
const validateSpecField = (value) => {
  if (!value) return false;
  if (Array.isArray(value) && value.length > 0) return true;
  if (typeof value === "string" && value.trim() !== "") return true;
  if (typeof value === "number") return true;
  return false;
};

// ==========================================
// 1. Company Information Validation
// ==========================================
export const validateCompanyInfo = [
  body("company_name")
    .notEmpty()
    .withMessage("Company Name is required")
    .trim(),

  body("contact_prsn_desg")
    .notEmpty()
    .withMessage("Please Select Designation"),

  body("designation_id")
    .notEmpty()
    .withMessage("Designation ID is required")
    .isNumeric()
    .withMessage("Designation ID must be numeric"),

  body("contact_prsn_phone")
    .notEmpty()
    .withMessage("Enter Phone Number")
    .isNumeric()
    .withMessage("Phone Number must be numeric")
    .isLength({ min: 10, max: 10 })
    .withMessage("Phone Number field must contain exactly 10 digits"),

  body("contact_prsn_email")
    .notEmpty()
    .withMessage("Enter Email")
    .isEmail()
    .withMessage("Invalid email format")
    .trim()
    .toLowerCase(),

  body("contact_prsn_name")
    .custom((value, { req }) => {
      const is_cont = req.body.is_cont_prsn;
      if (!is_cont || is_cont === "0" || is_cont === 0 || is_cont === false) {
        if (!value || value.trim() === "") {
          throw new Error("Enter Name");
        }
      }
      return true;
    }),

  validateRequest,
];

// ==========================================
// 2. Brand Details Validation
// ==========================================
export const validateBrandDetails = [
  body("brand_name")
    .custom((value, { req }) => {
      const isCompany =
        req.body.is_company_name === 1 ||
        req.body.is_company_name === "1";

      const brandId = req.body.brand_id;

      if (
        !isCompany &&
        (!brandId || String(brandId).trim() === "") &&
        (!value || String(value).trim() === "")
      ) {
        throw new Error("Please select or create brand...");
      }
      return true;
    }),

  validateRequest,
];

// ==========================================
// 3. Product Details Validation
// ==========================================
export const validateProductDetails = [
  body("product_name")
    .notEmpty()
    .withMessage("Product Name is required")
    .trim(),

  body("product_brand_id")
    .notEmpty()
    .withMessage("Please Select Brand"),

  body("primary_category")
    .notEmpty()
    .withMessage("Please Select Primary Category"),

  body("deployment")
    .custom((value) => {
      if (!validateSpecField(value)) {
        throw new Error("Please select at least one Deployment option");
      }
      return true;
    }),

  body("operating_system")
    .custom((value) => {
      if (!validateSpecField(value)) {
        throw new Error("Please select at least one Operating System");
      }
      return true;
    }),

  body("device")
    .custom((value) => {
      if (!validateSpecField(value)) {
        throw new Error("Please select at least one Device");
      }
      return true;
    }),

  body("organization_type")
    .custom((value) => {
      if (!validateSpecField(value)) {
        throw new Error("Please select at least one Business/Organization Type");
      }
      return true;
    }),

  // Compulsory Product Logo validation
  body("product_logo")
    .custom((value, { req }) => {
      const hasOldLogo = req.body.old_product_logo && String(req.body.old_product_logo).trim() !== "";
      let hasUploadedLogo = false;
      
      if (req.files) {
        if (Array.isArray(req.files)) {
          hasUploadedLogo = req.files.some((f) => f.fieldname === "product_logo");
        } else if (typeof req.files === "object") {
          hasUploadedLogo = Boolean(req.files.product_logo || Object.values(req.files).flat().some((f) => f.fieldname === "product_logo"));
        }
      } else if (req.file && req.file.fieldname === "product_logo") {
        hasUploadedLogo = true;
      }

      if (!hasOldLogo && !hasUploadedLogo) {
        throw new Error("Product Logo is required");
      }
      return true;
    }),

  // Compulsory Product Image 1 (Screenshot) validation
  body("product_image1")
    .custom((value, { req }) => {
      const hasOldImg1 = req.body.old_product_image1 && String(req.body.old_product_image1).trim() !== "";
      let hasUploadedImg1 = false;
      
      if (req.files) {
        if (Array.isArray(req.files)) {
          hasUploadedImg1 = req.files.some((f) => f.fieldname === "product_image1");
        } else if (typeof req.files === "object") {
          hasUploadedImg1 = Boolean(req.files.product_image1 || Object.values(req.files).flat().some((f) => f.fieldname === "product_image1"));
        }
      } else if (req.file && req.file.fieldname === "product_image1") {
        hasUploadedImg1 = true;
      }

      if (!hasOldImg1 && !hasUploadedImg1) {
        throw new Error("Product Image 1 is required");
      }
      return true;
    }),

  validateRequest,
];

// Unified dispatcher middleware for legacy POST / (form_type) without code duplication
export const validatePartnerSetup = async (req, res, next) => {
  const { form_type } = req.body;
  if (!form_type) {
    return res.status(422).json({
      success: false,
      errors: [{ msg: "Form type is required", path: "form_type" }],
    });
  }

  let validatorChain;
  if (form_type === "company_setup") {
    validatorChain = validateCompanyInfo;
  } else if (form_type === "brand_setup") {
    validatorChain = validateBrandDetails;
  } else if (form_type === "product_setup") {
    validatorChain = validateProductDetails;
  } else {
    return res.status(422).json({
      success: false,
      errors: [{ msg: "Invalid form type", path: "form_type" }],
    });
  }

  // Execute the selected validator chain sequentially
  for (const middleware of validatorChain) {
    await new Promise((resolve) => {
      middleware(req, res, (err) => resolve(err));
    });
    if (res.headersSent) return;
  }
  next();
};
