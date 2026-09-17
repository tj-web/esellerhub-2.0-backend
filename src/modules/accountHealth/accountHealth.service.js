import sequelize from "../../db/connection.js";
import { Op, fn, col, literal, QueryTypes } from "sequelize";
import Vendors from "../../models/vendor.model.js";
import VendorParticularMatrix from "../../models/vendorParticularMatrix.model.js";
import VendorParticular from "../../models/vendorParticular.model.js";
import Review from "../../models/review.model.js";
import ReviewReplies from "../../models/reviewReplies.model.js";
import Product from "../../models/product.model.js";
import Brand from "../../models/brand.model.js";
import ProductImage from "../../models/productImage.model.js";
import VendorBrandRelation from "../../models/vendorBrandRelation.model.js";
import VendorsLeads from "../../models/vendorLead.model.js";
import VendorAnalytics from "../../models/vendorAnalytics.model.js";
import VendorDetail from "../../models/vendorDetail.model.js";
import VendorAuth from "../../models/vendorAuth.model.js";
import OmsPiDetail from "../../models/omsPiDetail.model.js";
import LeadsPlan from "../../models/leadsPlan.model.js";
import { AppError } from "../../utilis/appError.js";
import { renderTemplate } from "../../helpers/emailHelper.js";
import engagementEvent from "../../helpers/engagementEvent.js";
import { publishEmailToQueue } from "../../config/rabbitmq.producer.js";

// Define Associations
VendorParticularMatrix.belongsTo(VendorParticular, { foreignKey: "particular_id" });
VendorParticularMatrix.belongsTo(Brand, { foreignKey: "brand_id" });
VendorParticularMatrix.belongsTo(Product, { foreignKey: "product_id" });
Review.hasMany(ReviewReplies, { foreignKey: "review_id" });
ReviewReplies.belongsTo(VendorAuth, { foreignKey: "replied_by_profile_id" });
Review.belongsTo(Product, { foreignKey: "product_id" });
Product.hasMany(ProductImage, { foreignKey: "product_id" });
OmsPiDetail.belongsTo(LeadsPlan, { foreignKey: "lead_plan_id" });

/* =========================================
   HELPERS
========================================= */

const getVendorProductIds = async (vendor_id) => {
  const brandRelations = await VendorBrandRelation.findAll({
    where: {
      vendor_id,
      status: 1,
    },
    attributes: ["tbl_brand_id"],
  });

  const brandIds = brandRelations.map((r) => r.tbl_brand_id);
  if (brandIds.length === 0) return [];

  const products = await Product.findAll({
    where: {
      brand_id: { [Op.in]: brandIds },
      is_deleted: 0,
      status: 1,
      show_status: 1,
    },
    attributes: ["product_id"],
    order: [["product_id", "ASC"]],
  });

  return products.map((p) => p.product_id);
};

/* =========================================
   ACCOUNT HEALTH CORE SERVICES
========================================= */

export const handleGetHealthScore = async (vendor_id) => {
  try {
    const productIds = await getVendorProductIds(vendor_id);

    // 1. Profile Score from vendors table
    const vendor = await Vendors.findOne({
      where: { id: vendor_id },
      attributes: ["particular_score", "trusted_seller"],
    });

    if (!vendor) throw new AppError("Vendor not found", 404);

    const profile_score = Math.round(vendor.particular_score || 0);

    // 2. Incomplete Particulars
    const incompleteParticulars = await VendorParticularMatrix.findAll({
      where: {
        vendor_id,
        product_id: productIds.length > 0 ? productIds[0] : null,
        matrix_status: 0,
        status: 1,
      },
      include: [
        {
          model: VendorParticular,
          attributes: ["name"],
          required: true,
        },
      ],
    });

    // 3. Detailed Review Stats (Using avg_prod_rating_view via Raw Query)
    let summaryStats = {
      total_reviews: 0,
      avg_rating: 0,
      avg_ease_use_rating: 0,
      avg_value_money_rating: 0,
      avg_features_rating: 0,
      avg_support_rating: 0,
      avg_soft_recomm: 0,
    };

    if (productIds.length > 0) {
      const ratingAgg = await Review.findOne({
        where: { product_id: { [Op.in]: productIds }, status: 1, is_deleted: 0 },
        attributes: [
          [fn("COUNT", col("review_id")), "total"],
          [fn("AVG", col("rating")), "rating"],
          [fn("AVG", col("ease_use_rating")), "ease"],
          [fn("AVG", col("value_money_rating")), "value"],
          [fn("AVG", col("features_rating")), "features"],
          [fn("AVG", col("support_rating")), "support"],
          [fn("AVG", col("software_recomm")), "recomm"],
        ],
        raw: true,
      });

      const totalWeight = parseInt(ratingAgg?.total) || 0;
      if (totalWeight > 0) {
        summaryStats = {
          total_reviews: totalWeight,
          avg_rating: parseFloat(ratingAgg.rating) || 0,
          avg_ease_use_rating: parseFloat(ratingAgg.ease) || 0,
          avg_value_money_rating: parseFloat(ratingAgg.value) || 0,
          avg_features_rating: parseFloat(ratingAgg.features) || 0,
          avg_support_rating: parseFloat(ratingAgg.support) || 0,
          avg_soft_recomm: parseFloat(ratingAgg.recomm) || 0,
        };
      }
    }

    // 4. Response Time (Source: VendorAnalytics)
    const analytics = await VendorAnalytics.findOne({
      where: { vendor_id },
      attributes: [
        [fn("SUM", col("total_attempt_time")), "total_time"],
        [fn("SUM", col("total_attempt_lead")), "total_leads"],
      ],
      raw: true,
    });

    let avg_response_time = 0;
    if (analytics && analytics.total_leads > 0) {
      avg_response_time = Math.round(analytics.total_time / analytics.total_leads);
    } else {
      // Fallback to real-time calculation if analytics table is empty
      const realtime = await VendorsLeads.findAll({
        where: { vendor_id },
        attributes: [
          [
            fn(
              "AVG",
              literal(
                "TIMESTAMPDIFF(HOUR, VendorsLeads.created_at, (SELECT MIN(created_at) FROM vendor_agent_remark_reminder WHERE item_id = VendorsLeads.lead_id AND item_type = 3))"
              )
            ),
            "avg_response_time",
          ],
        ],
        raw: true,
      });
      avg_response_time = Math.round(realtime[0]?.avg_response_time || 0);
    }

    // 5. Price Availability
    const is_price_available =
      (await Product.count({
        where: {
          product_id: { [Op.in]: productIds },
          price_on_request: 1,
        },
      })) === 0
        ? 1
        : 0;

    // 6. Calculate Health Score (0-3)
    let health_score = 0;
    if (profile_score >= 75) health_score++;
    if (summaryStats.total_reviews >= 10) health_score++;
    if (vendor.trusted_seller === 1) health_score++;

    return {
      profile_score,
      health_score,
      total_reviews: summaryStats.total_reviews,
      average_rating: parseFloat(summaryStats.avg_rating.toFixed(1)),
      sub_ratings: {
        ease_of_use: parseFloat(summaryStats.avg_ease_use_rating.toFixed(1)),
        value_for_money: parseFloat(summaryStats.avg_value_money_rating.toFixed(1)),
        features: parseFloat(summaryStats.avg_features_rating.toFixed(1)),
        customer_support: parseFloat(summaryStats.avg_support_rating.toFixed(1)),
        software_recommendation: parseFloat(summaryStats.avg_soft_recomm.toFixed(1)),
      },
      primary_product_id: productIds.length > 0 ? productIds[0] : null,
      incomplete_particulars: incompleteParticulars.map((p) => p.VendorParticular?.name),
      is_price_available,
      avg_response_time,
      is_trusted_seller: vendor.trusted_seller,
    };
  } catch (error) {
    throw error;
  }
};

export const getReviewsData = async (vendor_id, query) => {
  try {
    const { page = 1, limit = 10, sort_by = "latest_first", productName, rating, date } = query;
    const productIds = await getVendorProductIds(vendor_id);

    if (productIds.length === 0) {
      return { reviews: [], total: 0, overall_stats: null };
    }

    const baseWhereClause = {
      product_id: { [Op.in]: productIds },
      status: 1,
      is_deleted: 0,
    };

    const listWhereClause = { ...baseWhereClause };

    // Apply Search Filters
    if (rating) {
      const ratingFloor = Math.floor(rating);
      listWhereClause[Op.and] = [
        literal(
          `(ROUND(Review.rating) = ${ratingFloor} OR (Review.rating >= ${ratingFloor} AND Review.rating < ${ratingFloor + 1}))`
        ),
      ];
    }

    if (date) {
      listWhereClause.created_at = {
        [Op.gte]: new Date(date),
        [Op.lt]: new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000),
      };
    }

    // 1. Fetch Overall Aggregates (Star Distribution + Sub-ratings)
    const starCounts = await Review.findAll({
      where: baseWhereClause,
      attributes: [
        [literal("ROUND(rating)"), "star"],
        [fn("COUNT", col("review_id")), "count"],
      ],
      group: [literal("ROUND(rating)")],
      raw: true,
    });

    const starDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    starCounts.forEach((s) => {
      const star = Math.round(s.star);
      if (star >= 1 && star <= 5) starDistribution[star] = parseInt(s.count);
    });

    // Sub-ratings average directly from Review rows
    const ratingAgg = await Review.findOne({
      where: baseWhereClause,
      attributes: [
        [fn("COUNT", col("review_id")), "total"],
        [fn("AVG", col("rating")), "rating"],
        [fn("AVG", col("ease_use_rating")), "ease"],
        [fn("AVG", col("value_money_rating")), "value"],
        [fn("AVG", col("features_rating")), "features"],
        [fn("AVG", col("support_rating")), "support"],
        [fn("AVG", col("software_recomm")), "recomm"],
      ],
      raw: true,
    });

    const tw = parseInt(ratingAgg?.total) || 0;
    let summary = { total: 0, rating: 0, ease: 0, value: 0, features: 0, support: 0, recomm: 0 };
    if (tw > 0) {
      summary = {
        total: tw,
        rating: parseFloat((parseFloat(ratingAgg.rating) || 0).toFixed(1)),
        ease: parseFloat((parseFloat(ratingAgg.ease) || 0).toFixed(1)),
        value: parseFloat((parseFloat(ratingAgg.value) || 0).toFixed(1)),
        features: parseFloat((parseFloat(ratingAgg.features) || 0).toFixed(1)),
        support: parseFloat((parseFloat(ratingAgg.support) || 0).toFixed(1)),
        recomm: parseFloat((parseFloat(ratingAgg.recomm) || 0).toFixed(1)),
      };
    }

    // 2. Fetch Additional Metadata (Company & Product List)
    const vendorDetail = await VendorDetail.findOne({
      where: { vendor_id },
      attributes: ["company"],
    });

    const productList = await Product.findAll({
      where: { product_id: { [Op.in]: productIds } },
      attributes: ["product_id", "product_name", "slug"],
    });

    // 3. Fetch Review List
    const orderMap = {
      latest_first: [["created_at", "DESC"]],
      oldest_first: [["created_at", "ASC"]],
      highest_rating: [["rating", "DESC"]],
      lowest_rating: [["rating", "ASC"]],
    };

    const { rows: reviews, count: total } = await Review.findAndCountAll({
      where: listWhereClause,
      include: [
        {
          model: ReviewReplies,
          where: { is_deleted: 0 },
          required: false,
          include: [
            {
              model: VendorAuth,
              attributes: [[literal("CONCAT(first_name, ' ', last_name)"), "profile_name"]],
              required: false,
            },
          ],
        },
        {
          model: Product,
          attributes: ["product_name", "slug"],
          where: productName ? { product_name: { [Op.like]: `%${productName}%` } } : undefined,
          required: !!productName,
          include: [
            {
              model: ProductImage,
              where: { default: 1 },
              attributes: ["image"],
              required: false,
            },
          ],
        },
      ],
      order: orderMap[sort_by] || orderMap.latest_first,
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit),
    });

    return {
      reviews,
      total,
      company: vendorDetail?.company || "",
      product_list: productList,
      overall_stats: {
        starDistribution,
        averages: summary,
      },
    };
  } catch (error) {
    throw error;
  }
};

export const handleGetProfileCompletion = async (vendor_id) => {
  try {
    // Dynamically define association if not already present globally
    if (!VendorBrandRelation.associations.Brand) {
      VendorBrandRelation.belongsTo(Brand, { foreignKey: "tbl_brand_id", targetKey: "brand_id" });
    }

    // 1. Fetch valid brands strictly matching PHP's get_brands_details logic
    const validBrandRelations = await VendorBrandRelation.findAll({
      where: {
        vendor_id: vendor_id,
        tbl_brand_id: { [Op.ne]: 0 },
        [Op.or]: [
          { status: 1 },
          {
            "$Brand.added_by$": "vendor",
            "$Brand.added_by_id$": vendor_id
          }
        ]
      },
      order: [
        ["id", "DESC"]
      ],
      include: [
        {
          model: Brand,
          attributes: ["brand_id", "brand_name", "image", "added_by", "added_by_id"],
          where: {
            status: 1,
            show_status: 1,
            is_deleted: 0,
          },
          required: true,
        }
      ]
    });

    const validBrandIds = validBrandRelations.map(vbr => vbr.tbl_brand_id);

    if (validBrandIds.length === 0) {
      return []; // Return early if no valid brands
    }

    const matrix = await VendorParticularMatrix.findAll({
      where: {
        vendor_id,
        status: 1,
        brand_id: { [Op.in]: validBrandIds }
      },
      order: [
        ["brand_id", "DESC"],
        ["particular_id", "ASC"],
      ],
      include: [
        {
          model: VendorParticular,
          attributes: ["name", "score"],
          required: true,
        },
        {
          model: Brand,
          attributes: ["brand_name", "image"],
          required: true, // INNER JOIN
        },
        {
          model: Product,
          attributes: ["product_name"],
          required: false, // LEFT JOIN
          include: [
            {
              model: ProductImage,
              attributes: ["image"],
              where: { default: 1 },
              required: false,
            },
          ],
        },
      ],
    });

    return { brands: validBrandRelations, matrix };
  } catch (error) {
    throw error;
  }
};

export const handleGetAccountStatus = async (vendor_id) => {
  try {
    const vendor = await Vendors.findOne({
      where: { id: vendor_id },
      attributes: ["is_temp", "vendor_mode"],
    });
    return vendor;
  } catch (error) {
    throw error;
  }
};

export const handleSaveReviewReply = async (vendor_id, profile_id, data) => {
  try {
    const { review_id, reply_text, reply_id } = data;

    // --- SECURITY FIX: Verify Review Ownership ---
    const targetReview = await Review.findOne({
      where: { review_id },
      attributes: ["product_id", "title", "name", "customer_id"],
    });

    if (!targetReview) {
      throw new AppError("Review not found", 404);
    }

    const vendorProductIds = await getVendorProductIds(vendor_id);

    if (!vendorProductIds.includes(targetReview.product_id)) {
      throw new AppError("You are not authorized to reply to this review", 403);
    }
    // ---------------------------------------------

    const replyData = {
      review_id,
      reply_text,
      replied_by: vendor_id,
      replied_by_profile_id: profile_id,
      source: "eseller_hub",
      status: 0, // Pending moderation
      is_deleted: 0,
      updated_at: new Date(),
    };

    let replyAction = 'New';
    let finalReplyId = reply_id;

    if (reply_id) {
      // Update existing reply
      await ReviewReplies.update(replyData, {
        where: { id: reply_id, replied_by: vendor_id },
      });
      replyAction = 'Updated';
    } else {
      // Create new reply
      replyData.created_at = new Date();
      const newReply = await ReviewReplies.create(replyData);
      finalReplyId = newReply.id;
    }

    // Trigger MoEngage Event
    engagementEvent.sendReplyEvent(
      { vendor_id, profile_id },
      {
        customer_name: targetReview.name,
        review_title: targetReview.title,
        reply_text: reply_text,
        review_status: "Pending",
        review_action: replyAction
      }
    );

    return { 
      status: true, 
      message: replyAction === 'Updated' ? "Reply updated successfully" : "Reply saved successfully", 
      reply_id: finalReplyId 
    };
  } catch (error) {
    throw error;
  }
};

export const handleGetTrustedSeller = async (vendor_id) => {
  try {
    const productIds = await getVendorProductIds(vendor_id);

    // 1. Fetch current status from vendor table
    const vendor = await Vendors.findOne({
      where: { id: vendor_id },
      attributes: ["trusted_seller", "show_current_plan_data"],
    });

    // 2. Reviews Data via avg_prod_rating_view Raw Query
    let summaryStats = { total_reviews: 0, avg_rating: 0 };
    if (productIds.length > 0) {
      const reviewsData = await sequelize.query(
        "SELECT total_reviews, rating_average FROM avg_prod_rating_view WHERE product_id IN (:productIds)",
        {
          replacements: { productIds },
          type: QueryTypes.SELECT,
        }
      );

      if (reviewsData.length > 0) {
        let totalWeight = 0;
        let weightedRating = 0;
        reviewsData.forEach((row) => {
          const count = parseInt(row.total_reviews) || 0;
          totalWeight += count;
          weightedRating += (parseFloat(row.rating_average) || 0) * count;
        });

        if (totalWeight > 0) {
          summaryStats = {
            total_reviews: totalWeight,
            avg_rating: weightedRating / totalWeight,
          };
        }
      }
    }

    // 3. Response Time (Source: VendorAnalytics + OMS PI Filtering)
    let whereAnalytics = { vendor_id };

    // Apply OMS PI Plan filtering if enabled
    if (vendor.show_current_plan_data === 1) {
      const activePlans = await OmsPiDetail.findAll({
        attributes: ["start_date", "end_date"],
        where: {
          vendor_id,
          pi_status: 3,
          start_date: { [Op.lte]: fn("CURDATE") },
          end_date: { [Op.gte]: fn("CURDATE") },
        },
        include: [
          {
            model: LeadsPlan,
            attributes: [],
            where: { plan_type: "credit" },
            required: true,
          },
        ],
        raw: true,
      });

      if (activePlans.length > 0) {
        const planConditions = activePlans
          .map((p) => `(logic_date BETWEEN '${p.start_date}' AND '${p.end_date}')`)
          .join(" OR ");
        whereAnalytics[Op.and] = [literal(`(${planConditions})`)];
      }
    }

    const analytics = await VendorAnalytics.findOne({
      where: whereAnalytics,
      attributes: [
        [fn("SUM", col("total_attempt_time")), "total_time"],
        [fn("SUM", col("total_attempt_lead")), "total_leads"],
      ],
      raw: true,
    });

    let avg_response_time = 0;
    if (analytics && analytics.total_leads > 0) {
      avg_response_time = Math.round(analytics.total_time / analytics.total_leads);
    } else {
      const realtime = await VendorsLeads.findAll({
        where: { vendor_id },
        attributes: [
          [
            fn(
              "AVG",
              literal(
                "TIMESTAMPDIFF(HOUR, VendorsLeads.created_at, (SELECT MIN(created_at) FROM vendor_agent_remark_reminder WHERE item_id = VendorsLeads.lead_id AND item_type = 3))"
              )
            ),
            "avg_response_time",
          ],
        ],
        raw: true,
      });
      avg_response_time = Math.round(realtime[0]?.avg_response_time || 0);
    }

    // 4. Price Availability
    const is_price_available =
      (await Product.count({
        where: {
          product_id: { [Op.in]: productIds },
          price_on_request: 1,
        },
      })) === 0
        ? 1
        : 0;

    return {
      is_trusted_seller: vendor?.trusted_seller || 0,
      avg_response_time,
      is_price_available,
      total_reviews: summaryStats.total_reviews,
      average_rating: parseFloat(summaryStats.avg_rating.toFixed(1)),
    };
  } catch (error) {
    throw error;
  }
};

export const handleSendReviewEmail = async (vendor_id, data) => {
  try {
    const { to_emails, product_name, product_slug, subject } = data;

    if (!to_emails || to_emails.length === 0) {
      throw new AppError("No recipient emails provided", 400);
    }

    // 1. Fetch vendor company name for personalization
    const vendorDetail = await VendorDetail.findOne({
      where: { vendor_id },
      attributes: ["company"],
    });

    const companyName = vendorDetail?.company || "Team Techjockey";

    const htmlBody = await renderTemplate(
      'send-review',
      {
        product_name,
        product_slug,
        companyName
      }
    );

    for (const email of to_emails) {
      try {
        await publishEmailToQueue({
          rawHtml: htmlBody,
          subject: subject || `Write a Review For ${product_name}`,
          emailType: "write_review",
          to: email.trim(),
        });
      } catch (error) {
        console.error(`Failed to publish review email to queue for ${email}:`, error);
      }
    }

    return { status: true, message: `Review requests queued for ${to_emails.length} recipients.` };
  } catch (error) {
    throw error;
  }
};
