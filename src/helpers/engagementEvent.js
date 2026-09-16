import moengageService from "../config/moengage.service.js";
import { findUserByProfileId, findUserByVendorId } from "../modules/common/service/userService.js";
import { encodeData } from "./cryptoHelper.js";
import { getShortUrl } from "./shortUrl.js";
import TblLeads from "../models/leads.model.js";
import TblProduct from "../models/product.model.js";
import Brand from "../models/brand.model.js";
import Category from "../models/category.model.js";
import VendorAuth from "../models/vendorAuth.model.js";
import { Op } from "sequelize";

const engagementProvider = process.env.ENGAGEMENT_PROVIDER;

class EngagementEvent {
  get providerService() {
    switch (engagementProvider) {
      case "moengage":
        return moengageService;
      default:
        console.warn(`[Engagement Warning] Unsupported provider: ${engagementProvider}`);
        return null;
    }
  }

  /**
   * Helper to resolve full vendor profile details.
   * If a lightweight object (like req.user from JWT) is passed, it queries DB for complete first_name, last_name, email, phone.
   */
  async _resolveVendorDetails(user) {
    if (!user) return null;

    const profileId = user.id || user.profile_id;
    const vendorId = user.vendor_id;

    let fullUser = user;

    const hasFirstName = user.first_name || user.Vendor?.first_name;
    const hasEmail = user.email || user.v_email;
    if (!hasFirstName || !hasEmail) {
      if (profileId) {
        const fetched = await findUserByProfileId(profileId);
        if (fetched) fullUser = fetched;
      } else if (vendorId) {
        const fetched = await findUserByVendorId(vendorId);
        if (fetched) fullUser = fetched;
      }
    }

    const vendorObj = fullUser.Vendor || fullUser;
    const resolvedProfileId = fullUser.id || fullUser.profile_id || profileId;
    const resolvedVendorId = fullUser.vendor_id || vendorId;

    const firstName = vendorObj.first_name || fullUser.first_name || "";
    const lastName = vendorObj.last_name || fullUser.last_name ||  "";
    const email = fullUser.email ||  vendorObj.email || "";
    const dialCode = fullUser.dial_code || vendorObj.dial_code || "91";
    const phoneNum = fullUser.phone || vendorObj.phone ||  "";
    const fullPhone = phoneNum ? `+${String(dialCode).replace("+", "")}${phoneNum}` : "";

    return {
      profileId: resolvedProfileId,
      vendorId: resolvedVendorId,
      firstName,
      lastName,
      email,
      phone: fullPhone,
      fullUser,
    };
  }

  /**
   * Fires OEM Login Event (Web / App)
   * @param {object} user - VendorAuth / Vendor object or req.user
   * @param {string} source - 'Web' or 'App'
   */
  async oemLoginEvent(user, source = "Web") {
    try {
      if (!user) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const attributes = {
        "Profile Id": resolved.profileId,
        "Vendor Id": resolved.vendorId,
        "First Name": resolved.firstName,
        "Last Name": resolved.lastName,
        "Email": resolved.email,
        "Phone": resolved.phone,
        "Date": new Date().toISOString().replace("T", " ").substring(0, 19),
      };

      return await providerService.trackEsellerEvent(resolved.profileId, `OEM Login ${source}`, attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process oemLoginEvent:", error);
    }
  }

  /**
   * Fires OEM Signup Event (Web / App)
   * @param {object} user - VendorAuth / Vendor object or req.user
   * @param {string} source - 'Web' or 'App'
   */
  async oemSignupEvent(user, source = "Web") {
    try {
      if (!user) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const attributes = {
        "Profile Id": resolved.profileId,
        "Vendor Id": resolved.vendorId,
        "First Name": resolved.firstName,
        "Last Name": resolved.lastName,
        "Email": resolved.email,
        "Phone": resolved.phone,
        "Date": new Date().toISOString().replace("T", " ").substring(0, 19),
      };

      return await providerService.trackEsellerEvent(resolved.profileId, `OEM Signup ${source}`, attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process oemSignupEvent:", error);
    }
  }

  async updateEsellerProfile(vendor) {
    try {
      if (!vendor) return;

      const providerService = this.providerService;
      if (!providerService) return;

      return await providerService.updateEsellerProfile(vendor);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process updateEsellerProfile:", error);
    }
  }

  /**
   * Fires OEM Complete Onboarding Event
   * @param {object} user - VendorAuth / Vendor object or req.user
   */
  async oemOnboardingComplete(user) {
    try {
      if (!user) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .substring(0, 19);

      const mainsiteUrl = (process.env.MAINSITE_URL).replace(/\/$/, "");

      const oemData = {
        profile_id: resolved.profileId,
        vendor_id: resolved.vendorId,
        email: resolved.email,
        action: { name: "dashboard", params: {} },
        redirect_uri: `${mainsiteUrl}/dashboard`,
        expiration_date: expirationDate,
      };

      const encodedData = encodeData(oemData);
      const longUrl = `${mainsiteUrl}/login/autoLogin/${encodedData}`;
      const oemLoginLink = await getShortUrl(longUrl);

      const fullName = `${resolved.firstName} ${resolved.lastName}`.trim();

      const attributes = {
        "OEM Name": fullName || resolved.firstName,
        "OEM Email": resolved.email,
        "OEM Phone": resolved.phone,
        "OEM Login Link": oemLoginLink,
      };

      return await providerService.trackEsellerEvent(resolved.profileId, "OEM Complete Onboarding", attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process oemOnboardingComplete:", error);
    }
  }

  /**
   * Fires Company Information Event (Partner Setup Step 1 & Company Info module)
   * @param {object} user - VendorAuth / Vendor object or req.user
   * @param {object} companyData - Object containing company setup form fields or vendor profile info
   */
  async trackCompanyInfoEvent(user, companyData = {}) {
    try {
      if (!user) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const attributes = {
        "Company Name": companyData.company_name || companyData.company || "",
        "Designation": companyData.designation_name || companyData.designation || "",
        "Company Website": companyData.company_website || companyData.website_url || "",
        "Country": companyData.vendor_country || companyData.country_name || "",
        "State": companyData.vendor_state || companyData.state_name || "",
        "City": companyData.vendor_city || companyData.city_name || "",
        "Pincode": companyData.vendor_pincode || companyData.pincode || "",
        "Company Address": companyData.comp_address || companyData.company_address || companyData.billing_address || "",
        "Legal Entity Name": companyData.legal_entry_name || companyData.legal_entity_name || "",
        "Company Type": companyData.company_type || "",
        "Billing Address": companyData.billing_address || "",
        "Registered Under MSME Act 2006": companyData.msmed_act || "",
        "I'm Contact Person": companyData.is_cont_prsn || companyData.is_contact_person ? 1 : 0,
        "Contact Person Name": companyData.contact_prsn_name || companyData.cont_prsn_name || "",
        "Contact Person Designation": companyData.contact_prsn_desg || companyData.cont_prsn_desg || "",
        "Contact Person Email": companyData.contact_prsn_email || companyData.cont_prsn_email || "",
        "Contact Person Phone": companyData.contact_prsn_phone || companyData.cont_prsn_phone || "",
        "Date": new Date().toISOString().replace("T", " ").substring(0, 19),
      };

      return await providerService.trackEsellerEvent(resolved.profileId, "Company Information", attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process trackCompanyInfoEvent:", error);
    }
  }

  /**
   * Fires OEM Profile Complete-Stage 1 Event
   * @param {object} user - VendorAuth / Vendor object or req.user
   * @param {object} productInfo - Product details object containing product_id, product_name, slug, brand, category, etc.
   */
  async oemProfileCompleteStage1(user, productInfo = {}) {
    try {
      if (!user) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .substring(0, 19);

      const mainsiteUrl = (process.env.MAINSITE_URL || "http://localhost:3000").replace(/\/$/, "");

      const oemAutologinData = {
        profile_id: resolved.profileId,
        vendor_id: resolved.vendorId,
        email: resolved.email,
        action: { name: "acd", params: {} },
        redirect_uri: `${mainsiteUrl}/my_demos`,
        expiration_date: expirationDate,
      };

      const encodedData = encodeData(oemAutologinData);
      const longUrl = `${mainsiteUrl}/login/autoLogin/${encodedData}`;
      const vendorLoginLink = await getShortUrl(longUrl);
      const vendorLoginSlug = vendorLoginLink.replace("https://tj.link/", "");

      const fullName = `${resolved.firstName} ${resolved.lastName}`.trim();

      const attributes = {
        "Vendor Name": fullName,
        "Vendor Email": resolved.email,
        "Phone Number": resolved.phone,
        "Product Id": productInfo.product_id || productInfo.id || "",
        "Product Name": productInfo.product_name || "",
        "Product Slug": productInfo.slug || productInfo.product_slug || "",
        "Brand Id": productInfo.brand_id || productInfo.Brand?.brand_id || "",
        "Brand Name": productInfo.brand_name || productInfo.Brand?.brand_name || "",
        "Brand Slug": productInfo.brand_slug || productInfo.Brand?.slug || "",
        "Category Id": productInfo.category_id || productInfo.Category?.category_id || "",
        "Category Name": productInfo.category_name || productInfo.Category?.category_name || "",
        "Category Slug": productInfo.category_slug || productInfo.Category?.slug || "",
        "Vendor Login Link": vendorLoginLink,
        "Vendor Login Slug": vendorLoginSlug,
      };

      return await providerService.trackEsellerEvent(resolved.profileId, "OEM Profile Complete-Stage 1", attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process oemProfileCompleteStage1:", error);
    }
  }

  /**
   * Fires OEM Call Back Event / OEM Schedule Call Event
   * @param {object} user - VendorAuth / decoded token object / req.user
   * @param {object} callData - Callback & product info object
   */
  async scheduleCallEvent(user, callData = {}) {
    try {
      if (!user) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const acdUuid = callData.acd_uuid || callData.Acd_UUID || "";
      const eventName = acdUuid ? "OEM Call Back Event" : "OEM Schedule Call";

      const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .substring(0, 19);

      const mainsiteUrl = (process.env.MAINSITE_URL).replace(/\/$/, "");

      const oemAutologinData = {
        profile_id: resolved.profileId,
        vendor_id: resolved.vendorId,
        email: resolved.email,
        action: { name: "acd", params: {} },
        redirect_uri: `${mainsiteUrl}/my_demos`,
        expiration_date: expirationDate,
      };

      const encodedData = encodeData(oemAutologinData);
      const longUrl = `${mainsiteUrl}/login/autoLogin/${encodedData}`;
      const vendorLoginLink = await getShortUrl(longUrl);
      const vendorLoginSlug = vendorLoginLink.replace("https://tj.link/", "");

      const productSlug = callData.product_slug || callData.slug || "";
      const productName = callData.product_name || "";
      const shortProdName = productName.length > 30 ? productName.substring(0, 27) + ".." : productName;

      const attributes = {
        "Lead Id": callData.lead_id || callData.id || "",
        "Acd UUID": acdUuid,
        "Customer Name": callData.customer_name || callData.name || "",
        "Customer Contact": callData.contact_number || callData.phone || callData.customer_contact || "",
        "Customer Email": callData.customer_email || callData.email || "",
        "Product Id": callData.product_id || "",
        "Product Name": shortProdName,
        "Product Slug": productSlug,
        "Product Detail Page": productSlug ? `${mainsiteUrl}/detail/${productSlug}` : "",
        "Brand Id": callData.brand_id || callData.Brand?.brand_id || "",
        "Brand Name": callData.brand_name || callData.Brand?.brand_name || "",
        "Brand Slug": callData.brand_slug || callData.Brand?.slug || "",
        "Category Id": callData.category_id || callData.Category?.category_id || "",
        "Category Name": callData.category_name || callData.Category?.category_name || "",
        "Category Slug": callData.category_slug || callData.Category?.slug || "",
        "Lead Model Type": callData.lead_model_type || "",
        "Vendor Login Link": vendorLoginLink,
        "Vendor Login Slug": vendorLoginSlug,
      };

      return await providerService.trackEsellerEvent(resolved.profileId, eventName, attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process scheduleCallEvent:", error);
    }
  }

  /**
   * Fires Show Contact OEM Event
   * @param {object} user - VendorAuth / decoded token object / req.user
   * @param {object} leadData - Lead & product info object
   */
  async oemShowContact(user, leadData = {}) {
    try {
      if (!user) return;
      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .substring(0, 19);

      const mainsiteUrl = (process.env.MAINSITE_URL).replace(/\/$/, "");

      const oemAutologinData = {
        profile_id: resolved.profileId,
        vendor_id: resolved.vendorId,
        email: resolved.email,
        action: { name: "acd", params: {} },
        redirect_uri: `${mainsiteUrl}/my_demos`,
        expiration_date: expirationDate,
      };
    
      const encodedData = encodeData(oemAutologinData);
      const longUrl = `${mainsiteUrl}/login/autoLogin/${encodedData}`;
      const vendorLoginLink = await getShortUrl(longUrl);
      const vendorLoginSlug = vendorLoginLink.replace("https://tj.link/", "");

      const productName = leadData.product_name || "";
      const shortProdName = productName.length > 30 ? productName.substring(0, 27) + ".." : productName;

      const attributes = {
        "Lead Id": leadData.lead_id || leadData.id || "",
        "Customer Name": leadData.name || leadData.customer_name || "",
        "Customer Email": leadData.email || leadData.customer_email || "",
        "Customer Contact": leadData.phone || leadData.contact_number || "",
        "Product Id": leadData.product_id || "",
        "Product Name": shortProdName,
        "Product Slug": leadData.product_slug || leadData.slug || "",
        "Brand Id": leadData.brand_id || "",
        "Brand Name": leadData.brand_name || "",
        "Brand Slug": leadData.brand_slug || "",
        "Category Id": leadData.category_id || "",
        "Category Name": leadData.category_name || "",
        "Category Slug": leadData.category_slug || "",
        "Lead Model Type": leadData.lead_model_type || "",
        "Vendor Login Link": vendorLoginLink,
        "Vendor Login Slug": vendorLoginSlug,
      };

      return await providerService.trackEsellerEvent(resolved.profileId, "Show Contact OEM", attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process oemShowContact:", error);
    }
  }

  /**
   * Fires OEM Add Remarks Event
   * @param {object} user - VendorAuth / decoded token object / req.user
   * @param {object} data - Object containing lead_id and remark
   */
  async sendRemarkEvent(user, data = {}) {
    try {
      if (!user) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const leadInfo = await TblLeads.findOne({ where: { id: data.lead_id } });
      if (!leadInfo) return;

      let productInfo = null;
      if (leadInfo.product_id) {
        productInfo = await TblProduct.findOne({ where: { product_id: leadInfo.product_id } });
      }

      let brandInfo = null;
      if (leadInfo.brand_id) {
        brandInfo = await Brand.findOne({ where: { brand_id: leadInfo.brand_id } });
      }

      let categoryInfo = null;
      if (leadInfo.category_id) {
        categoryInfo = await Category.findOne({ where: { category_id: leadInfo.category_id } });
      }

      const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .substring(0, 19);

      const mainsiteUrl = (process.env.MAINSITE_URL).replace(/\/$/, "");

      const oemAutologinData = {
        profile_id: resolved.profileId,
        vendor_id: resolved.vendorId,
        email: resolved.email,
        action: { name: "acd", params: {} },
        redirect_uri: `${mainsiteUrl}/my_demos`,
        expiration_date: expirationDate,
      };

      const encodedData = encodeData(oemAutologinData);
      const longUrl = `${mainsiteUrl}/login/autoLogin/${encodedData}`;
      const vendorLoginLink = await getShortUrl(longUrl);
      const vendorLoginSlug = vendorLoginLink.replace("https://tj.link/", "");

      const productName = productInfo?.product_name || leadInfo.product_name || "";
      const shortProdName = productName.length > 30 ? productName.substring(0, 27) + ".." : productName;

      const attributes = {
        "Lead Id": leadInfo.id,
        "Acd UUID": leadInfo.acd_uuid || "",
        "Customer Name": leadInfo.name || "",
        "Customer Email": leadInfo.email || "",
        "Customer Contact": leadInfo.phone || "",
        "Customer Id": leadInfo.customer_id || "",
        "Product Id": leadInfo.product_id || "",
        "Product Name": shortProdName,
        "Product Slug": productInfo?.slug || "",
        "Brand Id": leadInfo.brand_id || "",
        "Brand Name": brandInfo?.brand_name || leadInfo.brand_name || "",
        "Brand Slug": brandInfo?.slug || "",
        "Category Id": leadInfo.category_id || "",
        "Category Name": categoryInfo?.category_name || leadInfo.software_category || "",
        "Category Slug": categoryInfo?.slug || "",
        "Date": Math.floor(Date.now() / 1000), // Unix timestamp in seconds
        "Lead Source": leadInfo.source || "",
        "Lead Type": leadInfo.lead_type || "",
        "Lead Status": leadInfo.status || "",
        "Remark": data.remark || "",
        "Lead Model Type": productInfo?.lead_model_type || leadInfo.lead_model_type || "",
        "Vendor Login Link": vendorLoginLink,
        "Vendor Login Slug": vendorLoginSlug,
      };

      return await providerService.trackEsellerEvent(resolved.profileId, "OEM Add Remarks", attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process sendRemarkEvent:", error);
    }
  }

  /**
   * Fires OEM Reminder Call Event
   * @param {object} user - VendorAuth / decoded token object / req.user
   * @param {object} postData - Object containing lead_id and optional vendor_id
   * @param {object} reminderData - Object returned from ACD schedule API
   */
  async sendReminderEvent(user, postData = {}, reminderData = {}) {
    try {
      if (!user) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const leadId = postData.lead_id || postData.id;
      const leadInfo = await TblLeads.findOne({ where: { id: leadId } });
      if (!leadInfo) return;

      const productId = reminderData?.product_id || leadInfo.product_id;
      let productInfo = null;
      if (productId) {
        productInfo = await TblProduct.findOne({ where: { product_id: productId } });
      }

      const brandId = leadInfo.brand_id || productInfo?.brand_id;
      let brandInfo = null;
      if (brandId) {
        brandInfo = await Brand.findOne({ where: { brand_id: brandId } });
      }

      const categoryId = leadInfo.category_id || productInfo?.category_id;
      let categoryInfo = null;
      if (categoryId) {
        categoryInfo = await Category.findOne({ where: { category_id: categoryId } });
      }

      const mainsiteUrl = (process.env.MAINSITE_URL || "https://www.techjockey.com").replace(/\/$/, "");

      const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .substring(0, 19);

      const oemAutologinData = {
        profile_id: resolved.profileId,
        vendor_id: resolved.vendorId,
        email: resolved.email,
        action: { name: "acd", params: {} },
        redirect_uri: `${mainsiteUrl}/my_demos`,
        expiration_date: expirationDate,
      };

      const encodedOemData = encodeData(oemAutologinData);
      const vendorLongUrl = `${mainsiteUrl}/login/autoLogin/${encodedOemData}`;
      const vendorLoginLink = await getShortUrl(vendorLongUrl);
      const vendorLoginSlug = vendorLoginLink.replace("https://tj.link/", "");

      // Customer autologin link
      const userCustomerId = reminderData?.user_id || leadInfo.customer_id || leadInfo.user_id;
      const userData = {
        customer_id: userCustomerId,
        email: reminderData?.email || leadInfo.email,
        action: { name: "my_demo", params: { type: "new" } },
        redirect_uri: `${mainsiteUrl}/account/my_calls`,
      };
      const encodedUserData = encodeData(userData);
      const customerLongUrl = `${mainsiteUrl}/account/autoLogin/${encodedUserData}`;
      const customerLoginLink = await getShortUrl(customerLongUrl);
      const customerLoginSlug = customerLoginLink.replace("https://tj.link/", "");

      const productName = productInfo?.product_name || leadInfo.product_name || "";
      const shortProdName = productName.length > 30 ? productName.substring(0, 27) + ".." : productName;

      const attributes = {
        "Lead Id": leadInfo.id,
        "Acd UUID": reminderData?.acd_uuid || leadInfo.acd_uuid || "",
        "Customer Name": reminderData?.name || leadInfo.name || "",
        "Customer Email": reminderData?.email || leadInfo.email || "",
        "Customer Contact": reminderData?.contact_number || reminderData?.phone || leadInfo.phone || "",
        "Product Id": productId || "",
        "Product Name": shortProdName,
        "Product Slug": productInfo?.slug || "",
        "Brand Id": brandInfo?.brand_id || leadInfo.brand_id || "",
        "Brand Name": brandInfo?.brand_name || leadInfo.brand_name || "",
        "Brand Slug": brandInfo?.slug || "",
        "Category Id": categoryInfo?.category_id || leadInfo.category_id || "",
        "Category Name": categoryInfo?.category_name || leadInfo.software_category || "",
        "Category Slug": categoryInfo?.slug || "",
        "Date": reminderData?.start_date || reminderData?.acd_start_date || (postData.reminder_date ? `${postData.reminder_date} ${postData.reminder_hour || '00'}:${postData.reminder_minute || '00'}:00` : ""),
        "Source": reminderData?.source || "eseller",
        "Lead Type": reminderData?.lead_type || leadInfo.lead_type || "",
        "Lead Status": leadInfo.status || "",
        "Lead Action": leadInfo.lead_action || "",
        "Lead Model Type": productInfo?.lead_model_type || leadInfo.lead_model_type || "",
        "Customer Login Link": customerLoginLink,
        "Customer Login Slug": customerLoginSlug,
        "Vendor Login Link": vendorLoginLink,
        "Vendor Login Slug": vendorLoginSlug,
      };

      return await providerService.trackEsellerEvent(resolved.profileId, "OEM Reminder call", attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process sendReminderEvent:", error);
    }
  }

  /**
   * Fires Lead Action Event
   * @param {object} user - VendorAuth / decoded token object / req.user
   * @param {object} data - Object containing lead_id
   */
  async sendLeadActionEvent(user, data = {}) {
    try {
      if (!user) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const leadId = data.lead_id || data.id;
      if (!leadId) return;

      const leadInfo = await TblLeads.findOne({ where: { id: leadId } });
      if (!leadInfo) return;

      let productInfo = null;
      if (leadInfo.product_id) {
        productInfo = await TblProduct.findOne({ where: { product_id: leadInfo.product_id } });
      }

      let brandInfo = null;
      if (leadInfo.brand_id) {
        brandInfo = await Brand.findOne({ where: { brand_id: leadInfo.brand_id } });
      }

      let categoryInfo = null;
      if (leadInfo.category_id) {
        categoryInfo = await Category.findOne({ where: { category_id: leadInfo.category_id } });
      }

      const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .substring(0, 19);

      const mainsiteUrl = (process.env.MAINSITE_URL).replace(/\/$/, "");

      const oemAutologinData = {
        profile_id: resolved.profileId,
        vendor_id: resolved.vendorId,
        email: resolved.email,
        action: { name: "acd", params: {} },
        redirect_uri: `${mainsiteUrl}/manage-leads/${leadId}`,
        expiration_date: expirationDate,
      };

      const encodedData = encodeData(oemAutologinData);
      const longUrl = `${mainsiteUrl}/login/autoLogin/${encodedData}`;
      const vendorLoginLink = await getShortUrl(longUrl);
      const vendorLoginSlug = vendorLoginLink.replace("https://tj.link/", "");

      const productName = productInfo?.product_name || leadInfo.product_name || "";
      const shortProdName = productName.length > 30 ? productName.substring(0, 27) + ".." : productName;

      const attributes = {
        "Lead Id": leadInfo.id,
        "Acd UUID": leadInfo.acd_uuid || "",
        "Customer Name": leadInfo.name || "",
        "Customer Email": leadInfo.email || "",
        "Customer Contact": leadInfo.phone || "",
        "Customer Id": leadInfo.customer_id || "",
        "Product Id": leadInfo.product_id || "",
        "Product Name": shortProdName,
        "Product Slug": productInfo?.slug || "",
        "Brand Id": leadInfo.brand_id || "",
        "Brand Name": brandInfo?.brand_name || leadInfo.brand_name || "",
        "Brand Slug": brandInfo?.slug || "",
        "Category Id": leadInfo.category_id || "",
        "Category Name": categoryInfo?.category_name || leadInfo.software_category || "",
        "Category Slug": categoryInfo?.slug || "",
        "Date": Math.floor(Date.now() / 1000),
        "Lead Source": leadInfo.source || "",
        "Lead Type": leadInfo.lead_type || "",
        "Lead Status": leadInfo.status || "",
        "Lead Action": leadInfo.lead_action || "",
        "Lead Model Type": productInfo?.lead_model_type || leadInfo.lead_model_type || "",
        "Vendor Login Link": vendorLoginLink,
        "Vendor Login Slug": vendorLoginSlug,
      };

      return await providerService.trackEsellerEvent(resolved.profileId, "Lead Action", attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process sendLeadActionEvent:", error);
    }
  }

  /**
   * Fires OEM Contact Us Event
   * @param {object} user - VendorAuth / decoded token object / req.user
   * @param {object} queryData - Object containing name, email, query
   */
  async oemContactUsEvent(user, queryData = {}) {
    try {
      if (!user) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const attributes = {
        "Source": "web",
        "Clicked": "Yes",
        "Name": queryData.name || resolved.firstName || "",
        "Email": queryData.email || resolved.email || "",
        "Query": queryData.query || "",
        "Time Stamp": Math.floor(Date.now() / 1000),
      };

      return await providerService.trackEsellerEvent(resolved.profileId, "OEM Contact Us", attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process oemContactUsEvent:", error);
    }
  }

  /**
   * Fires Review Reply Event
   * @param {object} user - VendorAuth / decoded token object / req.user
   * @param {object} data - Object containing reply details
   */
  async sendReplyEvent(user, data = {}) {
    try {
      if (!user) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const resolved = await this._resolveVendorDetails(user);
      if (!resolved || !resolved.profileId) return;

      const attributes = {
        "Vendor Profile Name": resolved.profileName || "",
        "Customer Name": data.customer_name || "",
        "Review Title": data.review_title || "",
        "Reply Text": data.reply_text || "",
        "Review Status": data.review_status || "Pending",
        "Review Action": data.review_action || "New",
      };

      return await providerService.trackEsellerEvent(resolved.profileId, "Review Reply", attributes);
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process sendReplyEvent:", error);
    }
  }

  /**
   * Fires Product/Brand updation transition events
   * @param {object} moengageData - Contains profile_ids (array), event_name (string), data (attributes object)
   */
  async sendProductBrandUpdationEvents(moengageData) { 
    try {
      if (!moengageData || !moengageData.profile_ids || moengageData.profile_ids.length === 0) return;

      const providerService = this.providerService;
      if (!providerService) return;

      const makeQueue = [];
      for (const profileId of moengageData.profile_ids) {
        if (profileId) {
          makeQueue.push({
            customer_id: String(profileId),
            type: "event",
            actions: [
              {
                action: moengageData.event_name,
                attributes: moengageData.data ? Object.fromEntries(
                  Object.entries(moengageData.data).filter(([_, v]) => v !== null && v !== undefined && v !== '')
                ) : {},
                current_time: Math.floor(Date.now() / 1000)
              }
            ]
          });
        }
      }

      if (makeQueue.length > 0) {
        const payload = {
          type: "transition",
          elements: makeQueue
        };
        if (typeof providerService.trackEsellerTransition === 'function') {
          return await providerService.trackEsellerTransition(payload);
        }
      }
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process sendProductBrandUpdationEvents:", error);
    }
  }

  /**
   * Helper to resolve vendor profile IDs for transitions (e.g. current profile_id and admin profile_id)
   * @param {object} user - VendorAuth / req.user
   */
  async _resolveTransitionProfileIds(user) {
    if (!user) return [];

    const profileId = user.id || user.profile_id;
    const vendorId = user.vendor_id;

    if (!vendorId || !profileId) return [];

    try {
      const admin = await VendorAuth.findOne({
        where: {
          vendor_id: vendorId,
          is_admin: 1,
          id: { [Op.ne]: profileId }
        },
        attributes: ["id"]
      });

      const ids = [profileId];
      if (admin && admin.id) {
        ids.push(admin.id);
      }
      return ids;
    } catch (err) {
      console.error("[Engagement Event Error] Failed to resolve transition profile IDs:", err);
      return [profileId];
    }
  }

  /**
   * Track product updation transition event
   * @param {object} user - VendorAuth / decoded token object / req.user
   * @param {object} attributes - Changed or added attributes
   */
  async trackProductUpdationEvent(user, attributes = {}) {
    try {
      if (!user) return;

      const profileIds = await this._resolveTransitionProfileIds(user);
      if (profileIds.length === 0) return;

      await this.sendProductBrandUpdationEvents({
        profile_ids: profileIds,
        event_name: "Product Information Submitted",
        data: attributes
      });
    } catch (error) {
      console.error("[Engagement Event Error] Failed to process trackProductUpdationEvent:", error);
    }
  }

}

export default new EngagementEvent();
