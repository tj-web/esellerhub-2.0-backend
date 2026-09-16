import { Op } from "sequelize";
import VendorDetails from "../../models/vendorDetail.model.js";
import VendorAuth from "../../models/vendorAuth.model.js";
import Vendor from "../../models/vendor.model.js";
import VendorBrandRelation from "../../models/vendorBrandRelation.model.js";
import Brand from "../../models/brand.model.js";
import Product from "../../models/product.model.js";
import Designation from "../../models/designation.model.js";
import VendorLead from "../../models/vendorLead.model.js";
import Category from "../../models/category.model.js";
import ProductCategory from "../../models/productCategory.model.js";
import OperatingSystem from "../../models/operatingSystem.model.js";
import ProductSpecification from "../../models/productSpecification.model.js";
import ProductImage from "../../models/productImage.model.js";
import ProductScreenshot from "../../models/productScreenshot.model.js";
import Setting from "../../models/websiteSetting.model.js";
import { getVendorData } from "../companyInfo/companyInformation.service.js";
import { uploadFileToS3 } from "../../utilis/s3Uploader.js";
import engagementEvent from "../../helpers/engagementEvent.js";

// Ensure Associations
VendorBrandRelation.belongsTo(Brand, {
  foreignKey: "tbl_brand_id",
  targetKey: "brand_id",
});

ProductCategory.belongsTo(Category, {
  foreignKey: "category_id",
  targetKey: "category_id",
});

/**
 * Fetch first brand associated with vendor
 */
export const getFirstBrandInfo = async (vendor_id) => {
  const relation = await VendorBrandRelation.findOne({
    where: { vendor_id },
    attributes: ["id", "vendor_id", "tbl_brand_id", "status"],
    include: [
      {
        model: Brand,
        attributes: ["brand_name"],
        required: true,
      },
    ],
    order: [["id", "DESC"]],
    raw: true,
  });

  if (!relation) return null;

  return {
    id: relation.id,
    vendor_id: relation.vendor_id,
    brand_id: relation.tbl_brand_id,
    brand_name: relation["Brand.brand_name"] || "",
    status: relation.status,
  };
};

/**
 * Fetch complete first product details associated with vendor for Step 3
 */
export const getFirstProductInfo = async (vendor_id) => {
  const firstProduct = await Product.findOne({
    where: { added_by_id: vendor_id, added_by: "vendor", is_deleted: 0 },
    attributes: ["product_id", "product_name", "status"],
    order: [["product_id", "DESC"]],
    raw: true,
  });

  if (!firstProduct) return null;

  const productId = firstProduct.product_id;

  // 1. Fetch Specifications (comma-separated ID lists in DB -> Array of ID strings)
  const specification = await ProductSpecification.findOne({
    where: { product_id: productId },
    raw: true,
  });

  const deployment = specification?.deployment ? specification.deployment.split(",").filter(Boolean) : [];
  const operating_system = specification?.operating_system ? specification.operating_system.split(",").filter(Boolean) : [];
  const device = specification?.device ? specification.device.split(",").filter(Boolean) : [];
  const organization_type = specification?.organization_type ? specification.organization_type.split(",").filter(Boolean) : [];

  // Helper to extract clean filename (e.g. 22616_Screenshot.png) from potential full URL or relative path
  const extractFileName = (val) => {
    if (!val || typeof val !== "string") return "";
    if (val.includes("/")) {
      const parts = val.split("/");
      return parts[parts.length - 1];
    }
    return val;
  };

  const basePath = process.env.AWS_PATH;
  const formattedBasePath = basePath.endsWith("/") ? basePath : `${basePath}/`;

  // 2. Fetch Product Logo
  const productImage = await ProductImage.findOne({
    where: { product_id: productId, default: 1 },
    raw: true,
  });
  let product_logo = productImage?.image || "";
  if (product_logo) {
    if (!product_logo.startsWith("http")) {
      const cleanImg = extractFileName(product_logo);
      product_logo = `${formattedBasePath}web/assets/images/techjockey/products/${cleanImg}`;
    }
  }

  // 3. Fetch Primary Category
  const primaryCatRel = await ProductCategory.findOne({
    where: { product_id: productId, is_primary: 1 },
    include: [
      {
        model: Category,
        attributes: ["category_id", "category_name"],
        required: false,
      },
    ],
    raw: true,
  });

  const primary_category = primaryCatRel
    ? {
        category_id: primaryCatRel.category_id,
        category_name: primaryCatRel["Category.category_name"] || "",
      }
    : null;

  // 4. Fetch Screenshots / Gallery Data (limit 3)
  const raw_gallery = await ProductScreenshot.findAll({
    where: { product_id: productId, status: 1 },
    attributes: ["id", "product_id", "image", "status"],
    limit: 3,
    raw: true,
  });

  const gallery_data = raw_gallery.map((item) => {
    let imgUrl = item.image || "";
    if (imgUrl && !imgUrl.startsWith("http")) {
      const cleanImg = extractFileName(imgUrl);
      imgUrl = `${formattedBasePath}web/assets/images/techjockey/products/screenshots/${cleanImg}`;
    }
    return {
      ...item,
      image: imgUrl,
    };
  });

  return {
    product_id: firstProduct.product_id,
    product_name: firstProduct.product_name,
    status: firstProduct.status,
    product_logo,
    primary_category,
    gallery_data,
    deployment,
    operating_system,
    device,
    organization_type,
  };
};

/**
 * Search Main/Global Brands for dropdown selection in Partner Setup Step 2
 */
export const searchMainBrands = async (searchStr = "") => {
  const brands = await Brand.findAll({
    where: {
      status: 1,
      is_deleted: 0,
      ...(searchStr
        ? {
            brand_name: {
              [Op.like]: `%${searchStr}%`,
            },
          }
        : {}),
    },
    attributes: [
      ["brand_id", "id"],
      ["brand_name", "text"],
    ],
    limit: 100,
    raw: true,
  });

  return brands;
};

/**
 * Fetch initial Partner Setup data (Step 1 Company Info, Step 2 Brand Info & Step 3 Product Info statuses)
 */
export const getPartnerSetupData = async ({ profile_id, vendor_id }) => {
  // 1. Fetch vendor profile data (filtered to necessary setup fields)
  const rawVendData = await getVendorData({ profile_id });
  const vendData = rawVendData
    ? {
        first_name: rawVendData.first_name || "",
        last_name: rawVendData.last_name || "",
        email: rawVendData.email || "",
        phone: rawVendData.phone || "",
        company: rawVendData.company || "",
        is_contact_person: rawVendData.is_contact_person ?? 0,
        cont_prsn_name: rawVendData.cont_prsn_name || "",
        cont_prsn_email: rawVendData.cont_prsn_email || "",
        cont_prsn_phone: rawVendData.cont_prsn_phone || "",
        cont_prsn_desg: rawVendData.cont_prsn_desg || "",
        designation: rawVendData.designation || "",
      }
    : {};

  // 2. Fetch designations list for step 1 dropdown
  const arr_designation = await Designation.findAll({
    where: {
      status: 1,
      is_deleted: 0,
    },
    attributes: ["id", "designation"],
    raw: true,
  });

  // 3. Fetch first brand data for pre-filling step 2
  const brand_data = await getFirstBrandInfo(vendor_id);

  // 6. Fetch full first product info for pre-filling step 3
  const product_info = await getFirstProductInfo(vendor_id);

  // 7. Calculate status for onboarding steps
  const company_status = vendData.company && vendData.company.trim() !== "" ? "Completed" : "Pending";

  let brand_status = "Pending";
  if (brand_data && brand_data.brand_name) {
    if (brand_data.status === 1 || brand_data.status === 3) {
      brand_status = "Approved";
    } else if (brand_data.status === 2) {
      brand_status = "Declined";
    } else {
      brand_status = "Pending for Approval";
    }
  }

  let product_status = "Pending";
  if (product_info && product_info.product_name) {
    if (product_info.status === 1) {
      product_status = "Approved";
    } else if (product_info.status === 2) {
      product_status = "Declined";
    } else {
      product_status = "Pending for Approval";
    }
  }

  // 8. Fetch current vendor_mode
  const vendorRecord = await Vendor.findByPk(vendor_id, {
    attributes: ["vendor_mode"],
    raw: true,
  });
  const vendor_mode = vendorRecord?.vendor_mode ?? 0;

  return {
    vendData,
    arr_designation,
    brand_data: brand_data || {},
    product: product_info || {},
    company_status,
    brand_status,
    product_status,
    vendor_mode,
  };
};

/**
 * Save / Update Step 1 (Company Information) in partner-setup
 */
export const saveCompanySetup = async (vendor_id, data) => {
  const {
    company_name,
    is_cont_prsn,
    contact_prsn_name,
    contact_prsn_email,
    contact_prsn_phone,
    contact_prsn_desg,
    designation_id,
  } = data;

  const vendorDetailData = {
    company: company_name || "",
    is_contact_person: is_cont_prsn ? 1 : 0,
    cont_prsn_name: contact_prsn_name || "",
    cont_prsn_email: contact_prsn_email || "",
    cont_prsn_phone: contact_prsn_phone || "",
    cont_prsn_desg: contact_prsn_desg || "",
    designation: designation_id,
  };

  // Upsert or update vendor_details record
  const existingDetails = await VendorDetails.findOne({ where: { vendor_id } });
  if (existingDetails) {
    await VendorDetails.update(vendorDetailData, { where: { vendor_id } });
  } else {
    await VendorDetails.create({ vendor_id, ...vendorDetailData });
  }

  // Sync updated company name to vendors_leads if table record exists
  if (company_name && VendorLead) {
    try {
      await VendorLead.update(
        { company: company_name },
        { where: { vendor_id } }
      );
    } catch (e) {
      console.warn("Could not sync company name to vendors_leads:", e.message);
    }
  }

  return {
    status: true,
    message: "Company Information Updated Successfully...",
    step_status: "Completed",
  };
};

/**
 * Save / Update Step 2 (Brand Information) in partner-setup
 */
export const saveBrandSetup = async (vendor_id, data) => {
  const { brand_id, brand_name, is_company_name } = data;

  let effective_brand_name = brand_name ? String(brand_name).trim() : "";
  let effective_brand_id = brand_id !== undefined && brand_id !== null ? String(brand_id).trim() : "";

  // 1. Handle "Same as company name" checkbox (is_company_name)
  const isCompanyNameChecked = is_company_name === 1 || is_company_name === "1";

  if (isCompanyNameChecked) {
    const vendorDetail = await VendorDetails.findOne({
      where: { vendor_id },
      attributes: ["company"],
      raw: true,
    });

    if (vendorDetail && vendorDetail.company && vendorDetail.company.trim() !== "") {
      effective_brand_name = vendorDetail.company.trim();
      // Reset brand_id since user explicitly wants to use company name as a brand string
      effective_brand_id = "";
    }
  }

  // 2. If brand_id is empty, but brand_name itself is a numeric ID string (e.g. select2 option value)
  if (
    !effective_brand_id &&
    effective_brand_name &&
    !isNaN(effective_brand_name) &&
    Number.isInteger(Number(effective_brand_name))
  ) {
    effective_brand_id = effective_brand_name;
    effective_brand_name = "";
  }

  let return_id = null;

  // Case 1: Existing Brand ID is provided / selected from get-main-brand dropdown
  if (effective_brand_id) {
    const numericBrandId = parseInt(effective_brand_id, 10);
    const existingBrand = await Brand.findOne({
      where: { brand_id: numericBrandId, is_deleted: 0 },
    });

    if (existingBrand) {
      return_id = numericBrandId;

      // Check if vendor brand relation already exists
      const existingRelation = await VendorBrandRelation.findOne({
        where: { vendor_id, tbl_brand_id: numericBrandId },
      });

      if (!existingRelation) {
        await VendorBrandRelation.create({
          vendor_id,
          tbl_brand_id: numericBrandId,
          status: 0,
          is_requested: 1,
          created_at: new Date(),
        });
      }

      return {
        status: true,
        message: "Brand Information Saved Successfully...",
        return_id: return_id,
        step_status: "Pending for Approval",
      };
    }
  }

  // Case 2 & 3: Brand ID is empty (Vendor typed custom brand name or used company name)
  if (!effective_brand_name) {
    return {
      status: false,
      message: "Please select or enter Brand Name...",
    };
  }

  // Check if a global brand with this exact brand_name already exists in tbl_brand
  const existingGlobalBrand = await Brand.findOne({
    where: { brand_name: effective_brand_name, is_deleted: 0 },
  });

  if (existingGlobalBrand) {
    return_id = existingGlobalBrand.brand_id;

    const existingRelation = await VendorBrandRelation.findOne({
      where: { vendor_id, tbl_brand_id: return_id },
    });

    if (!existingRelation) {
      await VendorBrandRelation.create({
        vendor_id,
        tbl_brand_id: return_id,
        status: 0,
        is_requested: 1,
        created_at: new Date(),
      });
    }
  } else {
    // Check if this vendor has already added a custom brand previously
    const checkAddedBrand = await Brand.findOne({
      where: { added_by: "vendor", added_by_id: vendor_id },
      order: [["brand_id", "DESC"]],
    });

    if (checkAddedBrand) {
      // Update existing custom brand name
      await Brand.update(
        { brand_name: effective_brand_name, date_modified: new Date() },
        { where: { brand_id: checkAddedBrand.brand_id } }
      );
      return_id = checkAddedBrand.brand_id;
    } else {
      // Create new brand record in tbl_brand
      const defaultBrandCols = {
        image: "",
        image_name: "",
        banner: "",
        banner_name: "",
        description: "",
        slug: "",
        website_url: "",
        tags: "",
        page_title: "",
        page_heading: "",
        page_keyword: "",
        page_description: "",
        brand_onboarded: 0,
        part_agree_date: new Date(),
        vendor_sheet_rec: 0,
        oem_onboarded_by: "",
        tj_agree_by_oem: 0,
        oem_agree_by_tj: 0,
        agreement_attach: "",
        lead_locking: 0,
        lead_url: "",
        lead_username: "",
        lead_password: "",
        commission_type: 1,
        commission: 0,
        commission_comment: "",
        renewal_terms: 0.0,
        renewal_terms_comment: "",
        payment_terms: "",
        payment_terms_comment: "",
        remarks: "",
        vendor_sheet: "",
        onboard_last_updated: new Date(),
        oem_onboarded_date: new Date(),
        declined_by: 0,
      };

      const newBrand = await Brand.create({
        ...defaultBrandCols,
        brand_name: effective_brand_name,
        status: 0,
        added_by: "vendor",
        added_by_id: vendor_id,
        show_status: 0,
        date_added: new Date(),
      });

      return_id = newBrand.brand_id;

      await VendorBrandRelation.create({
        vendor_id,
        tbl_brand_id: return_id,
        status: 0,
        is_requested: 0,
        created_at: new Date(),
      });
    }
  }

  return {
    status: true,
    message: "Brand Information Saved Successfully...",
    return_id: return_id,
    step_status: "Pending for Approval",
  };
};

/**
 * Save / Update Step 3 (Product Information) in partner-setup
 */
export const saveProductSetup = async (vendor_id, data, files = []) => {
  const {
    product_id,
    product_name,
    product_brand_id,
    primary_category,
    organization_type,
    deployment,
    operating_system,
    device,
    old_product_logo,
    old_product_image1,
    old_product_image2,
    old_product_image3,
  } = data;

  const productData = {
    product_name: product_name ? String(product_name).trim() : "",
    product_type_id: 13,
    date_added: new Date(),
    added_by: "vendor",
    added_by_id: vendor_id,
    brand_id: product_brand_id ? parseInt(product_brand_id, 10) : 0,
    status: 0,
    is_deleted: 0,
    product_code: "TP01",
    similar_product: "",
    price: 10.2,
    special_price: 200,
    duration: 0,
    duration_mode: "",
    discount: 10.2,
    price_text: "varun",
    brochure: "",
    slug: "",
    search_keyword: "",
    page_title: "",
    meta_title: "",
    page_keyword: "",
    page_description: "",
    cano_url: "",
    featured_start_date: new Date(),
    featured_end_date: new Date(),
    downld_file_path: "",
    trial_duration: 0,
    trial_duration_in: "",
    trial_available: 0,
    free_downld_path: "",
    free_downld_available: 0,
    price_type: 1,
    commission_type: 1,
    commission: 4,
    tp_comment: "",
    discount_factor: 0,
    discount_value: 2,
    rebate: "",
    renewable_term: "",
    website_url: "",
    custom_search_order: 0,
    recommended: 22,
    manual_reviews: 1,
    show_in_peripherals: 0,
  };

  let targetProductId = product_id ? parseInt(product_id, 10) : null;
  const isNewProduct = !targetProductId;

  if (!targetProductId) {
    // Lookup MAX_SLUG_ID from tbl_website_settings
    const maxSlugSetting = await Setting.findOne({
      where: { var_name: "MAX_SLUG_ID" },
      raw: true,
    });

    const currentSlugId = maxSlugSetting ? parseInt(maxSlugSetting.setting_value, 10) || 0 : 0;
    const newSlugId = currentSlugId + 1;
    productData.slug_id = newSlugId;

    const newProd = await Product.create(productData);
    targetProductId = newProd.product_id;

    // Update MAX_SLUG_ID in tbl_website_settings
    if (maxSlugSetting) {
      await Setting.update(
        { setting_value: String(newSlugId) },
        { where: { var_name: "MAX_SLUG_ID" } }
      );
    } else {
      await Setting.create({
        var_name: "MAX_SLUG_ID",
        setting_value: String(newSlugId),
      });
    }

    // Save Primary Category
    if (primary_category) {
      const primaryCatId = parseInt(primary_category, 10);
      const catInfo = await Category.findByPk(primaryCatId, { raw: true });
      const parent_id = catInfo ? catInfo.parent_id : 0;

      await ProductCategory.create({
        product_id: targetProductId,
        parent_id: parent_id,
        category_id: primaryCatId,
        is_primary: 1,
        sort_order: 0,
      });
    }
  } else {
    // Update existing Product
    await Product.update(productData, { where: { product_id: targetProductId } });

    // Handle Category update
    const primaryCatIdPost = primary_category ? parseInt(primary_category, 10) : null;

    if (primaryCatIdPost) {
      const existingProductCategories = await ProductCategory.findAll({
        where: { product_id: targetProductId },
        raw: true,
      });
      
      let existPrimaryCatId = null;
      for (const pc of existingProductCategories) {
        if (pc.is_primary === 1) {
          existPrimaryCatId = pc.category_id;
        }
      }

      if (primaryCatIdPost !== existPrimaryCatId) {
        // Remove old primary category (and any other categories, since we only support primary now)
        await ProductCategory.destroy({
          where: { product_id: targetProductId }
        });

        const catInfo = await Category.findByPk(primaryCatIdPost, { raw: true });
        const parent_id = catInfo ? catInfo.parent_id : 0;

        await ProductCategory.create({
          product_id: targetProductId,
          parent_id: parent_id,
          category_id: primaryCatIdPost,
          is_primary: 1,
          sort_order: 0,
        });
      }
    }
  }

  // Specifications Handling
  const parseSpecArray = (input) => {
    if (!input) return "";
    if (Array.isArray(input)) return input.filter(Boolean).join(",");
    if (typeof input === "string") return input;
    return String(input);
  };

  const specificationSave = {
    organization_type: parseSpecArray(organization_type),
    deployment: parseSpecArray(deployment),
    operating_system: parseSpecArray(operating_system),
    device: parseSpecArray(device),
    created_at: new Date(),
  };

  const existingSpec = await ProductSpecification.findOne({
    where: { product_id: targetProductId },
  });

  if (!existingSpec) {
    await ProductSpecification.create({
      product_id: targetProductId,
      ...specificationSave,
      size: "",
      industries: "",
      business: "",
      customer_support: "",
      integrations: "",
      ai_features: "",
      technology: 0,
      third_party_integration: "",
      property_type: "",
      training: "",
      languages: "",
      compliance_regulation: "",
      hw_configuration: "",
      sw_configuration: "",
    });
  } else {
    await ProductSpecification.update(specificationSave, {
      where: { product_id: targetProductId },
    });
  }

  // Handle Files Uploads (product_logo, product_image1, product_image2, product_image3)
  let fileList = Array.isArray(files) ? files : [];
  if (!Array.isArray(files) && files && typeof files === "object") {
    fileList = Object.values(files).flat();
  }

  const logoFile = fileList.find((f) => f.fieldname === "product_logo");
  const img1File = fileList.find((f) => f.fieldname === "product_image1");
  const img2File = fileList.find((f) => f.fieldname === "product_image2");
  const img3File = fileList.find((f) => f.fieldname === "product_image3");

  // Helper to extract clean filename (e.g. 22616_Screenshot.png) from potential full URL or relative path
  const extractFileName = (val) => {
    if (!val || typeof val !== "string") return "";
    if (val.includes("/")) {
      const parts = val.split("/");
      return parts[parts.length - 1];
    }
    return val;
  };

  // Save / Update Product Logo in tbl_product_image
  let dbLogoFileName = extractFileName(old_product_logo);
  if (logoFile) {
    const sanitizedOriginalName = logoFile.originalname.replace(/[^a-zA-Z0-9._]+/g, "");
    const fileName = `${targetProductId}_${sanitizedOriginalName}`;
    const key = `web/assets/images/techjockey/products/${fileName}`;
    try {
      await uploadFileToS3({ ...logoFile, originalname: sanitizedOriginalName, key });
    } catch (e) {
      console.error("Error uploading logo to S3:", e.message);
    }
    dbLogoFileName = fileName;
  }

  if (dbLogoFileName) {
    const existingImg = await ProductImage.findOne({
      where: { product_id: targetProductId },
    });
    const imageTitleName = dbLogoFileName.replace(/^.*?_/, "").replace(/\.[^/.]+$/, "");
    if (!existingImg) {
      await ProductImage.create({
        product_id: targetProductId,
        image: dbLogoFileName,
        image_name: imageTitleName || dbLogoFileName,
        default: 1,
      });
    } else {
      await ProductImage.update(
        { image: dbLogoFileName, image_name: imageTitleName || dbLogoFileName, default: 1 },
        { where: { product_id: targetProductId } }
      );
    }
  }

  // Save / Update Screenshots in tbl_product_screenshot
  const processScreenshotSlot = async (fileObj, oldVal) => {
    if (fileObj) {
      const sanitizedOriginalName = fileObj.originalname.replace(/[^a-zA-Z0-9._]+/g, "");
      const fileName = `${targetProductId}_${sanitizedOriginalName}`;
      const key = `web/assets/images/techjockey/products/screenshots/${fileName}`;
      try {
        await uploadFileToS3({ ...fileObj, originalname: sanitizedOriginalName, key });
      } catch (e) {
        console.error("Error uploading screenshot to S3:", e.message);
      }
      return fileName;
    }
    return extractFileName(oldVal);
  };

  const slotFiles = [img1File, img2File, img3File];
  const oldSlotNames = [old_product_image1, old_product_image2, old_product_image3];

  const existingScreenshots = await ProductScreenshot.findAll({
    where: { product_id: targetProductId },
    order: [["id", "ASC"]],
  });

  for (let i = 0; i < 3; i++) {
    const dbScreenshotFileName = await processScreenshotSlot(slotFiles[i], oldSlotNames[i]);
    if (dbScreenshotFileName) {
      if (existingScreenshots[i]) {
        // Update existing record for same product_id at slot i
        await ProductScreenshot.update(
          { image: dbScreenshotFileName, status: 1 },
          { where: { id: existingScreenshots[i].id } }
        );
      } else {
        // Create entry only if no record exists for slot i
        await ProductScreenshot.create({
          product_id: targetProductId,
          image: dbScreenshotFileName,
          status: 1,
          created_at: new Date(),
        });
      }
    }
  }

  if (isNewProduct) {
    try {
      const createdProduct = await Product.findByPk(targetProductId, { raw: true });
      let brandObj = null;
      if (createdProduct && createdProduct.brand_id) {
        brandObj = await Brand.findByPk(createdProduct.brand_id, { raw: true });
      }
      let categoryObj = null;
      const prodCat = await ProductCategory.findOne({
        where: { product_id: targetProductId, is_primary: 1 },
        raw: true,
      });
      if (prodCat && prodCat.category_id) {
        categoryObj = await Category.findByPk(prodCat.category_id, { raw: true });
      }

      const productInfoForEvent = {
        product_id: targetProductId,
        product_name: createdProduct?.product_name || "",
        product_slug: createdProduct?.slug || "",
        brand_id: brandObj?.brand_id || "",
        brand_name: brandObj?.brand_name || "",
        brand_slug: brandObj?.slug || "",
        category_id: categoryObj?.category_id || "",
        category_name: categoryObj?.category_name || "",
        category_slug: categoryObj?.slug || "",
      };

      engagementEvent.oemProfileCompleteStage1({ vendor_id }, productInfoForEvent).catch((err) => {
        console.error("[MoEngage Error] Failed to fire oemProfileCompleteStage1:", err);
      });
    } catch (evtErr) {
      console.error("[MoEngage Error] Error preparing oemProfileCompleteStage1:", evtErr.message);
    }
  }

  return {
    status: true,
    message: "Product Information Saved Successfully...",
    return_id: targetProductId,
    step_status: "Pending for Approval",
  };
};
