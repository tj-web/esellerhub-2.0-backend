import {
  getVendorData,
  getDesignation,
  getBillingCountryStateCity,
  getVendorCountryStateCity,
  updateVendorAuth,
  updateVendorDetails,
  getSearchedLocations,
} from "./companyInformation.service.js";
import { uploadFileToS3 } from "../../utilis/s3Uploader.js";
import StatusCodes from "../../utilis/statusCodes.js";
import SystemResponse from "../../utilis/systemResponse.js";
import engagementEvent from "../../helpers/engagementEvent.js";

export const getCompanyInfo = async (req, res) => {
  try {
    const profile_id = req.user.profile_id;

    if (!profile_id) {
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(SystemResponse.badRequestError("Profile ID is required"));
    }

    let v_info = await getVendorData({ profile_id });
    if (!v_info) {
      return res
        .status(StatusCodes.NOT_FOUND)
        .json(SystemResponse.notFoundError("Vendor not found"));
    }

    let arr_designation = await getDesignation();

    const billing_address = await getBillingCountryStateCity({
      billing_country: v_info.billing_country,
      billing_state: v_info.billing_state,
      billing_city: v_info.billing_city,
    });

    v_info.billing_country_name = billing_address.billing_country_name;
    v_info.billing_state_name = billing_address.billing_state_name;
    v_info.billing_city_name = billing_address.billing_city_name;

    const oem_address = await getVendorCountryStateCity({
      country: v_info.country,
      state: v_info.state,
      city: v_info.city,
    });

    v_info.country_name = oem_address.country_name;
    v_info.state_name = oem_address.state_name;
    v_info.city_name = oem_address.city_name;

    const arr = {
      vendData: v_info,
      arr_designation: arr_designation,
      active_tab: "company_information",
      current_page: "company_information",
      title: "Company Information-Esellerhub Techjockey",
    };

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success("Company Information Fetched Successfully.", arr));
  } catch (error) {
    console.error("Error in getCompanyInfo:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError("Error in fetching company information", error.message));
  }
};

/* 1. SAVE/UPDATE ACCOUNT INFO */
export const saveAccountInfo = async (req, res) => {
  try {
    const { form_type, ...formData } = req.body;
    const profile_id = req.user.profile_id;
    const vendor_id = req.user.vendor_id;

    if (!profile_id || !vendor_id) {
      return res
        .status(StatusCodes.UNAUTHORIZED)
        .json(SystemResponse.unauthorizedError("Unauthorized: Invalid user identity"));
    }

    // Intercept image buffers and securely dispatch to S3
    if (req.files) {
      if (req.files.gst_document && req.files.gst_document.length > 0) {
        const file = req.files.gst_document[0];
        const fileName = `${vendor_id}_gst_${file.originalname.replace(/\s+/g, "-")}`;
        const fileobj = {
          ...file,
          key: `eseller/assets/img/vendor_doc/${fileName}`,
        };
        await uploadFileToS3(fileobj);
        formData.gst_document = fileName;
      }

      if (req.files.pan_document && req.files.pan_document.length > 0) {
        const file = req.files.pan_document[0];
        const fileName = `${vendor_id}_pan_${file.originalname.replace(/\s+/g, "-")}`;
        const fileobj = {
          ...file,
          key: `eseller/assets/img/vendor_doc/${fileName}`,
        };
        await uploadFileToS3(fileobj);
        formData.pan_document = fileName;
      }
    }

    if (form_type === "company_detail_from") {
      if (formData.first_name !== undefined || formData.last_name !== undefined) {
        await updateVendorAuth(profile_id, {
          first_name: formData.first_name,
          last_name: formData.last_name,
        });
      }

      await updateVendorDetails(vendor_id, formData);
    } else if (form_type === "billng_info_from" || form_type === "bank_detail_from") {
      await updateVendorDetails(vendor_id, formData);
    }

    // Sync updated vendor profile with the active engagement provider
    const updatedVendor = await getVendorData({ profile_id });
    if (updatedVendor) {
      const oem_address = await getVendorCountryStateCity({
        country: updatedVendor.country,
        state: updatedVendor.state,
        city: updatedVendor.city,
      });
      updatedVendor.country_name = oem_address.country_name;
      updatedVendor.state_name = oem_address.state_name;
      updatedVendor.city_name = oem_address.city_name;

      engagementEvent.updateEsellerProfile(updatedVendor);

      if (form_type === "company_detail_from") {
        engagementEvent.trackCompanyInfoEvent(req.user, {
          ...formData,
          country_name: updatedVendor.country_name,
          state_name: updatedVendor.state_name,
          city_name: updatedVendor.city_name,
        }).catch((err) => {
          console.error("[MoEngage Error] Failed to fire trackCompanyInfoEvent in saveAccountInfo:", err);
        });
      }
    }

    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success("Information updated successfully"));
  } catch (error) {
    console.error("Error in saveAccountInfo:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError("Internal Server Error", error.message));
  }
};

/* 2. SEARCH COUNTRY/STATE/CITY */
export const searchLocation = async (req, res) => {
  try {
    const { search, search_by, context_id } = req.query;
    const results = await getSearchedLocations(search, search_by, context_id);
    return res
      .status(StatusCodes.SUCCESS)
      .json(SystemResponse.success("Locations Searched Successfully.", results));
  } catch (error) {
    console.error("Error in searchLocation:", error);
    return res
      .status(StatusCodes.INTERNAL_SERVER_ERROR)
      .json(SystemResponse.internalServerError("Internal Server Error", error.message));
  }
};
