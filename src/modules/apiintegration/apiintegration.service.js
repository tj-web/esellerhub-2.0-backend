import axios from "axios";
import sequelize from "../../db/connection.js";
import { QueryTypes, fn, col, literal, Op } from "sequelize";
import VendorWebhookAuth from "../../models/vendorWebhookAuth.model.js";
import VendorsLeads from "../../models/vendorLead.model.js";
import VendorLeadsTeam from "../../models/vendorLeadsTeam.model.js";
import VendorAgentRemarkReminder from "../../models/vendorAgentRemarkReminder.model.js";
import VendorAuth from "../../models/vendorAuth.model.js";
import VendorDetails from "../../models/vendorDetail.model.js";
import VendorTeams from "../../models/vendorTeams.model.js";
import VendorUserTeam from "../../models/vendorUserTeam.model.js";
import { AppError } from "../../utilis/appError.js";
import { publishEmailToQueue } from "../../config/rabbitmq.producer.js";
import TblLeads from "../../models/leads.model.js";
import LeadStatus from "../../models/leadStatus.model.js";
import LeadHistory from "../../models/leadHistory.model.js";
import mongoose from "mongoose";
import engagementEvent from "../../helpers/engagementEvent.js";

// Define Associations needed for planSubscribeRequestService
VendorAuth.hasOne(VendorDetails, {
  foreignKey: "vendor_id",
  sourceKey: "vendor_id",
});

VendorsLeads.hasOne(VendorLeadsTeam, {
  foreignKey: "lead_id",
  sourceKey: "lead_id",
});

VendorUserTeam.belongsTo(VendorTeams, { foreignKey: "team_id" });
VendorUserTeam.hasMany(VendorLeadsTeam, { foreignKey: "adSales_AM", sourceKey: "user_id" });

const mapCredentialsToColumns = (auth_type, credentials = {}) => {
  switch (auth_type) {
    case "Basic Auth":
      return {
        client_id: credentials.username || "",
        client_secret: credentials.password || "",
        send_basic_auth: 1,
      };
    case "API Key":
      return {
        client_id: "api_key",
        client_secret: credentials.api_key || "",
        send_basic_auth: 0,
      };
    case "Bearer Token":
      return {
        client_id: "bearer",
        client_secret: credentials.bearer_token || "",
        send_basic_auth: 0,
      };
    case "OAuth 2.0":
      return {
        client_id: credentials.client_id || "",
        client_secret: credentials.client_secret || "",
        send_basic_auth: 0,
      };
    default:
      return { client_id: "", client_secret: "", send_basic_auth: 0 };
  }
};

const valiDateCredentials = (auth_type, credColumns) => {
  if (!credColumns.client_secret) {
    throw new Error("Authentication credentials are required");
  }
  if (auth_type === "Basic Auth" && !credColumns.client_id) {
    throw new Error("Username is required for Basic Auth");
  }
};

const VALID_API_PLAN_IDS = [46, 47, 48]; // Manually add valid plan IDs here

const checkIfVendorHasApiPlan = async (vendor_id) => {
  const query = `
    SELECT opd.lead_plan_id, tlp.deliverables
    FROM oms_pi_details opd
    INNER JOIN tbl_leads_plan tlp ON tlp.id = opd.lead_plan_id
    WHERE opd.vendor_id = :vendor_id AND opd.pi_status = 3
  `;

  const results = await sequelize.query(query, {
    replacements: { vendor_id },
    type: QueryTypes.SELECT,
  });

  // Check if any of the active plans are in the manual array or have 'api' in deliverables
  for (const row of results) {
    if (VALID_API_PLAN_IDS.includes(row.lead_plan_id)) {
      return true;
    }

    if (row.deliverables) {
      const deliverables = row.deliverables.toLowerCase();
      if (deliverables.includes("api integration") || deliverables.includes("api")) {
        return true;
      }
    }
  }

  return false;
};

export const handleCreateWebhook = async ({
  vendor_id,
  webhook_url,
  auth_type,
  credentials,
  fields,
}) => {
  if (!webhook_url || !auth_type) {
    throw new Error("webhook_url and auth_type are required");
  }
  let existing = await VendorWebhookAuth.findOne({ where: { vendor_id } });
  const credColumns = mapCredentialsToColumns(auth_type, credentials);
  if (existing && !credColumns.client_secret) {
    credColumns.client_secret = existing.client_secret;
  }

  valiDateCredentials(auth_type, credColumns);

  // 1. VERIFY WEBHOOK FIRST BEFORE SAVING
  const verifyResult = await handleverifyWebhook({
    vendor_id,
    webhook_url,
    auth_type,
    credentials,
    fields,
  });

  if (!verifyResult || !verifyResult.ok) {
    throw new Error(
      verifyResult?.message ||
      "Webhook verification failed. Please test your connection first."
    );
  }

  // 2. Check if vendor has a valid plan
  const isValidPlan = await checkIfVendorHasApiPlan(vendor_id);

  // 3. If vendor has NO valid plan, DO NOT insert into vendor_webhook_auth table!
  if (!isValidPlan) {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const recentOpportunity = await sequelize.query(`
      SELECT item_id 
      FROM vendor_agent_remark_reminder 
      WHERE value LIKE '%API Integration Request%' 
      AND created_at >= :twoDaysAgo 
      AND item_id IN (SELECT lead_id FROM vendors_leads WHERE vendor_id = :vendor_id)
      LIMIT 1
    `, {
      replacements: { twoDaysAgo, vendor_id },
      type: QueryTypes.SELECT
    });

    const already_requested = recentOpportunity.length > 0;

    return {
      webhook_url,
      auth_type,
      status: 0,
      already_requested,
      has_valid_plan: false,
    };
  }

  // 4. Vendor HAS a valid plan -> insert/update vendor_webhook_auth with status 1
  if (!existing) {
    existing = await VendorWebhookAuth.findOne({ where: { vendor_id } });
  }

  const payload = {
    vendor_id,
    ...credColumns,
    auth: auth_type,
    headers: JSON.stringify(["Content-Type: application/json"]),
    request_url: webhook_url,
    http_action: "POST",
    format: JSON.stringify(fields && typeof fields === "object" ? fields : {}),
    default_format: 1,
    status: 1,
  };

  let responseData;
  if (existing) {
    responseData = await existing.update(payload);
  } else {
    responseData = await VendorWebhookAuth.create(payload);
  }

  return {
    webhook_url: responseData.request_url,
    auth_type: responseData.auth,
    status: 1,
    already_requested: false,
    has_valid_plan: true,
  };
};

const buildAuthRequestConfig = (auth_type, credentials = {}) => {
  const headers = { "Content-Type": "application/json" };
  let auth;

  switch (auth_type) {
    case "Basic Auth":
      auth = {
        username: credentials.username || "",
        password: credentials.password || "",
      };
      break;
    case "API Key":
      headers["x-api-key"] = credentials.api_key || "";
      break;
    case "Bearer Token":
      headers["Authorization"] = `Bearer ${credentials.bearer_token || ""}`;
      break;
    case "OAuth 2.0":
      auth = {
        username: credentials.client_id || "",
        password: credentials.client_secret || "",
      };
      break;
    default:
      break;
  }

  return { headers, auth };
};

export const handleverifyWebhook = async ({ vendor_id, webhook_url, auth_type, credentials, fields }) => {
  if (!webhook_url) {
    throw new Error("webhook_url is required");
  }

  try {
    const creds = { ...credentials };
    if (vendor_id && (!creds.password && !creds.api_key && !creds.bearer_token && !creds.client_secret)) {
      const existing = await VendorWebhookAuth.findOne({ where: { vendor_id } });
      if (existing && existing.client_secret) {
        if (auth_type === "Basic Auth") creds.password = existing.client_secret;
        if (auth_type === "API Key") creds.api_key = existing.client_secret;
        if (auth_type === "Bearer Token") creds.bearer_token = existing.client_secret;
        if (auth_type === "OAuth 2.0") creds.client_secret = existing.client_secret;
      }
    }

    const { headers, auth } = buildAuthRequestConfig(auth_type, creds);

    const response = await axios.post(
      webhook_url,
      { event: "test_connection", fields: fields && typeof fields === "object" ? fields : {} },
      {
        timeout: 10000,
        validateStatus: () => true,
        headers,
        auth,
      }
    );

    const isOk = response.status >= 200 && response.status < 300;

    // Save the user data with status 0 on "Test Connection" only if successful
    if (isOk && auth_type && vendor_id) {
      const credColumns = mapCredentialsToColumns(auth_type, credentials);
      const payload = {
        vendor_id,
        ...credColumns,
        auth: auth_type,
        headers: JSON.stringify(["Content-Type: application/json"]),
        request_url: webhook_url,
        http_action: "POST",
        format: JSON.stringify(fields && typeof fields === "object" ? fields : {}),
        default_format: 1,
        status: 0,
      };

      // const existing = await VendorWebhookAuth.findOne({ where: { vendor_id } });
      // if (existing) {
      //   await existing.update(payload);
      // } else {
      //   await VendorWebhookAuth.create(payload);
      // }
    }

    return {
      ok: isOk,
      status_code: response.status,
      message: isOk
        ? "Webhook URL is reachable"
        : `Webhook URL responded with HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status_code: 0,
      message: "Webhook URL unreachable",
      error:
        error.code === "ECONNABORTED"
          ? "Request timed out"
          : error.code === "ENOTFOUND"
            ? "Could not resolve hostname"
            : error.code === "ECONNREFUSED"
              ? "Connection refused"
              : error.message,
    };
  }
};


export const planSubscribeRequestService = async (authData, postData) => {
  const transaction = await sequelize.transaction();
  try {
    const { profile_id, vendor_id } = authData;
    const { plan_name, reminder_date, hour, minute, message } = postData;

    // 0. Prevent duplicate requests within 2 days
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const recentOpportunity = await sequelize.query(`
      SELECT item_id 
      FROM vendor_agent_remark_reminder 
      WHERE value LIKE '%API Integration Request%' 
      AND created_at >= :twoDaysAgo 
      AND item_id IN (SELECT lead_id FROM vendors_leads WHERE vendor_id = :vendor_id)
      LIMIT 1
    `, {
      replacements: { twoDaysAgo, vendor_id },
      type: QueryTypes.SELECT
    });

    if (recentOpportunity.length > 0) {
      throw new AppError("You have already submitted a request recently. Our team will contact you soon.", 400);
    }

    // 1. Fetch Vendor Data via ORM
    const vendorData = await VendorAuth.findOne({
      where: { id: profile_id },
      include: [
        {
          model: VendorDetails,
          attributes: ["company"],
          where: { vendor_id: vendor_id },
          required: false,
        },
      ],
    });

    if (!vendorData) {
      throw new AppError("Vendor not found.", 404);
    }

    const reminder_datetime = `${reminder_date} ${hour}:${minute}:00`;
    const actual_plan_name = plan_name || "API Integration Request";

    let notes = `Vendor Remark:<br /> Plan name: ${actual_plan_name} <br /> Selected Date and Time by User: ${reminder_datetime} <br /> Message: ${message || ""} <br /> Note:this lead is been generated from the  e-seller panel.`;

    // 2. Determine Account Manager (adSales_AM)
    // First, check if a lead already exists for this vendor to reuse the AM organically
    const existingLead = await VendorsLeads.findOne({
      where: { vendor_id: vendor_id },
      include: [
        {
          model: VendorLeadsTeam,
          attributes: ["adSales_AM"],
          required: true,
        },
      ],
      order: [["lead_id", "DESC"]],
    });

    let manager_id_to_be_assigned = existingLead?.VendorLeadsTeam?.adSales_AM;

    if (!manager_id_to_be_assigned) {
      // Round Robin assignment from "Ad Sales" team via ORM aggregation
      const managers = await VendorUserTeam.findAll({
        attributes: ["user_id", [fn("COUNT", col("VendorLeadsTeams.id")), "total_leads"]],
        include: [
          {
            model: VendorTeams,
            where: { team_name: "Ad Sales" },
            attributes: [],
          },
          {
            model: VendorLeadsTeam,
            attributes: [],
            required: false, // LEFT JOIN to include managers with 0 leads
          },
        ],
        group: ["VendorUserTeam.user_id"],
        order: [[literal("total_leads"), "ASC"]],
        limit: 1,
        subQuery: false,
        raw: true,
      });

      if (managers.length > 0) {
        manager_id_to_be_assigned = managers[0].user_id;
      } else {
        manager_id_to_be_assigned = 0; // Fallback
      }
    }

    // 3. Insert New Lead in vendors_leads table via ORM
    const newLead = await VendorsLeads.create(
      {
        vendor_id: vendor_id,
        first_name: vendorData.first_name,
        last_name: vendorData.last_name,
        company: vendorData.VendorDetail?.company || "",
        email: vendorData.email,
        dial_code: vendorData.dial_code || "",
        phone: vendorData.phone || "",
        created_at: new Date(),
        creation_source: 4,
      },
      { transaction }
    );

    const lead_id = newLead.lead_id;

    // 4. Link Lead and Manager via ORM
    await VendorLeadsTeam.create(
      {
        lead_id: lead_id,
        adSales_AM: manager_id_to_be_assigned,
      },
      { transaction }
    );

    // 5. Insert Remark/Reminder via ORM mapping
    await VendorAgentRemarkReminder.create(
      {
        item_type: 3,
        item_id: lead_id,
        agent_id: manager_id_to_be_assigned,
        value: notes,
        type: 2,
        created_at: new Date(),
        reminder_time: reminder_datetime,
      },
      { transaction }
    );

    // 6. Queue Email Notification natively
    const emailBody = `
      <h3>New API Integration Plan Request</h3>
      <p><strong>Name:</strong> ${vendorData.first_name} ${vendorData.last_name}</p>
      <p><strong>Email:</strong> ${vendorData.email}</p>
      <p><strong>Contact:</strong> ${vendorData.phone}</p>
      <p><strong>Plan Name:</strong> ${actual_plan_name}</p>
      <p><strong>Message:</strong> ${message || ""}</p>
      <p><strong>Preferred Callback Time:</strong> ${reminder_date} ${hour}:${minute}</p>
    `;

    await transaction.commit();
    await publishEmailToQueue({
      rawHtml: emailBody,
      subject: "New Paid Plan Request - API Integration",
      emailType: "plan_subscribe_request",
      to: process.env.REQUEST_CALLBACK_TO_MANAGER_IDS || "support@techjockey.com",
      cc: process.env.REQUEST_CALLBACK_CC_MANAGER_IDS || "",
    });
    return {
      message: "API Integration Request Sent Successfully",
    };
  } catch (error) {
    if (transaction) await transaction.rollback();
    throw error;
  }
};

export const handleUpdateLeadAction = async (headers, body) => {
  const { vendor_id, lead_guid, lead_status_guid } = body;

  // 1. Validate all 3 fields are present and non-empty
  if (
    !vendor_id ||
    String(vendor_id).trim() === "" ||
    !lead_guid ||
    String(lead_guid).trim() === "" ||
    !lead_status_guid ||
    String(lead_status_guid).trim() === ""
  ) {
    throw new Error("vendor_id, lead_guid, and lead_status_guid are required");
  }

  // 2. Verify auth token
  const authHeader = headers.authorization || headers.Authorization;
  if (!authHeader) {
    throw new Error("Invalid Token.");
  }
  const tokenParts = authHeader.trim().split(/\s+/);
  const providedToken = tokenParts[tokenParts.length - 1];

  const authRecord = await VendorWebhookAuth.findOne({
    where: { vendor_id: vendor_id }
  });
  if (!authRecord) {
    throw new Error("Not Authorized.");
  }
  if (authRecord.status !== 1) {
    throw new Error("Webhook setup is not active. Please complete and activate your webhook integration first.");
  }

  const expectedToken = Buffer.from(authRecord.client_id + ":" + authRecord.client_secret).toString("base64");
  if (providedToken !== expectedToken) {
    throw new Error("Invalid Token.");
  }

  // 3. Fetch current lead
  const currentLead = await TblLeads.findOne({
    attributes: ["id", "customer_id", "name", "email", "lead_action", "acd_uuid", "vendor_id"],
    where: {
      lead_guid: lead_guid,
      vendor_id: vendor_id
    }
  });
  if (!currentLead) {
    throw new Error("Incorrect Lead ID");
  }

  // 4. Fetch new status
  const newStatus = await LeadStatus.findOne({
    attributes: ["id", "status_id", "lead_action_name", "status_name", "subaction_name"],
    where: {
      lead_status_guid: lead_status_guid
    }
  });
  if (!newStatus) {
    throw new Error("Incorrect Lead Status");
  }

  // 5. If new status id === current lead_action → throw "Trying to update existing Lead Action"
  if (Number(newStatus.id) === Number(currentLead.lead_action)) {
    throw new Error("Trying to update existing Lead Action");
  }

  let oldActionName = "";
  const transaction = await sequelize.transaction();
  try {
    // 6. Update tbl_leads
    await TblLeads.update(
      {
        lead_action: newStatus.id,
        status: newStatus.status_id,
        crm_status: newStatus.id
      },
      {
        where: { id: currentLead.id },
        transaction
      }
    );

    // 7. Fetch previous action name
    if (currentLead.lead_action) {
      const oldStatus = await LeadStatus.findOne({
        attributes: ["lead_action_name", "status_name", "subaction_name"],
        where: { id: currentLead.lead_action }
      });
      if (oldStatus) {
        oldActionName = oldStatus.subaction_name || oldStatus.lead_action_name || oldStatus.status_name || "";
      }
    }

    const newActionName = newStatus.subaction_name || newStatus.lead_action_name || newStatus.status_name || "";

    // 9. Insert into tbl_leads_history
    await LeadHistory.create(
      {
        lead_id: currentLead.id,
        acd_uuid: currentLead.acd_uuid || "",
        type: "action",
        remark: newActionName,
        source: "oem_api"
      },
      { transaction }
    );

    await transaction.commit();
  } catch (dbError) {
    await transaction.rollback();
    throw dbError;
  }

  const newActionNameResolved = newStatus.subaction_name || newStatus.lead_action_name || newStatus.status_name || "";

  // 10. Dump to MongoDB tracks collection
  try {
    let vendorName = "";
    let vendorEmail = "";
    try {
      const vendorAuth = await VendorAuth.findOne({
        attributes: ["first_name", "last_name", "email"],
        where: { vendor_id: vendor_id }
      });
      if (vendorAuth) {
        vendorName = `${vendorAuth.first_name || ""} ${vendorAuth.last_name || ""}`.trim();
        vendorEmail = vendorAuth.email || "";
      }
    } catch (vErr) {
      // Non-blocking
    }

    const db = mongoose.connection?.db;
    if (db) {
      await db.collection("tracks").insertOne({
        feeds: {
          app_source: "eseller",
          feed_action: "lead_status",
          feed_activity: "Lead Status Changed By OEM.",
          modified_by: {
            id: String(vendor_id || ""),
            name: vendorName,
            email: vendorEmail
          },
          lead_id: String(currentLead.id),
          customer_id: String(currentLead.customer_id || ""),
          customer_info: {
            customer_id: String(currentLead.customer_id || ""),
            customer_name: currentLead.name || "",
            customer_email: currentLead.email || ""
          },
          changes: [
            {
              fieldName: "lead_status",
              valueBefore: {
                id: String(currentLead.lead_action || 0),
                name: oldActionName || ""
              },
              valueAfter: {
                id: String(newStatus.id),
                name: newActionNameResolved
              }
            }
          ]
        },
        created_at: new Date().toISOString().replace("T", " ").slice(0, 19)
      });
    }
  } catch (mongoErr) {
    console.error("Error inserting to MongoDB tracks:", mongoErr);
  }

  // 11. Trigger MoEngage Lead Action engagement event 
  try {
    await engagementEvent.sendLeadActionEvent({ vendor_id }, { lead_id: currentLead.id });
  } catch (eventErr) {
    console.error("[Engagement Event Error] sendLeadActionEvent failed:", eventErr);
  }

  return true;
};

export const handleGetLeadActionConfig = async (vendor_id) => {
  const authRecord = await VendorWebhookAuth.findOne({
    where: { vendor_id: vendor_id },
  });

  if (!authRecord) {
    return {
      is_webhook_active: false,
      data: null,
    };
  }

  const isValidPlan = await checkIfVendorHasApiPlan(vendor_id);

  const data = authRecord.toJSON ? authRecord.toJSON() : { ...authRecord };
  if (data) {
    data.client_secret = "";
  }

  return {
    is_webhook_active: authRecord.status === 1 && isValidPlan,
    data,
  };
};

export const handleGetLeadStatusGuidReference = async () => {
  return LeadStatus.findAll({
    attributes: [
      "id",
      [col("status_name"), "parent_status"],
      [
        literal("CASE WHEN `subaction_name` IS NOT NULL THEN `subaction_name` ELSE `lead_action_name` END"),
        "sub_status",
      ],
      "lead_status_guid",
    ],
    where: {
      status_name: { [Op.ne]: "new" },
      source: { [Op.in]: [1, 2] },
      status: 1,
    },
    order: [["id", "ASC"]],
    raw: true,
  });
};

export const handleAddLeadRemark = async (headers, body) => {
  const { vendor_id, lead_guid, remark } = body;

  // 1. Validation & Edge Cases
  if (!vendor_id || String(vendor_id).trim() === "") {
    throw new Error("Vendor Id field is required.");
  }
  if (!lead_guid || String(lead_guid).trim() === "") {
    throw new Error("Lead GUID is required");
  }
  if (!remark || String(remark).trim() === "") {
    throw new Error("Lead remark required");
  }

  // Sanitize remark: Remove any carriage return (\r) characters
  const sanitizedRemark = String(remark).replace(/\r/g, "");

  // Length check: Validate remark length does not exceed 200 characters
  if (sanitizedRemark.length > 200) {
    throw new Error("Remark must be upto 200 characters only.");
  }

  // 2. Authentication & Authorization
  const authHeader = headers.authorization || headers.Authorization;
  if (!authHeader) {
    throw new Error("Invalid Token.");
  }
  const tokenParts = authHeader.trim().split(/\s+/);
  const providedToken = tokenParts[tokenParts.length - 1];

  const authRecord = await VendorWebhookAuth.findOne({
    where: { vendor_id: vendor_id }
  });
  if (!authRecord) {
    throw new Error("Not Authorized.");
  }
  if (authRecord.status !== 1) {
    throw new Error("Webhook setup is not active. Please complete and activate your webhook integration first.");
  }

  const expectedToken = Buffer.from(`${authRecord.client_id}:${authRecord.client_secret}`).toString("base64");
  if (providedToken !== expectedToken) {
    throw new Error("Invalid Token.");
  }

  // 3. Query tbl_leads
  const currentLead = await TblLeads.findOne({
    attributes: ["id", "acd_uuid"],
    where: {
      lead_guid: lead_guid,
      vendor_id: vendor_id
    }
  });
  if (!currentLead) {
    throw new Error("Incorrect Lead ID");
  }

  // 4. Insert into tbl_leads_history
  await LeadHistory.create({
    lead_id: currentLead.id,
    acd_uuid: currentLead.acd_uuid || "",
    type: "remark",
    additional_info: null,
    remark: sanitizedRemark,
    source: "oem_api"
  });

  // 5. Trigger MoEngage OEM Add Remarks engagement event 
  try {
    await engagementEvent.sendRemarkEvent({ vendor_id }, { lead_id: currentLead.id, remark: sanitizedRemark });
  } catch (eventErr) {
    console.error("[Engagement Event Error] sendRemarkEvent failed:", eventErr);
  }

  return true;
};




