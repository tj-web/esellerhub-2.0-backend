import StatusCodes from "../../utilis/statusCodes.js";
import SystemResponse from "../../utilis/systemResponse.js";
import {
  getPartnerSetupData,
  saveCompanySetup as saveCompanySetupServiceFn,
  saveBrandSetup as saveBrandSetupServiceFn,
  saveProductSetup as saveProductSetupServiceFn,
  searchMainBrands as searchMainBrandsServiceFn,
} from "./partnerSetup.service.js";
import { getCategoryList } from "../product/product.service.js";
import engagementEvent from "../../helpers/engagementEvent.js";

/**
 * GET Initial Partner Setup Data (Fetches company, brand, product setup statuses & prefill data)
 */
export const getPartnerSetupInfo = async (req, res) => {
  try {
    const profile_id = req.user?.profile_id;
    const vendor_id = req.user?.vendor_id;

    if (!profile_id || !vendor_id) {
      return res
        .status(StatusCodes.UNAUTHORIZED)
        .json(SystemResponse.unauthorizedError("Unauthorized: Invalid user identity"));
    }

    const data = await getPartnerSetupData({ profile_id, vendor_id });

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success("Partner setup data fetched successfully", data));
  } catch (error) {
    console.error("Error in getPartnerSetupInfo:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError("Error in fetching partner setup info", error.message));
  }
};

/**
 * GET Search Categories (For Product Setup step in Partner Setup)
 */
export const getSetupCategories = async (req, res) => {
  try {
    const { search = "", limit = 100, offset = 0 } = req.query;
    const categories = await getCategoryList(search, limit, offset);

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success("Categories fetched successfully", categories));
  } catch (error) {
    console.error("Error in getSetupCategories:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError("Error in fetching categories", error.message));
  }
};

/**
 * GET Search Main Brands (For dropdown selection in Brand Setup step)
 */
export const searchMainBrands = async (req, res) => {
  try {
    const { search = "", type = "public" } = req.query;
    const brands = await searchMainBrandsServiceFn(search);

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success("Main brands fetched successfully", brands));
  } catch (error) {
    console.error("Error in searchMainBrands:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError("Error in searching main brands", error.message));
  }
};

/**
 * POST Step 1: Save Company Information
 */
export const saveCompanySetup = async (req, res) => {
  try {
    const vendor_id = req.user?.vendor_id;

    if (!vendor_id) {
      return res
        .status(StatusCodes.UNAUTHORIZED)
        .json(SystemResponse.unauthorizedError("Unauthorized: Invalid user identity"));
    }

    const result = await saveCompanySetupServiceFn(vendor_id, req.body);

    // Fire MoEngage Company Information Event Action
    engagementEvent.trackCompanyInfoEvent(req.user, req.body).catch((err) => {
      console.error("[MoEngage Error] Failed to fire trackCompanyInfoEvent in saveCompanySetup:", err);
    });

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success(result.message, result));
  } catch (error) {
    console.error("Error in saveCompanySetup:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError("Error in saving company information", error.message));
  }
};

/**
 * POST Step 2: Save Brand Details
 */
export const saveBrandSetup = async (req, res) => {
  try {
    const vendor_id = req.user?.vendor_id;

    if (!vendor_id) {
      return res
        .status(StatusCodes.UNAUTHORIZED)
        .json(SystemResponse.unauthorizedError("Unauthorized: Invalid user identity"));
    }

    const result = await saveBrandSetupServiceFn(vendor_id, req.body);

    if (!result.status) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError(result.message));
    }

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success(result.message, result));
  } catch (error) {
    console.error("Error in saveBrandSetup:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError("Error in saving brand information", error.message));
  }
};

/**
 * POST Step 3: Save Product Details (with images & specifications)
 */
export const saveProductSetup = async (req, res) => {
  try {
    const vendor_id = req.user?.vendor_id;

    if (!vendor_id) {
      return res
        .status(StatusCodes.UNAUTHORIZED)
        .json(SystemResponse.unauthorizedError("Unauthorized: Invalid user identity"));
    }

    const result = await saveProductSetupServiceFn(
      vendor_id,
      req.body,
      req.files
    );

    if (!result.status) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError(result.message));
    }

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success(result.message, result));
  } catch (error) {
    console.error("Error in saveProductSetup:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError("Error in saving product information", error.message));
  }
};

/**
 * POST Save Partner Setup (Unified dispatcher for legacy form_type submissions)
 */
export const savePartnerSetup = async (req, res) => {
  const { form_type } = req.body;

  if (form_type === "company_setup") {
    return saveCompanySetup(req, res);
  } else if (form_type === "brand_setup") {
    return saveBrandSetup(req, res);
  } else if (form_type === "product_setup") {
    return saveProductSetup(req, res);
  }

  return res
    .status(StatusCodes.BAD_REQUEST)
    .json(SystemResponse.badRequestError("Invalid form_type or step not recognized"));
};
