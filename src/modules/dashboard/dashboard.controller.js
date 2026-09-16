import { oemTotalLeadsCountInfo } from "./dashboard.js";
import { dashboardStats } from "./dashboard.service.js";
//sniih eovehiv eaybevbe
import sequelize from "../../db/connection.js";
export const totalLeadsCountInfo = async (req, res) => {
  try {
    const vendor_id = req.user.vendor_id;

    const result = await oemTotalLeadsCountInfo({
      vendor_id,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("Error in oemTotalLeadsCountInfo:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

// complete profile overview with the manager data
export const getVendorOverview = async (req, res) => {
  try {
    const vendor_id = req.user.vendor_id;

    if (!vendor_id) {
      return res.status(400).json({ message: "vendor_id is required" });
    }

    // Get Manager Data
    const [managerData] = await sequelize.query(
      `
       SELECT 
    au.adminusers_name AS name,
    au.adminusers_email AS email,
    au.adminusers_image AS image,
    au.adminusers_phone AS phone
  FROM vendors v
  LEFT JOIN tbl_adminusers au ON au.adminusers_id = v.acc_manager_id
  WHERE v.id = :vendor_id
  `,
      {
        replacements: { vendor_id: Number(vendor_id) },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const manager_data = {
      manager_name: managerData?.name ?? "Varun Sharma",
      manager_email: managerData?.email ?? "varun.sharma@techjockey.com",
      manager_phone: managerData?.phon ?? "+91-08040265252",
      manager_img: managerData?.image ?? null,
    };

    // Get Profile Score
    const [scoreData] = await sequelize.query(
      `
      SELECT particular_score 
      FROM vendors 
      WHERE id = :vendor_id
      `,
      {
        replacements: { vendor_id: Number(vendor_id) },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const profileScore = scoreData?.particular_score
      ? Math.round(scoreData.particular_score)
      : 0;

    // Final merged response
    return res.status(200).json({
      manager_data,
      profile_score: profileScore,
    });
  } catch (error) {
    console.error("Error in vendor overview:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

//analytics data function

import { analyticsInfo } from "./analytics.js";

export const analyticsCount = async (req, res) => {
  try {
    const filter = {
      vendor_id: req.user.vendor_id, // fixed !!
      show_current_plan_data: req.query.show_current_plan_data || 0,
    };

    const result = await analyticsInfo(filter);
    return res.status(200).json(result);
  } catch (error) {
    console.error(" Error in analyticsCount:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

// *******************************************************************************
export const getDashboardStats = async (req, res) => {
  try {
    const filter = {
      vendor_id: req.user.vendor_id,
    };

    const result = await dashboardStats(filter);
    return res.status(200).json(result);
  } catch (error) {
    console.error(" Error in dashboardStats:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};
// ******************************************