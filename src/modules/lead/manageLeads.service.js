import { Op, QueryTypes } from "sequelize";
import mongoose from "mongoose";
import TblLeads from "../../models/leads.model.js";
import TblRequestCallbacks from "../../models/requestCallback.model.js";
import TblProduct from "../../models/product.model.js";
import LeadStatus from "../../models/leadStatus.model.js";
import LeadHistory from "../../models/leadHistory.model.js";
import VendorAuth from "../../models/vendorAuth.model.js";
import sequelize from "../../db/connection.js";
import { renderTemplate } from "../../helpers/emailHelper.js";
import { getDeterministicBuyerActivityTimeline } from "../../helpers/buyerActivityHelper.js";
import Setting from "../../models/websiteSetting.model.js";
import Vendor from "../../models/vendor.model.js";
import OmsPiDetail from "../../models/omsPiDetail.model.js";
import VendorLeadInsightInterest from "../../models/vendorLeadInsightInterest.model.js";
import OmsPiProduct from "../../models/omsPiProduct.model.js";
import VendorDetails from "../../models/vendorDetail.model.js";
import StateMaster from "../../models/stateMaster.model.js";
import CityMaster from "../../models/cityMaster.model.js";
import KnowlarityAcdStatus from "../../models/knowlarityAcdStatus.model.js";
import KnowlarityHistory from "../../models/knowlarityHistory.model.js";
import Companies from "../../models/companies.model.js";
import CompaniesEmployees from "../../models/companiesEmployees.model.js";
import LeadsCallAttempt from "../../models/leadsCallAttempt.model.js";
import VendorAnalytics from "../../models/vendorAnalytics.model.js";
import AdminUsers from "../../models/adminUser.model.js";
import VendorBrandRelation from "../../models/vendorBrandRelation.model.js";

import { AppError } from "../../utilis/appError.js";
import StatusCodes from "../../utilis/statusCodes.js";
import { publishEmailToQueue } from "../../config/rabbitmq.producer.js";
import engagementEvent from "../../helpers/engagementEvent.js";
import ProductAlternative from "../../models/productAlternative.model.js";

const ACD_START_TIME = "08:00 AM";
const ACD_END_TIME = "10:00 PM";
const CALL_CONN_MAX_DAYS = 45;
const CALL_MISS_MAX_DAYS = 10;
const eligiblePlanIds = [ 46, 47, 48, 51, 52];

// Reads IST wall-clock hour/minute directly via Intl, independent of the host process's own
// OS timezone (unlike `new Date(now.toLocaleString(..., {timeZone})))`, which re-parses the
// formatted string as host-local time and silently breaks on any server not itself set to IST).
const getIstHourAndMinute = (date = new Date()) => {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
    }).formatToParts(date);
    const hours = Number(parts.find((p) => p.type === "hour").value) % 24;
    const minutes = Number(parts.find((p) => p.type === "minute").value);
    return { hours, minutes };
};

const getWorkingHoursStatus = () => {
    const { hours, minutes } = getIstHourAndMinute();
    const timeValue = hours + minutes / 60;
    return timeValue >= 8 && timeValue <= 22;
};

const checkAnyConnected = async (lead_id) => {
    const connectedCall = await TblRequestCallbacks.findOne({
        where: { lead_id: lead_id, call_status: 2 }
    });
    return !!connectedCall;
};

// The shared DB (written by the legacy PHP app) stores naive datetimes as IST wall-clock
// values, but Sequelize's connection here uses its default "+00:00" timezone, so it reads
// those values back as if they were UTC — shifting the resulting Date +5:30 into the future.
// Rather than changing that global DB-wide default (which every other feature also relies on,
// however it currently behaves), correct just the fields this call-permission check uses.
const IST_MISREAD_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const toCorrectIstInstant = (value) => {
    const raw = new Date(value || new Date());
    return new Date(raw.getTime() - IST_MISREAD_OFFSET_MS);
};

const addDaysToDate = (dateStr, days) => {
    const d = new Date(dateStr || new Date());
    d.setDate(d.getDate() + days);
    return d;
};

const addWeekdaysToDate = (dateStr, days) => {
    let d = new Date(dateStr || new Date());
    let added = 0;
    while (added < days) {
        d.setDate(d.getDate() + 1);
        if (d.getDay() !== 0 && d.getDay() !== 6) {
            added++;
        }
    }
    return d;
};

/**
 * Calculates whether calling is allowed for a lead and the reason if not.
 */
export const calculateLeadCallPermissions = async (leadJson) => {
    const leadModelType = leadJson.product ? leadJson.product.lead_model_type : 2;
    let isCallAllowed = true;
    let callDisableMsg = "";

    if (leadModelType === 9) {
        isCallAllowed = true;
    } else if (leadJson.is_lead_cta === 0) {
        isCallAllowed = false;
        callDisableMsg = "Sorry! You do not have permission to view this content. Click on Upgrade Now to get access.";
    } else if (leadJson.acd_uuid) {
        const isWorkingHours = getWorkingHoursStatus();
        const currTime = new Date();
        const referenceDate = toCorrectIstInstant(leadJson.callback?.start_date || leadJson.created_at);

        if (leadJson.lead_type === 'DEMO') {
            const maxTime = addWeekdaysToDate(referenceDate, 10);
            if (currTime > maxTime && isWorkingHours) {
                callDisableMsg = `Your call back period of 10 days is over. Please contact support for more details.`;
                isCallAllowed = false;
            } else if (!isWorkingHours) {
                callDisableMsg = `Available from ${ACD_START_TIME} to ${ACD_END_TIME}`;
                isCallAllowed = false;
            }
        } else {
            const isAnyConnected = await checkAnyConnected(leadJson.id);
            if (isAnyConnected) {
                const maxTime = addDaysToDate(referenceDate, CALL_CONN_MAX_DAYS);
                if (currTime > maxTime && isWorkingHours) {
                    callDisableMsg = `Your call back period of ${CALL_CONN_MAX_DAYS} days is over. Please contact support for more details.`;
                    isCallAllowed = false;
                } else if (!isWorkingHours) {
                    callDisableMsg = `Available from ${ACD_START_TIME} to ${ACD_END_TIME}`;
                    isCallAllowed = false;
                }
            } else {
                const maxTime = addWeekdaysToDate(referenceDate, CALL_MISS_MAX_DAYS);
                const callTime = referenceDate;
                const callStatus = leadJson.callback ? leadJson.callback.call_status : null;

                if (currTime > maxTime && callStatus != 5 && isWorkingHours) {
                    callDisableMsg = `In future, kindly attempt to callback the potential customer in ${CALL_MISS_MAX_DAYS} days to keep this option active. Please contact support for more details.`;
                    isCallAllowed = false;
                } else if ((callStatus == 0 || callStatus == 5) && isWorkingHours && currTime < callTime) {
                    callDisableMsg = "Please wait to call back until the pre-scheduled time requested by customer";
                    isCallAllowed = false;
                } else if (!isWorkingHours) {
                    callDisableMsg = `Available from ${ACD_START_TIME} to ${ACD_END_TIME}`;
                    isCallAllowed = false;
                }
            }
        }
    }

    return {
        is_call_allowed: isCallAllowed ? 1 : 0,
        call_disable_msg: callDisableMsg
    };
};

/**
 * Retrieves vendor lead insight permissions and allowed products.
 */
const getVendorInsightPermission = async (vendor_id) => {
    const vendor = await Vendor.findByPk(vendor_id, {
        attributes: ['lead_insight_display']
    });

    // if (!vendor || vendor.lead_insight_display != 1) {
    //     return { allowed: false, productIds: [] };
    // }

    const currentDate = new Date().toISOString().split('T')[0];
    const activePlans = await OmsPiDetail.findAll({
        attributes: ['id', 'pi_status', 'end_date', 'lead_plan_id'],
        where: {
            vendor_id: vendor_id,
            pi_status: 3,
            lead_plan_id: { [Op.in]: eligiblePlanIds },
            [Op.or]: [
                { end_date: null },
                { end_date: { [Op.gte]: currentDate } }
            ]
        }
    });

    if (!activePlans || activePlans.length === 0) {
        return { allowed: false, productIds: [] };
    }

    const piIds = activePlans.map(p => p.id);

    const piProducts = await OmsPiProduct.findAll({
        attributes: ['product_id'],
        where: { pi_id: { [Op.in]: piIds } }
    });

    const productIds = piProducts.map(p => p.product_id);

    return {
        allowed: true,
        isFeatureEnabled: true,
        productIds: productIds
    };
};

TblLeads.hasOne(TblRequestCallbacks, {
    foreignKey: 'acd_uuid',
    sourceKey: 'acd_uuid',
    as: 'callback'
});

TblLeads.belongsTo(TblProduct, {
    foreignKey: 'product_id',
    as: 'product'
});

TblLeads.belongsTo(LeadStatus, {
    foreignKey: 'lead_action',
    as: 'leadStatus'
});

TblRequestCallbacks.belongsTo(TblLeads, {
    foreignKey: 'lead_id',
    as: 'lead'
});

/**
 * Helper to verify lead ownership
 */
const verifyLeadOwnership = async (vendor_id, lead_id) => {
    const lead = await TblLeads.findOne({
        where: { id: lead_id, vendor_id: vendor_id },
        attributes: ['id']
    });
    if (!lead) throw new AppError("Unauthorized: Lead does not belong to vendor", StatusCodes.FORBIDDEN);
    return lead;
};

/**
 * Helper to mask strings
 */
const maskString = (str, type = 'phone') => {
    if (!str) return "";
    if (type === 'email') {
        const [user, domain] = str.split('@');
        if (!domain) return "****";
        return user.length > 2
            ? `${user.substring(0, 2)}****@${domain}`
            : `****@${domain}`;
    }
    return str.length > 4
        ? "*******" + str.substring(str.length - 3)
        : "*******";
};

/**
 * Get count of pending leads for a vendor
 */
export const getPendingLeadsCount = async (vendor_id) => {
    try {
        const date48HoursAgo = new Date();
        date48HoursAgo.setHours(date48HoursAgo.getHours() - 48);
        // Adjust for IST (+5:30) because DB DATETIME is in IST and Sequelize sends as UTC
        date48HoursAgo.setMinutes(date48HoursAgo.getMinutes() + 330);

        const pendingCount = await TblLeads.count({
            where: {
                vendor_id: vendor_id,
                created_at: {
                    [Op.lte]: date48HoursAgo
                },
                lead_action: {
                    [Op.in]: [1, 2, 4]
                },
                phone: { [Op.ne]: '' },
                email: { [Op.ne]: '' },
                [Op.or]: [
                    { lead_visibility: 1 },
                    { lead_visibility: 0, is_trashed: 1 }
                ]
            }
        });

        return { pending_leads_count: pendingCount };
    } catch (error) {
        throw new AppError(error.message, StatusCodes.INTERNAL_SERVER_ERROR);
    }
};

/**
 * Get all leads for a vendor with filtering and pagination.
 */
export const getLeads = async (vendor_id, post) => {
    const filters = {
        order_by: post.order_by || 'id',
        order: post.order || 'DESC',
        date_from: post.date_from || "",
        date_to: post.date_to || "",
        status: post.lead_status !== undefined ? post.lead_status : "",
        srch_by: post.srch_by || '',
        srch_value: post.srch_value || '',
        hour_upto: post.hour_upto || '',
        action: post.lead_action || '',
        is_trashed: post.is_trashed || 0,
        limit: parseInt(post.limit) || 10,
        page: parseInt(post.page) || 0,
        srch_state: post.srch_state || '',
        srch_city: post.srch_city || ''
    };

    const offset = filters.page * filters.limit;

    const whereClause = {
        vendor_id: vendor_id,
        phone: { [Op.ne]: '' },
        email: { [Op.ne]: '' }
    };

    whereClause[Op.or] = [
        { lead_visibility: 1 },
        { [Op.and]: [{ lead_visibility: 0 }, { is_trashed: 1 }] }
    ];

    if (filters.status === 'action_required' || filters.status == -2) {
        filters.status = "";
        filters.hour_upto = '48';
        filters.action = [1, 2, 4];
        filters.date_to = new Date().toISOString().split('T')[0];
    }

    if (filters.status === '-3') {
        filters.status = "";
        whereClause.is_trashed = 1;
    }

    if (filters.status !== "" && filters.status !== undefined) {
        whereClause.status = filters.status;
    }

    if (filters.action !== "" && filters.action !== undefined) {
        whereClause.lead_action = filters.action;
    }

    if (filters.date_from) {
        whereClause.created_at = { [Op.gte]: new Date(filters.date_from) };
    }

    if (filters.date_to) {
        const toDate = new Date(filters.date_to);
        if (filters.date_to === new Date().toISOString().split('T')[0] && filters.hour_upto === '48') {
            const hourUpto = new Date(Date.now() - 48 * 60 * 60 * 1000);
            // Adjust for IST (+5:30)
            hourUpto.setMinutes(hourUpto.getMinutes() + 330);
            whereClause.created_at = { ...whereClause.created_at, [Op.lte]: hourUpto };
        } else {
            toDate.setHours(23, 59, 59, 999);
            whereClause.created_at = { ...whereClause.created_at, [Op.lte]: toDate };
        }
    }

    if (filters.srch_by && filters.srch_value) {
        if (filters.srch_by === 'all') {
            whereClause[Op.and] = [
                ...(whereClause[Op.and] || []),
                {
                    [Op.or]: [
                        { name: { [Op.like]: `%${filters.srch_value}%` } },
                        { product_name: { [Op.like]: `%${filters.srch_value}%` } }
                    ]
                }
            ];
        } else {
            if (filters.srch_by === 'phone' || filters.srch_by === 'email') {
                whereClause.is_contact_viewed = { [Op.gt]: 0 };
            }
            whereClause[filters.srch_by] = { [Op.like]: `%${filters.srch_value}%` };
        }
    }

    if (filters.is_trashed) {
        whereClause.is_trashed = filters.is_trashed;
    }

    if (filters.srch_state) {
        whereClause.state = filters.srch_state;
    }

    if (filters.srch_city) {
        whereClause.city = filters.srch_city;
    }

    const { count, rows } = await TblLeads.findAndCountAll({
        where: whereClause,
        include: [
            {
                model: TblRequestCallbacks,
                as: 'callback',
                attributes: ['call_status', 'recording_url', 'duration', 'requirement', 'start_date', 'company_industry', 'company_size', 'designation'],
                required: false
            },
            {
                model: TblProduct,
                as: 'product',
                attributes: ['slug', 'micro_transaction_model_price', 'lead_model_type'],
                required: false
            },
            {
                model: LeadStatus,
                as: 'leadStatus',
                attributes: ['status_name', 'lead_action_name', 'subaction_name'],
                required: false
            }
        ],
        order: [[filters.order_by, filters.order]],
        limit: filters.limit,
        offset: offset
    });

    const insightPermission = await getVendorInsightPermission(vendor_id);
    const has_recent_submission = await hasRecentSubmission(vendor_id);
    const currentDate = new Date().toISOString().split('T')[0];

    const enrichedLeads = await Promise.all(rows.map(async (lead) => {
        const leadJson = lead.toJSON();


        const isInternational = leadJson.dial_code !== '91';
        const contactViewed = leadJson.is_contact_viewed > 0;

        const showContact = (isInternational || leadJson.is_show_contact > 0);
        leadJson.is_show_contact = showContact ? 1 : 0;

        let isShowContactAllowed = true;
        let showContactDisableMsg = '';

        if (leadJson.is_show_contact === 0) {
            isShowContactAllowed = false;
            showContactDisableMsg = 'Sorry! You do not have permission to view this content. Click on Upgrade Now to get access.';
        }

        leadJson.is_show_contact_allowed = isShowContactAllowed;
        leadJson.show_contact_disable_msg = showContactDisableMsg;

        if (!contactViewed && !isInternational) {
            leadJson.email = maskString(leadJson.email, 'email');
            leadJson.phone = maskString(leadJson.phone, 'phone');
            leadJson.show_contact_phone = maskString(leadJson.phone, 'phone');
        } else {
            leadJson.show_contact_phone = leadJson.phone;
        }

        const latestRemark = await LeadHistory.findOne({
            where: { lead_id: lead.id, type: 'remark' },
            order: [['id', 'DESC']]
        });
        leadJson.remark = latestRemark ? latestRemark.remark : null;
        leadJson.remark_id = latestRemark ? latestRemark.id : null;

        const callAttemptData = await TblRequestCallbacks.findAll({
            attributes: [
                [sequelize.fn('SUM', sequelize.literal("CASE WHEN call_status = 2 THEN 1 ELSE 0 END")), 'connected'],
                [sequelize.fn('SUM', sequelize.literal("CASE WHEN call_status IN (0,1,3,4,5,6) THEN 1 ELSE 0 END")), 'customer_missed']
            ],
            where: { lead_id: lead.id }
        });

        const attempts = callAttemptData[0] ? callAttemptData[0].toJSON() : { connected: 0, customer_missed: 0 };
        leadJson.lead_call_attempt_count = parseInt(attempts.connected || 0) + parseInt(attempts.customer_missed || 0);

        const leadModelType = leadJson.product ? leadJson.product.lead_model_type : 2;
        leadJson.show_contact_cta = ([1, 3, 4, 7].includes(leadModelType) || isInternational) ? 1 : 0;
        leadJson.show_upgrade_cta = ([4, 7].includes(leadModelType)) ? 1 : 0;

        leadJson.lead_action_name = leadJson.leadStatus ? leadJson.leadStatus.lead_action_name : null;
        leadJson.lead_subaction_name = leadJson.leadStatus ? leadJson.leadStatus.subaction_name : null;
        leadJson.lead_status_name = leadJson.leadStatus ? leadJson.leadStatus.status_name : null;

        leadJson.lead_actions = await getLeadActions(leadJson);

        const callPerms = await calculateLeadCallPermissions(leadJson);
        leadJson.is_call_allowed = callPerms.is_call_allowed;
        leadJson.call_disable_msg = callPerms.call_disable_msg;

        let is_lead_insight_allowed = 0;
        if (insightPermission.allowed && leadJson.product_id) {
            const resultCount = await sequelize.query(`
                SELECT COUNT(1) as count 
                FROM oms_pi_details opd
                INNER JOIN oms_pi_products opp ON opd.id = opp.pi_id
                WHERE opd.vendor_id = :vendor_id 
                  AND opd.pi_status = 3 
                  AND opd.lead_plan_id IN (:eligiblePlanIds)
                  AND (opd.end_date IS NULL OR opd.end_date >= :currentDate)
                  AND opp.product_id = :product_id
            `, {
                replacements: { vendor_id, eligiblePlanIds, currentDate, product_id: leadJson.product_id },
                type: QueryTypes.SELECT
            });
            is_lead_insight_allowed = resultCount[0]?.count > 0 ? 1 : 0;
        }
        if (is_lead_insight_allowed === 0 && has_recent_submission) {
            is_lead_insight_allowed = 2;
        }
        leadJson.is_lead_insight_allowed = is_lead_insight_allowed;

        return leadJson;
    }));

    return {
        total_rows: count,
        leads: enrichedLeads,
        filters: filters
    };
};

/**
 * Get all demos for a vendor.
 */
export const getDemos = async (vendor_id, post, flg = '', acd_uuid = '') => {
    const filters = {
        order_by: post.order_by || 'id',
        order: post.order || 'DESC',
        search: post.search || "",
        date_from: post.date_from || "",
        date_to: post.date_to || "",
        status: post.lead_status || "",
        srch_by: post.srch_by || '',
        srch_value: post.srch_value || '',
        limit: parseInt(post.limit) || 10,
        page: parseInt(post.page) || 0
    };

    const offset = filters.page * filters.limit;

    const whereClause = {
        vendor_id: vendor_id
    };

    const callbackWhere = {
        action_performed: 'GetFreeDemo',
        acd_id: { [Op.ne]: '' }
    };

    if (acd_uuid) {
        callbackWhere.acd_uuid = acd_uuid;
    }

    if (flg === 'upcoming') {
        callbackWhere.call_status = 7;
    } else if (flg === 'new') {
        callbackWhere.call_status = { [Op.in]: [0, 5, 6] };
    }

    if (filters.date_from) {
        if (filters.date_to) {
            callbackWhere.start_date = { [Op.between]: [new Date(filters.date_from), new Date(filters.date_to)] };
        } else {
            callbackWhere.start_date = { [Op.gte]: new Date(filters.date_from) };
        }
    }

    if (filters.srch_by && filters.srch_value) {
        if (filters.srch_by === 'all') {
            whereClause[Op.and] = [
                ...(whereClause[Op.and] || []),
                {
                    [Op.or]: [
                        { name: { [Op.like]: `%${filters.srch_value}%` } },
                        { product_name: { [Op.like]: `%${filters.srch_value}%` } }
                    ]
                }
            ];
        } else {
            if (filters.srch_by === 'phone' || filters.srch_by === 'email') {
                whereClause.is_contact_viewed = { [Op.gt]: 0 };
            }
            whereClause[filters.srch_by] = { [Op.like]: `%${filters.srch_value}%` };
        }
    }

    const { count, rows } = await TblRequestCallbacks.findAndCountAll({
        where: callbackWhere,
        include: [
            {
                model: TblLeads,
                as: 'lead',
                where: whereClause,
                required: true,
                include: [
                    {
                        model: TblProduct,
                        as: 'product',
                        attributes: ['product_id', 'slug', 'lead_model_type'],
                        required: false
                    },
                    {
                        model: LeadStatus,
                        as: 'leadStatus',
                        attributes: ['status_name', 'lead_action_name', 'subaction_name'],
                        required: false
                    }
                ]
            }
        ],
        order: [[filters.order_by, filters.order]],
        limit: filters.limit,
        offset: offset
    });

    const insightPermission = await getVendorInsightPermission(vendor_id);
    const has_recent_submission = await hasRecentSubmission(vendor_id);
    const currentDate = new Date().toISOString().split('T')[0];

    const enrichedDemos = await Promise.all(rows.map(async (demo) => {
        const demoJson = demo.toJSON();
        const lead = demoJson.lead;

        const isInternational = lead.dial_code !== '91';
        const contactViewed = lead.is_contact_viewed > 0;
        const showContact = lead.is_show_contact > 0;

        if (!contactViewed && !isInternational) {
            lead.email = maskString(lead.email, 'email');
            lead.phone = maskString(lead.phone, 'phone');
            demoJson.show_contact_phone = maskString(lead.phone, 'phone');
        } else {
            demoJson.show_contact_phone = lead.phone;
        }

        const latestRemark = await LeadHistory.findOne({
            where: { lead_id: lead.id, type: 'remark' },
            order: [['id', 'DESC']]
        });
        demoJson.remark = latestRemark ? latestRemark.remark : null;
        demoJson.remark_id = latestRemark ? latestRemark.id : null;

        const leadModelType = lead.product ? lead.product.lead_model_type : 2;
        demoJson.show_contact_cta = ([1, 3, 4, 7].includes(leadModelType) || isInternational) ? 1 : 0;
        demoJson.show_upgrade_cta = ([4, 7].includes(leadModelType)) ? 1 : 0;

        let is_lead_insight_allowed = 0;
        const resolvedProductId = lead.product_id || (lead.product ? lead.product.product_id : null);
        if (insightPermission.allowed && resolvedProductId) {
            const resultCount = await sequelize.query(`
                SELECT COUNT(1) as count 
                FROM oms_pi_details opd
                INNER JOIN oms_pi_products opp ON opd.id = opp.pi_id
                WHERE opd.vendor_id = :vendor_id 
                  AND opd.pi_status = 3 
                  AND opd.lead_plan_id IN (:eligiblePlanIds)
                  AND (opd.end_date IS NULL OR opd.end_date >= :currentDate)
                  AND opp.product_id = :product_id
            `, {
                replacements: { vendor_id, eligiblePlanIds, currentDate, product_id: resolvedProductId },
                type: QueryTypes.SELECT
            });
            is_lead_insight_allowed = resultCount[0]?.count > 0 ? 1 : 0;
        }
        if (is_lead_insight_allowed === 0 && has_recent_submission) {
            is_lead_insight_allowed = 2;
        }
        demoJson.is_lead_insight_allowed = is_lead_insight_allowed;

        return demoJson;
    }));

    return {
        total_rows: count,
        demo_list: enrichedDemos,
        filters: filters
    };
};

/**
 * Get lead history for a specific vendor's lead.
 */
export const getLeadHistory = async (vendor_id, leadId) => {
    await verifyLeadOwnership(vendor_id, leadId);

    return await LeadHistory.findAll({
        where: {
            lead_id: leadId,
            [Op.or]: [
                { source: { [Op.ne]: 'crm' } },
                { source: null }
            ]
        },
        order: [['id', 'DESC']]
    });
};

/**
 * Helper to format date: 'l, j F, Y, g:i a'
 * e.g. "Thursday, 10 September, 2026, 2:30 pm"
 */
const formatReminderDate = (dateInput) => {
    try {
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return dateInput;

        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

        const dayName = days[d.getDay()];
        const dayOfMonth = d.getDate();
        const monthName = months[d.getMonth()];
        const year = d.getFullYear();

        let hours = d.getHours();
        const minutes = String(d.getMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'pm' : 'am';
        hours = hours % 12;
        hours = hours ? hours : 12;

        return `${dayName}, ${dayOfMonth} ${monthName}, ${year}, ${hours}:${minutes} ${ampm}`;
    } catch (e) {
        return dateInput;
    }
};

/**
 * Add remark or reminder (validation, ACD trigger, LeadHistory logging, MoEngage tracking).
 */
export const addRemarkReminder = async (user, data) => {
    const vendor_id = user?.vendor_id || data.vendor_id;
    const { lead_id, is_reminder_set, reminder_type } = data;

    // 1. Validation
    if (!lead_id) {
        throw new AppError("Lead Id is required", StatusCodes.BAD_REQUEST);
    }

    if (is_reminder_set === undefined || is_reminder_set === null || is_reminder_set === '') {
        throw new AppError("Is Reminder is required", StatusCodes.BAD_REQUEST);
    }

    let cleanRemark = data.remark !== undefined && data.remark !== null ? String(data.remark).replace(/\r/g, '') : '';
    if (cleanRemark.length > 200) {
        throw new AppError("Remark must be upto 200 characters only.", StatusCodes.BAD_REQUEST);
    }

    // 2. Lead Lookup & Ownership verification
    const lead = await TblLeads.findOne({
        where: { id: lead_id, vendor_id: vendor_id },
        attributes: [
            'id', 'user_id', 'customer_id', 'vendor_id', 'name', 'email', 'phone',
            'dial_code', 'product_id', 'acd_uuid', 'lead_type', 'status', 'lead_action',
            'software_category', 'product_name', 'brand_id', 'brand_name', 'category_id', 'company_id'
        ]
    });
    if (!lead) {
        throw new AppError("Unauthorized: Lead does not belong to vendor", StatusCodes.FORBIDDEN);
    }

    // 3. Branch: Setting a Reminder (is_reminder_set == 1)
    if (Number(is_reminder_set) === 1) {
        const reminder_date = data.reminder_date;
        if (!reminder_date) {
            throw new AppError("Reminder date is required", StatusCodes.BAD_REQUEST);
        }

        let hour = data.reminder_hour;
        let minute = data.reminder_minute;

        if (data.reminder_time) {
            let parsedTime = data.reminder_time;
            if (typeof parsedTime === 'string') {
                try {
                    parsedTime = JSON.parse(parsedTime);
                } catch (e) {
                    if (parsedTime.includes(':')) {
                        parsedTime = parsedTime.split(':');
                    }
                }
            }
            if (Array.isArray(parsedTime) && parsedTime.length >= 2) {
                hour = parsedTime[0];
                minute = parsedTime[1];
            }
        }

        if (hour === undefined || hour === null || hour === '' || minute === undefined || minute === null || minute === '') {
            throw new AppError("Reminder time required", StatusCodes.BAD_REQUEST);
        }

        const numMin = parseInt(minute, 10);
        const formattedMinute = numMin < 10 ? `0${numMin}` : `${numMin}`;
        const numHour = parseInt(hour, 10);
        const formattedHour = String(numHour);

        // Construct ACD Request payload
        const acdRequest = {
            user_id: lead.customer_id || lead.user_id,
            name: lead.name,
            email: lead.email,
            phone: lead.phone,
            dial_code: lead.dial_code || '91',
            product_id: lead.product_id,
            acd_uuid: lead.acd_uuid || '',
            lead_id: lead.id,
            source: (data.source === 'app' || data.source === 'eseller_app') ? 'eseller_app' : 'eseller',
            campaign: 'EsellerAddReminder',
            acd_start_date: reminder_date,
            acd_hour: formattedHour,
            acd_minute: formattedMinute,
            priority: 'agent'
        };

        const acdResponse = await triggerACD(acdRequest);

        if (acdResponse && acdResponse.status) {
            const finalRemark = cleanRemark.trim() !== ''
                ? cleanRemark
                : (reminder_type ? `${reminder_type} Reminder` : 'Added Reminder');

            const rawScheduled = acdResponse.message && !isNaN(new Date(acdResponse.message).getTime())
                ? acdResponse.message
                : `${reminder_date} ${formattedHour.padStart(2, '0')}:${formattedMinute}:00`;

            const scheduledDateObj = new Date(rawScheduled);
            const scheduledTime = !isNaN(scheduledDateObj.getTime())
                ? scheduledDateObj.toISOString().slice(0, 19).replace('T', ' ')
                : `${reminder_date} ${formattedHour.padStart(2, '0')}:${formattedMinute}:00`;

            // Insert into tbl_leads_history with NEW acd_uuid from dialer response
            await LeadHistory.create({
                lead_id: lead.id,
                acd_uuid: acdResponse.data?.acd_uuid || lead.acd_uuid || '',
                type: 'reminder',
                additional_info: reminder_type || null,
                remark: finalRemark,
                scheduled_time: scheduledTime,
                source: 'eseller'
            });

            // Dispatch engagement tracking event
            try {
                await engagementEvent.sendReminderEvent(
                    user,
                    { ...data, lead_id: lead.id, vendor_id },
                    acdResponse.data || {}
                );
            } catch (eventErr) {
                console.error("Engagement reminder event error:", eventErr);
            }

            const formattedDateMsg = formatReminderDate(rawScheduled);
            return {
                status: true,
                message: 'Hey, your Reminder is set for ' + formattedDateMsg
            };
        } else {
            return {
                status: false,
                message: acdResponse?.message || 'Failed to schedule reminder call'
            };
        }
    } else {
        // 4. Branch: Adding a Remark (is_reminder_set == 0)
        // Insert into tbl_leads_history with existing acd_uuid from tbl_leads
        await LeadHistory.create({
            lead_id: lead.id,
            acd_uuid: lead.acd_uuid || '',
            type: 'remark',
            additional_info: reminder_type || null,
            remark: cleanRemark,
            scheduled_time: null,
            source: 'eseller'
        });

        // Dispatch engagement tracking event
        try {
            await engagementEvent.sendRemarkEvent(user, { lead_id: lead.id, remark: cleanRemark, vendor_id });
        } catch (eventErr) {
            console.error("Engagement remark event error:", eventErr);
        }

        return {
            status: true,
            message: 'Remark added successfully.'
        };
    }
};

/**
 * Handler for lead status updates with ownership verification.
 */
export const leadStatusHandler = async (user, body) => {
    const vendor_id = user.vendor_id;
    const { lead_id, action, action_name } = body;

    if (!lead_id) throw new AppError('Lead Id is required', StatusCodes.BAD_REQUEST);
    await verifyLeadOwnership(vendor_id, lead_id);

    const response = await updateLeadStatusManual(
        user,
        { lead_id, action, action_name },
        'web'
    );

    if (response) {
        return { status: true, msg: 'Status updated successfully.' };
    } else {
        return { status: false, msg: 'Oops error occured try again.' };
    }
};

/**
 * Updates lead status manually.
 */
export const updateLeadStatusManual = async (user, data, source = 'web') => {
    if (!data.lead_id) return false;

    const previousLead = await TblLeads.findOne({
        attributes: ['is_contact_viewed', 'lead_action', 'status', 'acd_uuid'],
        where: { id: data.lead_id },
    });
    if (!previousLead) return false;
    const previousLeadData = previousLead.toJSON();

    const nextStatus = await LeadStatus.findOne({
        attributes: ['status_id'],
        where: { id: data.action },
    });
    if (!nextStatus) return false;
    const leadStatus = nextStatus.status_id;

    await TblLeads.update(
        {
            lead_action: data.action,
            status: leadStatus,
            crm_status: data.action,
        },
        { where: { id: data.lead_id } }
    );

    await LeadHistory.create({
        lead_id: data.lead_id,
        acd_uuid: previousLeadData.acd_uuid,
        type: 'action',
        remark: data.action_name || data.remark,
        source: 'eseller'
    });

    /* trigger lead action engagement event */
    try {
        await engagementEvent.sendLeadActionEvent(user, { lead_id: data.lead_id });
    } catch (eventErr) {
        console.error("Engagement event error:", eventErr);
    }

    return true;
};

/**
 * Get lead details.
 */
export const getLeadDetails = async (vendor_id, leadId) => {
    const lead = await TblLeads.findOne({
        where: {
            id: leadId,
            vendor_id: vendor_id,
            [Op.or]: [
                { lead_visibility: 1 },
                { [Op.and]: [{ lead_visibility: 0 }, { is_trashed: 1 }] }
            ]
        },
        include: [
            {
                model: TblRequestCallbacks,
                as: 'callback',
                required: false
            },
            {
                model: TblProduct,
                as: 'product',
                attributes: ['slug', 'micro_transaction_model_price', 'lead_model_type'],
                required: false
            },
            {
                model: LeadStatus,
                as: 'leadStatus',
                attributes: ['status_name', 'lead_action_name', 'subaction_name'],
                required: false
            }
        ]
    });

    if (!lead) return null;
    const leadJson = lead.toJSON();

    const isInternational = leadJson.dial_code !== '91';
    const contactViewed = leadJson.is_contact_viewed > 0;
    const showContact = (isInternational || leadJson.is_show_contact > 0);
    leadJson.is_show_contact = showContact ? 1 : 0;

    if (!contactViewed) {
        leadJson.email = maskString(leadJson.email, 'email');
    }

    if (isInternational || showContact || contactViewed) {
        leadJson.show_contact_phone = leadJson.phone;
    } else {
        leadJson.phone = maskString(leadJson.phone, 'phone');
        leadJson.show_contact_phone = maskString(leadJson.phone, 'phone');
    }

    const leadModelType = leadJson.product ? leadJson.product.lead_model_type : 2;
    leadJson.show_contact_cta = ([1, 3, 4, 7].includes(leadModelType) || isInternational) ? 1 : 0;
    leadJson.show_upgrade_cta = ([4, 7].includes(leadModelType)) ? 1 : 0;
    leadJson.is_international = isInternational ? '1' : '0';

    leadJson.lead_actions = await getLeadActions(leadJson);

    const insightPermission = await getVendorInsightPermission(vendor_id);
    const has_recent_submission = await hasRecentSubmission(vendor_id);
    const currentDate = new Date().toISOString().split('T')[0];
    let is_lead_insight_allowed = 0;
    if (insightPermission.allowed && leadJson.product_id && lead.lead_model_type === 1) {
        const resultCount = await sequelize.query(`
            SELECT COUNT(1) as count 
            FROM oms_pi_details opd
            INNER JOIN oms_pi_products opp ON opd.id = opp.pi_id
            WHERE opd.vendor_id = :vendor_id 
              AND opd.pi_status = 3 
              AND opd.lead_plan_id IN (:eligiblePlanIds)
              AND (opd.end_date IS NULL OR opd.end_date >= :currentDate)
              AND opp.product_id = :product_id
        `, {
            replacements: { vendor_id, eligiblePlanIds, currentDate, product_id: leadJson.product_id },
            type: QueryTypes.SELECT
        });
        is_lead_insight_allowed = resultCount[0]?.count > 0 ? 1 : 0;
    }
    if (is_lead_insight_allowed === 0 && has_recent_submission && lead.lead_model_type === 1) {
        is_lead_insight_allowed = 2;
    }

    const callPerms = await calculateLeadCallPermissions(leadJson);

    return {
        id: leadJson.id,
        name: leadJson.name || "",
        email: leadJson.email || "",
        phone: leadJson.phone || "",
        dial_code: leadJson.dial_code || "91",
        product_name: leadJson.product_name || "",
        user_intent: leadJson.user_intent || "",
        created_at: leadJson.created_at,
        city: leadJson.city || "",
        state: leadJson.state || "",
        keyword: leadJson.keyword || null,
        status: leadJson.status,
        lead_action: leadJson.lead_action,
        is_trashed: leadJson.is_trashed,
        is_contact_viewed: leadJson.is_contact_viewed,
        is_show_contact: leadJson.is_show_contact,
        show_contact_phone: leadJson.show_contact_phone,
        show_contact_cta: leadJson.show_contact_cta,
        show_upgrade_cta: leadJson.show_upgrade_cta,
        is_international: leadJson.is_international,
        is_lead_insight_allowed: is_lead_insight_allowed,
        is_call_allowed: callPerms.is_call_allowed,
        call_disable_msg: callPerms.call_disable_msg,
        lead_actions: leadJson.lead_actions,
        product: {
            slug: leadJson.product?.slug || null,
            lead_model_type: leadJson.product?.lead_model_type || 2,
            micro_transaction_model_price: leadJson.product?.micro_transaction_model_price || null
        }
    };
};

/**
 * Updates follow-up schedule for a lead with ownership verification.
 */
export const setFollowup = async (vendor_id, data) => {
    const { lead_id, followup_date, followup_hour, followup_minute, action_name, set_follow_up } = data;

    const lead = await verifyLeadOwnership(vendor_id, lead_id);

    if (set_follow_up === 'on') {
        const scheduledTime = `${followup_date} ${followup_hour}:${followup_minute}:00`;
        await LeadHistory.create({
            lead_id,
            acd_uuid: data.acd_uuid || lead.acd_uuid || '',
            type: 'reminder',
            remark: action_name || 'Updated Action',
            scheduled_time: scheduledTime,
            source: 'eseller'
        });
        return { status: true, message: 'Hey, your Reminder is set for ' + scheduledTime };
    } else {
        await LeadHistory.create({
            lead_id,
            acd_uuid: data.acd_uuid || lead.acd_uuid || '',
            type: 'action',
            remark: action_name,
            source: 'eseller'
        });
        return { status: true, message: 'Action added successfully.' };
    }
};

/**
 * Retrieves ACD history with ownership verification through acd_uuid.
 */
export const getLeadAcdHistory = async (vendor_id, acd_uuid, type) => {
    const lead = await TblLeads.findOne({
        where: { acd_uuid: acd_uuid, vendor_id: vendor_id },
        attributes: ['id']
    });
    if (!lead) throw new AppError("Unauthorized: ACD record does not belong to vendor", StatusCodes.FORBIDDEN);

    if (!TblRequestCallbacks.associations.acdStatus) {
        TblRequestCallbacks.belongsTo(KnowlarityAcdStatus, { foreignKey: 'call_status', targetKey: 'status_id', as: 'acdStatus' });
    }

    const records = await TblRequestCallbacks.findAll({
        where: {
            [Op.or]: [
                { acd_uuid: acd_uuid },
                { parent_acd_uuid: acd_uuid }
            ]
        },
        include: [{
            model: KnowlarityAcdStatus,
            as: 'acdStatus',
            required: true,
            where: {
                source: 2,
                [Op.and]: sequelize.literal("`acdStatus`.`type` = (CASE WHEN `TblRequestCallbacks`.`action_performed` = 'GetFreeDemo' THEN 2 ELSE 1 END)")
            },
            attributes: ['display_name']
        }],
        attributes: ['recording_url', 'call_status', 'last_updated'],
        order: [['start_date', 'ASC']]
    });

    return records.map(r => {
        const data = r.toJSON();
        return {
            recording_url: data.recording_url,
            call_status: data.call_status,
            display_name: data.acdStatus?.display_name,
            last_updated: data.last_updated
        };
    });
};

/**
 * Marks demo as accepted by vendor with ownership verification.
 */
export const acceptDemo = async (vendor_id, data) => {
    const { acd_uuid, lead_id } = data;

    await verifyLeadOwnership(vendor_id, lead_id);

    await TblRequestCallbacks.update(
        { call_status: 7, vendor_id: vendor_id },
        { where: { acd_uuid: acd_uuid, lead_id: lead_id } }
    );

    await KnowlarityHistory.create({
        acd_uuid: acd_uuid,
        type: 2,
        source: '2',
        status_id: 7,
        event_data: 'Accepted by vendor'
    });

    await LeadHistory.create({
        lead_id,
        acd_uuid,
        type: 'lead_action',
        remark: 'Demo Accepted',
        source: 'eseller'
    });

    return { success: true, msg: 'Great! Demo Confirmed Successfully.' };
};

/**
 * Reschedule demo with ownership verification.
 */
export const rescheduleDemo = async (vendor_id, data) => {
    const { acd_uuid, lead_id, option1, option2, option3 } = data;

    await verifyLeadOwnership(vendor_id, lead_id);

    const reschedule_time_options = JSON.stringify([option1, option2, option3]);

    await TblRequestCallbacks.update(
        { call_status: 5, reschedule_time_options },
        { where: { acd_uuid, lead_id } }
    );

    await LeadHistory.create({
        lead_id,
        acd_uuid,
        type: 'lead_action',
        remark: 'Demo Rescheduled',
        source: 'eseller'
    });

    return { success: true, msg: 'Demo Rescheduled Successfully' };
};

/**
 * Triggers ACD call via main site API
 */
async function triggerACD(data) {
    try {
        const mainsiteUrl = process.env.MAINSITE_URL || 'https://www.techjockey.com/';
        const authKey = data.source === 'eseller_app'
            ? 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJlc2VsbGVyaHViLmNvbSIsImF1ZCI6IkVzZWxsZXIgSHViIiwiaWF0IjoxNjExMDY1NTg1LCJuYmYiOjE2MTEwNjU1ODUsImV4cCI6MTY0MjYwMTU4NSwiZGF0YSI6eyJlbWFpbCI6Im1heWFua2R1cmdhcGFsMTdAZ21haWwuY29tIn19.20DQWUX7onNVSm-l3CVFQ5aF6VRmfaEK_CPofq8C0as'
            : 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJlc2VsbGVyaHViLmNvbSIsImF1ZCI6IkVzZWxsZXIgSHViIiwiaWF0IjoxNjExMTIyNTg2LCJuYmYiOjE2MTExMjI1ODYsImV4cCI6MTY0MjY1ODU4NiwiZGF0YSI6eyJlbWFpbCI6Im1heWFua2R1cmdhcGFsMTdAZ21haWwuY29tIn19.7G4AXMtzvk5QiOUTbyQkWH1nxWSsjcKkTUbcPYWZQjw';

        const response = await fetch(`${mainsiteUrl}schedule-acd`, {
            method: 'POST',
            headers: {
                'Authorization': authKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();
        return result;
    } catch (err) {
        return { status: false, message: err.message };
    }
}

/**
 * Schedules a callback or demo.
 */
export const scheduleCallback = async (user, data) => {
    const vendor_id = user.vendor_id;
    const { lead_id, date, hour, minute, action, agent_number } = data;

    const isWorkingHours = getWorkingHoursStatus();
    if (!isWorkingHours) {
        throw new AppError(`We are unable to process your request. Our working hours are from ${ACD_START_TIME} to ${ACD_END_TIME}`, StatusCodes.BAD_REQUEST);
    }

    const lead = await TblLeads.findOne({
        where: { id: lead_id, vendor_id: vendor_id },
        attributes: [
            'id', 'user_id', 'vendor_id', 'created_at', 'email', 'phone', 'dial_code',
            'product_id', 'acd_uuid', 'name', 'product_name', 'brand_id', 'brand_name',
            'category_id', 'software_category'
        ],
        include: [
            {
                model: TblRequestCallbacks,
                as: 'callback',
                required: false
            },
            {
                model: TblProduct,
                as: 'product',
                attributes: ['lead_model_type', 'slug'],
                required: false
            }
        ]
    });
    if (!lead) throw new AppError("Unauthorized: Lead does not belong to vendor", StatusCodes.FORBIDDEN);

    const callPerms = await calculateLeadCallPermissions(lead.toJSON());
    if (callPerms.is_call_allowed === 0) {
        throw new AppError(callPerms.call_disable_msg || "Call is not allowed for this lead", StatusCodes.BAD_REQUEST);
    }

    let scheduledTime;
    if (date && hour && minute) {
        scheduledTime = `${date} ${hour}:${minute}:00`;
    } else {
        const now = new Date();
        now.setMinutes(now.getMinutes() + 331);
        scheduledTime = now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0') + ' ' +
            String(now.getHours()).padStart(2, '0') + ':' +
            String(now.getMinutes()).padStart(2, '0') + ':00';
    }

    const acdRequest = {
        user_id: lead.customer_id || lead.user_id,
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        dial_code: lead.dial_code,
        product_id: lead.product_id,
        acd_uuid: lead.acd_uuid || '',
        lead_id: lead.id,
        source: 'eseller',
        campaign: action === 'GetFreeDemo' ? 'EsellerScheduleDemo' : (lead.acd_uuid ? 'EsellerAppCallback' : 'EsellerAppCall'),
        acd_start_date: scheduledTime.split(' ')[0],
        acd_hour: scheduledTime.split(' ')[1].split(':')[0],
        acd_minute: scheduledTime.split(' ')[1].split(':')[1],
        priority: 'agent',
        agent_number: agent_number || ''
    };

    const acdResponse = await triggerACD(acdRequest);

    if (acdResponse.status) {
        try {
            const callDataForEvent = {
                ...lead.toJSON(),
                acd_uuid: acdResponse?.data?.acd_uuid || lead.acd_uuid || '',
                category_name: lead.software_category,
                product_slug: lead.product?.slug
            };
            await engagementEvent.scheduleCallEvent(user, callDataForEvent);
        } catch (eventErr) {
            console.error("Engagement event error:", eventErr);
        }
    }

    if (action === 'GetFreeDemo') {
        await TblLeads.update(
            { status: 2, lead_action: 32, lead_shared: 1 },
            { where: { id: lead_id } }
        );
        await LeadHistory.create({
            lead_id,
            acd_uuid: acdResponse?.data?.acd_uuid || lead.acd_uuid || '',
            type: 'demo',
            remark: 'Demo Scheduled',
            scheduled_time: scheduledTime,
            source: 'eseller'
        });
    } else {
        await LeadHistory.create({
            lead_id,
            acd_uuid: acdResponse?.data?.acd_uuid || lead.acd_uuid || '',
            type: 'call',
            remark: lead.acd_uuid ? 'Callback Scheduled' : 'Call Scheduled',
            scheduled_time: scheduledTime,
            source: 'eseller'
        });
    }

    return {
        status: acdResponse.status,
        message: acdResponse.status ? (acdResponse.message || 'Callback scheduled successfully') : (acdResponse.message || 'Failed to trigger call')
    };
};

/**
 * Get lead locations (States/Cities) for search filters.
 */
export const getLeadLocations = async (search_by, context_id) => {
    try {
        if (search_by === "state") {
            return await StateMaster.findAll({
                where: {
                    countries_id: 99,
                    status: 1,
                },
                attributes: [
                    ["state_id", "id"],
                    ["state_name", "text"],
                ],
                order: [["state_name", "ASC"]],
                raw: true,
            });
        } else if (search_by === "city") {
            if (!context_id) return [];
            return await CityMaster.findAll({
                where: {
                    state_id: context_id,
                    status: 1,
                    is_deleted: 0
                },
                attributes: [
                    ["city_id", "id"],
                    ["city_name", "text"],
                ],
                order: [["city_name", "ASC"]],
                raw: true,
            });
        }
        return [];
    } catch (error) {
        throw error;
    }
};

/**
 * Retrieves vendor phone numbers.
 */
export const getVendorContacts = async (vendor_id) => {
    return await VendorAuth.findAll({
        attributes: [
            [sequelize.literal("CONCAT(first_name, ' ', last_name)"), 'contact_name'],
            ['phone', 'contact_number'],
            'dial_code',
            ['email', 'contact_email']
        ],
        where: { vendor_id, is_acd: 1 }
    });
};

/**
 * Orchestrates enrichment from Apollo.
 */
export const fetchLeadInsightsData = async (lead_id, vendor_id) => {
    const leadData = await TblLeads.findOne({
        attributes: ['id', 'email', 'company_id', 'category_id', 'lead_visibility'],
        where: { id: lead_id }
    });

    if (!leadData) return 0;
    const { email, company_id, category_id, lead_visibility } = leadData.toJSON();
    if (lead_visibility != 1) return 0;
    const domain = isBusinessEmail(email);
    let categoryEmployeeCount = 0;
    let employeeCount = 0;
    let companyExists = false;
    if (company_id) {
        employeeCount = await CompaniesEmployees.count({
            where: { company_id: company_id }
        });

        if (category_id) {
            categoryEmployeeCount = await CompaniesEmployees.count({
                where: {
                    company_id: company_id,
                    [Op.and]: sequelize.literal(`FIND_IN_SET('${category_id}', mapped_categories) > 0`)
                }
            });
        }

        companyExists = await Companies.count({
            where: { id: company_id }
        }) > 0;
    }

    if (!domain || (company_id && companyExists && (categoryEmployeeCount > 0 || employeeCount > 0))) {
        if (domain && company_id && companyExists && category_id && categoryEmployeeCount === 0) {
            const companyDetail = await Companies.findOne({
                attributes: ['id', 'domain', 'organization_id'],
                where: { id: company_id },
                raw: true
            });
            if (companyDetail) {
                const employeeList = await getEmployeeList(domain, category_id, lead_id, {
                    company_id: companyDetail.id,
                    organization_id: companyDetail.organization_id,
                    domain: companyDetail.domain
                });
                if (employeeList?.status === 1 && employeeList?.data?.apollo_people_ids?.length > 0) {
                    await getEmployeeEmails(employeeList.data.apollo_people_ids);
                }
            }
        }
        return { status: 1, message: "Company profile details found." };
    }

    let organization = null;
    const companyDetail = await Companies.findOne({
        attributes: ['id', 'domain', 'organization_id'],
        where: { domain: domain },
        raw: true
    });

    if (companyDetail) {
        organization = {
            status: 2,
            msg: `domain ${domain} already exists`,
            data: {
                company_id: companyDetail.id,
                organization_id: companyDetail.organization_id,
                domain: companyDetail.domain,
            }
        };
    } else {
        organization = await getOrganizationData(domain);
    }

    if (!organization || organization.status === 0) {
        return 0;
    }

    await TblLeads.update(
        { company_id: organization.data.company_id },
        { where: { id: lead_id } }
    );

    const employeeList = await getEmployeeList(domain, category_id, lead_id, organization.data);

    if (employeeList.status === 1 && employeeList.data.apollo_people_ids.length > 0) {
        await getEmployeeEmails(employeeList.data.apollo_people_ids);
    }

    return 1;
};

/**
 * Helper to check if email is business email.
 */
const isBusinessEmail = (email) => {
    if (!email) return null;
    const nonBusinessPattern = /@(gmail|hotmail|outlook|yahoo|rediffmail|gmil|gmial|gmal)\./i;
    if (nonBusinessPattern.test(email)) {
        return null;
    }
    const domainPattern = /@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;
    const matches = email.match(domainPattern);
    return matches ? matches[1] : null;
};

/**
 * Helper to map employee count to range.
 */
const getCompanySize = (value) => {
    const companySizes = [
        { min: 0, max: 10, range: "0-10" },
        { min: 11, max: 50, range: "11-50" },
        { min: 51, max: 200, range: "51-200" },
        { min: 201, max: 500, range: "201-500" },
        { min: 501, max: 1000, range: "501-1000" },
        { min: 1001, max: 5000, range: "1001-5000" },
        { min: 5001, max: 10000, range: "5001-10000" },
        { min: 10001, max: Number.MAX_SAFE_INTEGER, range: "10000+" }
    ];

    for (const size of companySizes) {
        if (value >= size.min && value <= size.max) {
            return size.range;
        }
    }
    return "Invalid size";
};

/**
 * Fetches organization data from Apollo.
 */
const getOrganizationData = async (domain) => {
    const apiKey = process.env.APOLLO_API_KEY;
    if (!apiKey || apiKey === 'YOUR_APOLLO_API_KEY_HERE') {
        return { status: 0, msg: "API Key missing" };
    }

    const APOLLO_API_URL = process.env.APOLLO_API_URL || "https://api.apollo.io/api/v1/";
    const url = `${APOLLO_API_URL}organizations/enrich?domain=${encodeURIComponent(domain)}`;

    try {
        const response = await fetch(url, {
            headers: {
                "Accept": "application/json",
                "Cache-Control": "no-cache",
                "Content-Type": "application/json",
                "x-api-key": apiKey
            }
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`HTTP Error: ${response.status} - ${errBody}`);
        }
        const data = await response.json();

        if (data.organization && data.organization.id) {
            const org = data.organization;
            const estimatedNumEmployees = org.estimated_num_employees || 0;
            const companySize = getCompanySize(estimatedNumEmployees);
            const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

            const newCompany = await Companies.create({
                organization_id: org.id,
                company: org.name || '',
                employees_size: companySize,
                industry: org.industry || '',
                website: org.website_url || '',
                domain: domain,
                company_linkedin_url: org.linkedin_url || '',
                facebook_url: org.facebook_url || '',
                twitter_url: org.twitter_url || '',
                company_street: org.street_address || '',
                company_city: org.city || '',
                company_state: org.state || '',
                company_country: org.country || '',
                company_postal_code: org.postal_code || '',
                company_address: org.raw_address || '',
                logo_url: org.logo_url || '',
                created_at: createdAt
            });
            const company_id = newCompany.id;

            return {
                status: 1,
                msg: "success",
                data: {
                    company_id,
                    organization_id: org.id,
                    domain
                }
            };
        } else {
            // Apollo Enrichment: Domain profile not found
        }
    } catch (error) {
        // Ignored
    }

    return { status: 0, msg: "organization not found", data: { domain } };
};

/**
 * Strips characters outside printable ASCII/Latin-1 (e.g. CJK, Cyrillic, emoji) from
 * Apollo-sourced text so it doesn't break on tbl_companies_employees' column charset.
 */
const sanitizeEmployeeText = (value) => {
    if (value === null || value === undefined) return value;
    return String(value).replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim() || null;
};

/**
 * Fetches employee list from Apollo.
 */
const getEmployeeList = async (domain, category_id, lead_id, companyDetails) => {
    const categoryParams = await getKeyData(category_id);
    const department = categoryParams?.search_keys || [];

    const empData = await employeeData(domain, department);
    const apolloPeopleIds = [];

    if (empData && empData.length > 0) {
        const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

        for (const employee of empData) {
            if (!employee.apollo_people_id) {
                continue;
            }

            apolloPeopleIds.push(employee.apollo_people_id);

            const existingEmployee = await CompaniesEmployees.findOne({
                attributes: ['id', 'company_id', 'emp_email', 'apollo_people_id', 'mapped_categories'],
                where: { apollo_people_id: employee.apollo_people_id },
                raw: true
            });

            if (existingEmployee) {
                const existingMapped = existingEmployee.mapped_categories || "";
                const mappedArray = existingMapped.split(',').map(s => s.trim()).filter(Boolean);
                let needsUpdate = false;
                let updatedMapped = existingMapped;

                if (!mappedArray.includes(String(category_id))) {
                    mappedArray.push(category_id);
                    updatedMapped = mappedArray.filter(Boolean).join(',');
                    needsUpdate = true;
                }

                const currentCompanyId = existingEmployee.company_id;
                const targetCompanyId = companyDetails.company_id;
                let finalCompanyId = currentCompanyId;

                if (targetCompanyId && currentCompanyId !== targetCompanyId) {
                    finalCompanyId = targetCompanyId;
                    needsUpdate = true;
                }

                if (needsUpdate) {
                    await CompaniesEmployees.update(
                        { mapped_categories: updatedMapped || null, company_id: finalCompanyId || null },
                        { where: { apollo_people_id: employee.apollo_people_id || null } }
                    );
                }
            } else {
                await CompaniesEmployees.create({
                    company_id: companyDetails.company_id || null,
                    emp_name: sanitizeEmployeeText(employee.emp_name) || "",
                    emp_email: employee?.emp_email || "",
                    linkedin_id: employee.linkedin_url || "",
                    twitter_id: employee.twitter_id || "",
                    photo: employee.photo || "",
                    designation: sanitizeEmployeeText(employee.designation) || "",
                    apollo_people_id: employee.apollo_people_id || "",
                    mapped_categories: category_id ? String(category_id) : null,
                    created_at: createdAt || null
                });
            }
        }

        return { status: 1, msg: `${empData.length} Employee Found`, data: { apollo_people_ids: apolloPeopleIds } };
    }

    return { status: 0, msg: "No Employee Found", data: { apollo_people_ids: apolloPeopleIds } };
};

/**
 * Searches for people on Apollo.
 */
const employeeData = async (domain, department = []) => {
    const apiKey = process.env.APOLLO_API_KEY;
    const APOLLO_API_URL = process.env.APOLLO_API_URL || "https://api.apollo.io/api/v1/";
    const url = `${APOLLO_API_URL}mixed_people/api_search`;
    const headers = {
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "X-Api-Key": apiKey
    };

    let resArr = [];
    try {
        const payload = {
            q_organization_domains: domain,
            page: 1,
            per_page: 5
        };

        if (department && department.length > 0) {
            payload.person_titles = department;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new AppError(`HTTP Error: ${response.status}`, StatusCodes.INTERNAL_SERVER_ERROR);
        const data = await response.json();
        const people = (data.people || []).slice(0, 5);

        resArr = people.map(emp => {
            const firstName = emp.first_name || "";
            const lastName = emp.last_name || emp.last_name_obfuscated || "";
            const empName = emp.name || `${firstName} ${lastName}`.trim();
            return {
                apollo_people_id: emp.id,
                emp_name: empName || "Anonymous",
                linkedin_url: emp.linkedin_url || null,
                twitter_id: emp.twitter_url || null,
                photo: emp.photo_url || null,
                designation: emp.title || null
            };
        });

        if (resArr.length < 5 && department && department.length > 0) {
            const remainLen = 5 - resArr.length;
            const fallbackPayload = {
                q_organization_domains: domain,
                page: 1,
                per_page: 5
            };

            const responseNoQuery = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(fallbackPayload)
            });

            if (responseNoQuery.ok) {
                const dataNoQuery = await responseNoQuery.json();
                const morePeople = (dataNoQuery.people || []).slice(0, remainLen);

                resArr.push(...morePeople.map(emp => {
                    const firstName = emp.first_name || "";
                    const lastName = emp.last_name || emp.last_name_obfuscated || "";
                    const empName = emp.name || `${firstName} ${lastName}`.trim();
                    return {
                        apollo_people_id: emp.id,
                        emp_name: empName || "Anonymous",
                        linkedin_url: emp.linkedin_url || null,
                        twitter_id: emp.twitter_url || null,
                        photo: emp.photo_url || null,
                        designation: emp.title || null
                    };
                }));
            }
        }
    } catch (error) {
        // Ignored
    }

    return resArr;
};

/**
 * Bulk matches people to get emails.
 */
const getEmployeeEmails = async (apollo_people_ids) => {
    if (!apollo_people_ids || apollo_people_ids.length === 0) return;

    const apiKey = process.env.APOLLO_API_KEY;
    const url = "https://api.apollo.io/api/v1/people/bulk_match?reveal_personal_emails=true&reveal_phone_number=false";
    const headers = {
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "x-api-key": apiKey
    };

    const payload = { details: apollo_people_ids.map(id => ({ id })) };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new AppError(`HTTP Error: ${response.status}`, StatusCodes.INTERNAL_SERVER_ERROR);
        const data = await response.json();

        if (data.matches && data.matches.length > 0) {
            for (const empData of data.matches) {
                const updatePayload = {};
                const fullName = empData.name || (empData.first_name && empData.last_name ? `${empData.first_name} ${empData.last_name}`.trim() : null);
                if (fullName) {
                    updatePayload.emp_name = sanitizeEmployeeText(fullName);
                }
                if (empData.email) {
                    updatePayload.emp_email = empData.email;
                }
                if (empData.linkedin_url) {
                    updatePayload.linkedin_id = empData.linkedin_url;
                }

                if (Object.keys(updatePayload).length > 0) {
                    await CompaniesEmployees.update(
                        updatePayload,
                        { where: { apollo_people_id: empData.id } }
                    );
                }
            }
        }
    } catch (error) {
        // Ignored
    }
};

/**
 * Fetches key data from website settings.
 */
const getKeyData = async (key) => {
    const setting = await Setting.findOne({ where: { var_name: 'LEAD_INSIGHT_CATEGORY' } });
    if (!setting) return null;

    try {
        const jsonData = JSON.parse(setting.setting_value || '{}');
        return jsonData[key] || null;
    } catch (e) {
        return null;
    }
};

/**
 * Wrapper for fetch.
 */
const fetchWithCurl = async (url, headers) => {
    const response = await fetch(url, { method: 'POST', headers });
    if (!response.ok) throw new AppError(`HTTP Error: ${response.status}`, StatusCodes.INTERNAL_SERVER_ERROR);
    return response;
};

export const getLeadInsightPlanDetails = async (vendor_id) => {
    const currentDate = new Date().toISOString().split('T')[0];
    const active = await OmsPiDetail.findOne({
        where: {
            vendor_id: vendor_id,
            lead_plan_id: { [Op.in]: eligiblePlanIds },
            pi_status: 3,
            [Op.or]: [
                { end_date: null },
                { end_date: { [Op.gte]: currentDate } }
            ]
        },
        order: [['id', 'DESC']]
    });
    if (active) return active.toJSON();

    const fallback = await OmsPiDetail.findOne({
        where: {
            vendor_id: vendor_id,
            lead_plan_id: { [Op.in]: eligiblePlanIds }
        },
        order: [['id', 'DESC']]
    });
    return fallback ? fallback.toJSON() : null;
};

export const hasRecentSubmission = async (vendor_id) => {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await VendorLeadInsightInterest.count({
        where: {
            vendor_id: vendor_id,
            submitted_at: {
                [Op.gte]: twentyFourHoursAgo
            }
        }
    });
    return count > 0;
};


/**
 * Fetches buyer activity timeline from MongoDB tracks for website leads.
 */
export const getWebsiteBuyerActivity = async (lead, vendor_id, lead_id, is_lead_insight_allowed) => {
    try {
        const db = mongoose.connection?.db;
        if (!db) {
            return { customer_activity_details: {}, activity: [] };
        }
        const tracksCollection = db.collection('tracks');

        let guuids = [];
        const fetchGuuids = async (customerIdType) => {
            const guuidPipeline = [
                { $match: { 'feeds.customer_id': { $in: [customerIdType] } } },
                { $project: { 'feeds.guuid': 1, 'feeds.created_at': 1, 'feeds.customer_id': 1 } },
                { $unwind: '$feeds' },
                { $match: { 'feeds.customer_id': { $in: [customerIdType] }, 'feeds.guuid': { $ne: null, $exists: true } } },
                { $sort: { 'feeds.created_at': -1 } },
                { $group: { _id: '$feeds.guuid', guuid: { $first: '$feeds.guuid' } } },
                { $limit: 10 }
            ];
            const results = await tracksCollection.aggregate(guuidPipeline).toArray();
            return results.map(r => r.guuid);
        };

        guuids = await fetchGuuids(String(lead.customer_id));
        if (guuids.length === 0 && !isNaN(Number(lead.customer_id))) {
            guuids = await fetchGuuids(Number(lead.customer_id));
        }

        let activities = [];
        if (guuids.length > 0) {
            const activityQuery = [
                {
                    $match: {
                        $or: [
                            { 'feeds.guuid': { $in: guuids } },
                            { 'feeds.lead_id': Number(lead_id) },
                            { 'feeds.lead_id': String(lead_id) }
                        ]
                    }
                },
                { $unwind: '$feeds' },
                { $sort: { created_at: -1 } },
                { $limit: 40 },
                {
                    $project: {
                        _id: 0,
                        guuid: '$feeds.guuid',
                        page_url: '$feeds.page_url',
                        feed_action: '$feeds.feed_action',
                        page_info: '$feeds.page_info',
                        formdata: '$feeds.formdata',
                        product_info: '$feeds.product_info',
                        lead_details: '$feeds.changes',
                        created_at: '$created_at'
                    }
                }
            ];
            activities = await tracksCollection.aggregate(activityQuery).toArray();
        }

        const finalActivityMap = {};
        for (const activity of activities) {
            let assetName = '';
            let assetType = '';
            const feedAction = activity.feed_action;

            const productId = activity.page_info?.product_id || activity.product_info?.product_id || activity.formdata?.product_id;
            let productName = activity.page_info?.product_name || activity.product_info?.product_name || activity.formdata?.product_name || activity.page_info?.title;
            const categoryName = activity.page_info?.category_name || activity.product_info?.category_name;

            let productVendorId = null;
            if (productId || productName) {
                try {
                    if (!TblProduct.associations.vendorBrandRelations) {
                        TblProduct.hasMany(VendorBrandRelation, { foreignKey: 'tbl_brand_id', sourceKey: 'brand_id', as: 'vendorBrandRelations' });
                    }
                    const productCondition = productId ? { product_id: productId } : { product_name: productName };
                    const productDetailsResult = await TblProduct.findOne({
                        attributes: ['product_name'],
                        where: productCondition,
                        include: [{
                            model: VendorBrandRelation,
                            as: 'vendorBrandRelations',
                            attributes: ['vendor_id'],
                            where: { status: 1, vendor_id: vendor_id },
                            required: false
                        }]
                    });

                    if (productDetailsResult) {
                        if (productDetailsResult.vendorBrandRelations && productDetailsResult.vendorBrandRelations.length > 0) {
                            productVendorId = productDetailsResult.vendorBrandRelations[0].vendor_id;
                        }
                        if (!productName) productName = productDetailsResult.product_name;
                    }
                } catch (err) {
                    // Ignored
                }
            }

            if (productName && productVendorId && String(productVendorId) === String(vendor_id)) {
                assetName = productName;
                assetType = 'Product';
            } else if (categoryName) {
                assetName = categoryName;
                assetType = 'Category';
            } else if (activity.page_info?.page_type === 'home' && feedAction === 'page_view' && /techjockey\.com\/$/.test(activity.page_url)) {
                assetName = 'visited_home_page';
                assetType = 'visited_home_page';
            } else if (activity.formdata?.form_name === 'searchForm' && feedAction === 'form_submit') {
                assetName = activity.formdata.keyword ? activity.formdata.keyword.replace(/\b\w/g, l => l.toUpperCase()) : 'Search';
                assetType = 'searched_keyword';
            }

            if (assetName && feedAction && assetType) {
                if (!finalActivityMap[assetType]) finalActivityMap[assetType] = {};
                if (!finalActivityMap[assetType][assetName]) finalActivityMap[assetType][assetName] = {};
                if (!finalActivityMap[assetType][assetName][feedAction]) {
                    finalActivityMap[assetType][assetName][feedAction] = { count: 0, created_at: activity.created_at };
                }
                finalActivityMap[assetType][assetName][feedAction].count++;
            }
        }

        const getActivityByFeedAction = (asset_type, asset_name, activity_name, activity_count) => {
            const countText = activity_count > 1 ? ` ${activity_count} times` : "";
            let activity = "";
            if (asset_type === 'searched_keyword' && activity_name === 'form_submit') {
                activity = `Customer searched for "${asset_name}"${countText}`;
            } else if (asset_type === 'visited_home_page' && activity_name === 'page_view') {
                activity = `Customer visited Home Page${countText}`;
            } else {
                switch (activity_name) {
                    case 'lead_created':
                        activity = `Requested Demo for ${asset_name} ${asset_type}${countText}`;
                        break;
                    case 'page_view':
                        activity = `Frequently revisited the ${asset_name} page${countText}`;
                        break;
                    case 'form_submit':
                        activity = `Initiated call request for ${asset_name} ${asset_type}${countText}`;
                        break;
                    case 'checked_price':
                        activity = `Checked pricing options for ${asset_name} ${asset_type}${countText}`;
                        break;
                    case 'add_to_cart':
                        activity = `${asset_type} ${asset_name} has been added to the cart${countText}`;
                        break;
                    case 'add_to_wishlist':
                        activity = `${asset_type} ${asset_name} has been added to wishlist${countText}`;
                        break;
                    case 'read_reviews':
                        activity = `Read multiple product reviews for ${asset_name} ${asset_type}${countText}`;
                        break;
                    default:
                        activity = `Customer expressed interest in ${asset_name} ${asset_type}${countText}`;
                        break;
                }
            }
            return activity;
        };

        const allActivities = [];
        for (const assetType of Object.keys(finalActivityMap)) {
            for (const assetName of Object.keys(finalActivityMap[assetType])) {
                for (const feedAction of Object.keys(finalActivityMap[assetType][assetName])) {
                    const details = finalActivityMap[assetType][assetName][feedAction];
                    const text = getActivityByFeedAction(assetType, assetName, feedAction, details.count);
                    if (text) {
                        allActivities.push({
                            assetType,
                            assetName,
                            feedAction,
                            action: text,
                            created_at: details.created_at,
                            count: details.count
                        });
                    }
                }
            }
        }

        allActivities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        const slicedActivities = allActivities.slice(0, 10);

        const truncatedActivityMap = {};
        const activityTimeline = [];

        for (const item of slicedActivities) {
            if (!truncatedActivityMap[item.assetType]) truncatedActivityMap[item.assetType] = {};
            if (!truncatedActivityMap[item.assetType][item.assetName]) truncatedActivityMap[item.assetType][item.assetName] = {};

            truncatedActivityMap[item.assetType][item.assetName][item.feedAction] = {
                count: item.count,
                created_at: item.created_at
            };

            activityTimeline.push({
                action: item.action,
                created_at: item.created_at
            });
        }

        return {
            customer_activity_details: truncatedActivityMap,
            activity: activityTimeline
        };
    } catch (mongoError) {
        return { customer_activity_details: {}, activity: [] };
    }
};

/**
 * Fetches buyer activity timeline for Non-Website leads (e.g. Calls/ACD, CRM, Manual, Campaigns).
 */
export const getNonWebsiteBuyerActivity = async (lead, vendor_id, lead_id, is_lead_insight_allowed) => {
    try {
        const activityTimeline = await getDeterministicBuyerActivityTimeline(lead);

        return {
            customer_activity_details: {},
            activity: activityTimeline
        };
    } catch (error) {
        return { customer_activity_details: {}, activity: [] };
    }
};

/**
 * Get lead insights with ownership verification.
 */
export const getLeadInsights = async (vendor_id, lead_id) => {
    try {
        const full_access_plan_id = eligiblePlanIds;

        // const vendor = await Vendor.findByPk(vendor_id, {
        //     attributes: ['lead_insight_display']
        // });

        // if (!vendor || vendor.lead_insight_display != 1) {
        //     return null;
        // }

        await verifyLeadOwnership(vendor_id, lead_id);

        let lead = await TblLeads.findByPk(lead_id, {
            attributes: ['id', 'user_id', 'customer_id', 'email', 'company_id', 'category_id', 'software_category', 'product_id', 'product_name', 'oms_pi_id', 'credit_used', 'status', 'lead_action', 'source', 'created_at', 'city', 'state', 'is_contact_viewed', 'lead_model_type']
        });
        if (!lead) return null;

        const planDetails = await getLeadInsightPlanDetails(vendor_id);
        let plan_name = 'No Plan';
        let plan_id = '';

        if (planDetails) {
            const pi_status = planDetails.pi_status;
            const end_date = planDetails.end_date;
            const currentDate = new Date().toISOString().split('T')[0];

            if (pi_status == '3' && new Date(end_date).toISOString().split('T')[0] >= currentDate && eligiblePlanIds.includes(Number(planDetails.lead_plan_id))) {
                plan_id = planDetails.lead_plan_id;
                plan_name = planDetails.plan_name;
            }
        }

        let is_lead_insight_allowed = 0;
        const currentDate = new Date().toISOString().split('T')[0];
        let resolvedProductId = lead.product_id;
        if (!resolvedProductId && lead.product_name) {
            const product = await TblProduct.findOne({ where: { product_name: lead.product_name }, attributes: ['product_id'] });
            resolvedProductId = product ? product.product_id : null;
        }

        if (resolvedProductId) {
            const resultCount = await sequelize.query(`
                SELECT COUNT(1) as count 
                FROM oms_pi_details opd
                INNER JOIN oms_pi_products opp ON opd.id = opp.pi_id
                WHERE opd.vendor_id = :vendor_id 
                  AND opd.pi_status = 3 
                  AND opd.lead_plan_id IN (:eligiblePlanIds)
                  AND (opd.end_date IS NULL OR opd.end_date >= :currentDate)
                  AND opp.product_id = :product_id
            `, {
                replacements: { vendor_id, eligiblePlanIds, currentDate, product_id: resolvedProductId },
                type: sequelize.QueryTypes.SELECT
            });
            is_lead_insight_allowed = resultCount[0]?.count > 0 ? 1 : 0;
        }

        if (is_lead_insight_allowed === 1) {
            await fetchLeadInsightsData(lead_id, vendor_id);
            // Re-fetch lead since fetchLeadInsightsData might have updated company_id and leadinsight
            lead = await TblLeads.findByPk(lead_id, {
                attributes: ['id', 'user_id', 'customer_id', 'email', 'company_id', 'category_id', 'software_category', 'product_id', 'product_name', 'oms_pi_id', 'credit_used', 'status', 'lead_action', 'source', 'created_at', 'city', 'state', 'is_contact_viewed', 'lead_model_type']
            });
            if (!lead) return null;
        }

        const totalCredits = lead?.oms_pi_id ? await OmsPiDetail.sum('total_lead', {
            where: { id: lead.oms_pi_id }
        }) : 0;

        const usedCredits = lead?.oms_pi_id ? await TblLeads.sum('credit_used', {
            where: { oms_pi_id: lead.oms_pi_id, is_trashed: 0 }
        }) : 0;

        const latestCallback = await TblRequestCallbacks.findOne({
            where: { lead_id },
            order: [['created_at', 'DESC']],
            attributes: ['designation']
        });

        const questionnaireQuery = `
            SELECT alqa.lead_id, lqs.id as tag_id, lqs.tag_name, lqs.tag_value, aq.id as question_id, aq.question, 
            (CASE 
                WHEN alqa.custom_ans IS NOT NULL THEN alqa.custom_ans
                WHEN aqo.is_user_defined=0 THEN aqo.option 
                WHEN aqo.is_user_defined=1 && aqo.option != 'NA' THEN CONCAT(aqo.option, ' - ', alqa.user_defined_ans) 
                ELSE alqa.user_defined_ans
            END) as answer 
            FROM acd_leads_ques_ans alqa 
            LEFT JOIN acd_questions_options aqo on alqa.ans_id = aqo.id 
            LEFT JOIN acd_questions aq on alqa.ques_id = aq.id 
            LEFT JOIN leads_questions_tags lqs on aq.tag_id = lqs.id
            WHERE alqa.lead_id = :lead_id
            ORDER BY alqa.lead_id DESC, aq.id ASC
        `;

        const questionnaireData = await sequelize.query(questionnaireQuery, {
            replacements: { lead_id },
            type: sequelize.QueryTypes.SELECT
        });

        let qDesignation = null;
        let qIndustry = null;
        let qCompanySize = null;
        let additionalInfo = [];

        if (questionnaireData && questionnaireData.length > 0) {
            let qId = 0;
            questionnaireData.forEach(q => {
                if (q.answer) {
                    if (q.question_id !== qId) {
                        additionalInfo.push({ ...q });
                    } else {
                        additionalInfo[additionalInfo.length - 1].answer += '  |  ' + q.answer;
                    }
                    qId = q.question_id;
                }
            });

            // Extract the specific fields for convenience, just like before, using the aggregated answers
            additionalInfo.forEach(q => {
                if (q.tag_value === 'persona') {
                    qDesignation = q.answer;
                } else if (q.tag_value === 'industry') {
                    qIndustry = q.answer;
                } else if (q.tag_value === 'company_size') {
                    qCompanySize = q.answer;
                }
            });
        }


        const vendorData = await Vendor.findByPk(vendor_id, {
            attributes: ['id', 'first_name', 'last_name', 'email', 'phone', 'dial_code']
        });

        const result = {
            customer_activity_details: {},
            customer_company_information: {},
            top_five_key_people: [],
            activity: [],
            device: 'web',
            leadinsight_plan_name: plan_name,
            leadinsight_plan_id: plan_id,
            total_credits: totalCredits,
            used_credits: usedCredits,
            lead_credit_used: lead.credit_used,
            full_access_plan_id,
            has_recent_submission: await hasRecentSubmission(vendor_id),
            vendor_data: vendorData || {},
            actions: await getLeadActions(lead),
            current_status: lead.status,
            current_action: lead.lead_action,
            buying_stage: (lead.status === 2 || lead.status === 12) ? 'Decision' : (lead.status === 1 ? 'Evaluation' : 'Awareness'),
            city: lead.city,
            state: lead.state,
            designation: qDesignation || (latestCallback ? latestCallback.designation : null),
            industry: qIndustry,
            company_size: qCompanySize,
            additional_info: additionalInfo
        };

        if (lead.company_id) {
            let company = await Companies.findOne({
                attributes: [
                    ['id', 'company_id'],
                    ['company', 'name'],
                    ['employees_size', 'team_size'],
                    'industry',
                    'website',
                    ['company_linkedin_url', 'linkedin'],
                    'logo_url'
                ],
                where: { id: lead.company_id },
                raw: true
            });

            if (company && is_lead_insight_allowed !== 1) {
                company.name = company.name ? company.name.substring(0, 5) + "********" : "********";
                company.website = company.website ? "********" : null;
                company.linkedin = company.linkedin ? "********" : null;
                company.logo_url = null;
            }

            if (company) {
                Object.assign(result, company);
            }
            result.customer_company_information = company || {};
            let keyPeople = [];
            if (lead.category_id) {
                keyPeople = await CompaniesEmployees.findAll({
                    attributes: ['id', 'company_id', 'emp_name', 'emp_email', 'linkedin_id', 'photo', 'designation', 'mapped_categories'],
                    where: {
                        company_id: lead.company_id,
                        [Op.and]: sequelize.literal(`FIND_IN_SET('${lead.category_id}', mapped_categories) > 0`)
                    },
                    limit: 5,
                    raw: true
                });
            }
            if ((!keyPeople || keyPeople.length === 0) && lead.company_id) {
                keyPeople = await CompaniesEmployees.findAll({
                    attributes: ['id', 'company_id', 'emp_name', 'emp_email', 'linkedin_id', 'photo', 'designation', 'mapped_categories'],
                    where: { company_id: lead.company_id },
                    limit: 5,
                    raw: true
                });
            }

            if (keyPeople && is_lead_insight_allowed !== 1) {
                keyPeople = [];
            }

            result.top_five_key_people = keyPeople || [];
        }

        if (qIndustry) result.industry = qIndustry;
        if (qCompanySize) result.team_size = qCompanySize;

        // 3. Fetch Buyer Activity Timeline (Website vs Non-Website)
        const isWebsiteSource = ['website', 'web'].includes(String(lead.source || '').toLowerCase().trim());

        let activityResult = { customer_activity_details: {}, activity: [] };
        if (isWebsiteSource) {
            if (lead.customer_id) {
                activityResult = await getWebsiteBuyerActivity(lead, vendor_id, lead_id, is_lead_insight_allowed);
            }
        } else {
            activityResult = await getNonWebsiteBuyerActivity(lead, vendor_id, lead_id, is_lead_insight_allowed);
        }

        result.customer_activity_details = activityResult.customer_activity_details || {};
        result.activity = activityResult.activity || [];

        result.has_recent_submission = await hasRecentSubmission(vendor_id);

        if (Number(lead.lead_model_type) !== 1) {
            result.activity = [];
            result.customer_activity_details = {};
            result.customer_company_information = {};
            result.top_five_key_people = [];
            result.company_id = null;
            result.name = "********";
            result.team_size = "********";
            result.website = "********";
            result.linkedin = "********";
            result.logo_url = null;
        }

        return result;
    } catch (error) {
        throw error;
    }
};

/**
 * Unlock lead insights interest.
 */
export const unlockLeadInsights = async (vendor_id, data) => {
    let { company, email, date = null, time = [], remark = null, gp = null } = data;

    if (!company || !email || !gp) {
        const vendor = await Vendor.findByPk(vendor_id);
        const vendorDetails = await VendorDetails.findOne({ where: { vendor_id } });

        if (!company && vendorDetails) company = vendorDetails.company;
        if (!email && vendor) email = vendor.email;
        if (!gp && vendor) gp = `${vendor.first_name || ''} ${vendor.last_name || ''}`.trim();
    }

    const submitted_at = new Date();
    const createdAtStr = submitted_at.toISOString().slice(0, 19).replace('T', ' ');

    try {
        const truncatedGp = gp ? gp.substring(0, 10) : null;
        await VendorLeadInsightInterest.create({
            vendor_id,
            gp: truncatedGp,
            company_name: company || 'N/A',
            contact_email: email || 'N/A',
            notes: remark,
            submitted_at,
            preferred_call_date: date,
            preferred_call_time: time ? (typeof time === 'string' ? time : JSON.stringify(time)) : '[]'
        });

        const timeArr = Array.isArray(time) ? time : JSON.parse(time || '[]');
        const emailBody = await renderTemplate("lead-insight-interest", {
            vendor_id: vendor_id,
            company: company || 'N/A',
            email: email || 'N/A',
            date: date || '',
            time_hour: timeArr[0] || '',
            time_minute: timeArr[1] || '',
            remark: remark || ''
        });

        if (!Vendor.associations.manager) {
            Vendor.belongsTo(AdminUsers, { foreignKey: 'acc_manager_id', targetKey: 'adminusers_id', as: 'manager' });
        }
        const vendorRec = await Vendor.findOne({
            attributes: ['id'],
            where: { id: vendor_id },
            include: [{
                model: AdminUsers,
                as: 'manager',
                attributes: ['adminusers_email']
            }]
        });
        const defaultEmail = process.env.REQUEST_CALLBACK_CC_MANAGER_IDS || '';
        const toEmail = vendorRec?.manager?.adminusers_email || defaultEmail.split(',')[0]?.trim();

        try {
            await publishEmailToQueue({
                rawHtml: emailBody,
                subject: `New Interest in Unlock Lead Insights from ${company}`,
                emailType: "lead_insight_interest",
                to: toEmail,
            });
        } catch (queueError) {
            console.warn("RabbitMQ publish skipped or unavailable:", queueError.message);
        }

        return { status: true, message: 'Thank you for your interest! Our team will contact you shortly.' };
    } catch (err) {
        throw err;
    }
};

/**
 * Private helper to calculate working minutes between two dates.
 */
function getAvgTimeMinute(beginDate, endDate) {
    const begin = new Date(beginDate);
    const end = new Date(endDate);
    let totalMinutes = 0;

    const startHour = 10;
    const endHour = 19;

    let current = new Date(begin);
    while (current.toDateString() !== end.toDateString()) {
        const dayOfWeek = current.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            if (current.toDateString() === begin.toDateString()) {
                const h = begin.getHours();
                const m = begin.getMinutes();
                if (h < startHour) {
                    totalMinutes += (endHour - startHour) * 60;
                } else if (h < endHour) {
                    totalMinutes += (endHour * 60) - (h * 60 + m);
                }
            } else {
                totalMinutes += (endHour - startHour) * 60;
            }
        }
        current.setDate(current.getDate() + 1);
    }

    const dayOfWeek = end.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        if (begin.toDateString() === end.toDateString()) {
            const startH = begin.getHours();
            const startM = begin.getMinutes();
            const endH = end.getHours();
            const endM = end.getMinutes();

            const s = Math.max(startH * 60 + startM, startHour * 60);
            const e = Math.min(endH * 60 + endM, endHour * 60);
            if (e > s) {
                totalMinutes += (e - s);
            }
        } else {
            const h = end.getHours();
            const m = end.getMinutes();
            if (h >= startHour) {
                const e = Math.min(h * 60 + m, endHour * 60);
                totalMinutes += (e - startHour * 60);
            }
        }
    }
    return totalMinutes;
}

/**
 * Unlocks contact with ownership verification.
 */
export const unlockContact = async (user, lead_id) => {
    const vendor_id = user.vendor_id;
    await verifyLeadOwnership(vendor_id, lead_id);

    const leadInfo = await TblLeads.findOne({
        where: { id: lead_id },
        attributes: [
            'id', 'vendor_id', 'created_at', 'is_contact_viewed', 'email', 'phone',
            'dial_code', 'is_show_contact', 'product_id', 'name', 'product_name',
            'brand_id', 'brand_name', 'category_id', 'software_category'
        ],
        include: [{
            model: TblProduct,
            as: 'product',
            attributes: ['lead_model_type', 'slug']
        }]
    });

    if (!leadInfo) throw new Error("Lead not found");


    if (leadInfo.is_contact_viewed === 0) {
        await TblLeads.update(
            { is_contact_viewed: 1, is_show_contact: 1 },
            { where: { id: lead_id } }
        );

        const contactViewedCount = await LeadHistory.count({
            where: {
                lead_id: lead_id,
                type: 'contact_viewed'
            }
        });

        if (contactViewedCount === 0) {
            await LeadHistory.create({
                lead_id: lead_id,
                acd_uuid: '',
                type: 'contact_viewed',
                remark: 'Contact viewed by OEM'
            });

            try {
                const db = mongoose.connection?.db;
                if (db) {
                    await db.collection('tracks').insertOne({
                        lead_id: Number(lead_id),
                        feed_action: 'lead_contact_info',
                        feed_activity: 'OEM Clicked On Contact Info.',
                        created_at: new Date()
                    });
                }
            } catch (mongoErr) {
                // Ignored
            }

            try {
                const leadDataForEvent = {
                    ...leadInfo.toJSON(),
                    category_name: leadInfo.software_category,
                    product_slug: leadInfo.product?.slug
                };
                await engagementEvent.oemShowContact(user, leadDataForEvent);
            } catch (eventErr) {
                console.error("Engagement event error:", eventErr);
            }

            try {
                const countVal = await LeadsCallAttempt.count({
                    where: { lead_id: lead_id }
                });
                if (countVal === 0) {
                    const lead_avg_time = getAvgTimeMinute(leadInfo.created_at, new Date());

                    await LeadsCallAttempt.create({
                        lead_id: leadInfo.id,
                        vendor_id: leadInfo.vendor_id,
                        attempt_time: lead_avg_time,
                        lead_date: leadInfo.created_at,
                        lead_attempt_date: new Date()
                    });

                    const lead_date = new Date(leadInfo.created_at).toISOString().split('T')[0];
                    const today = new Date().toISOString().split('T')[0];
                    if (today > lead_date) {
                        await VendorAnalytics.increment({
                            total_attempt_lead: 1,
                            total_attempt_time: lead_avg_time,
                            utilised_leads: 1
                        }, {
                            where: { vendor_id: leadInfo.vendor_id, logic_date: lead_date }
                        });
                    }
                }
            } catch (sqlErr) {
                // Ignored
            }
        }
    }

    const updatedLead = await TblLeads.findOne({
        where: { id: lead_id },
        attributes: ['email', 'phone']
    });

    return {
        status: true,
        message: 'Contact unlocked successfully',
        email: updatedLead ? updatedLead.email : null,
        phone: updatedLead ? updatedLead.phone : null,
        is_show_contact: 1
    };
};

/**
 * Private helper to add weekdays to a date.
 */
function addWeekdays(date, days) {
    const d = new Date(date);
    let added = 0;
    while (added < days) {
        d.setDate(d.getDate() + 1);
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) added++;
    }
    return d;
}

/**
 * Get lead actions with business logic.
 */
export const getLeadActions = async (lead) => {
    const weekdays = 100;

    let logicDate = new Date(lead.created_at || Date.now());
    const dayName = logicDate.toLocaleDateString('en-US', { weekday: 'short' });
    const timeStr = logicDate.toTimeString().slice(0, 8);
    let flag = false;
    let isMon = false;

    switch (dayName) {
        case 'Sat':
        case 'Sun':
            flag = true;
            break;
        case 'Fri':
            if (timeStr > '18:00:00') flag = true;
            break;
        case 'Mon':
            if (timeStr < '10:00:00') { flag = true; isMon = true; }
            break;
        default:
            flag = false;
    }

    if (flag) {
        if (isMon) {
            logicDate.setHours(10, 0, 0, 0);
        } else {
            const dow = logicDate.getDay();
            const daysUntilMon = (8 - dow) % 7 || 7;
            logicDate.setDate(logicDate.getDate() + daysUntilMon);
            logicDate.setHours(10, 0, 0, 0);
        }
    }

    logicDate = addWeekdays(logicDate, weekdays);
    const disabledActions = logicDate < new Date() ? [3, 13, 14, 15, 28, 31] : [];

    const rows = await LeadStatus.findAll({
        attributes: ['id', 'status_name', 'lead_action_name', 'subaction_name'],
        where: {
            status: 1,
            source: { [Op.in]: [1, 2] },
            ...(lead.is_contact_viewed !== 1 && { status_id: lead.status }),
        },
        order: [['lead_priority', 'ASC']],
    });

    const remarks = [31];
    const actionsMap = {};

    for (const row of rows) {
        const r = row.toJSON();
        const isDisabled =
            Number(r.id) === Number(lead.lead_action) ||
            r.lead_action_name === r.status_name ||
            disabledActions.includes(Number(r.id));

        if (!r.subaction_name) {
            actionsMap[r.lead_action_name] = {
                id: r.id,
                lead_action_name: r.lead_action_name,
                isClickable: !isDisabled,
                isSubAction: false,
                isIndented: r.lead_action_name !== r.status_name,
                isRemarkRequired: remarks.includes(r.id),
                data: [],
            };
        } else {
            if (!actionsMap[r.lead_action_name]) {
                actionsMap[r.lead_action_name] = {
                    lead_action_name: r.lead_action_name,
                    isSubAction: true,
                    isClickable: false,
                    isRemarkRequired: false,
                    data: [],
                };
            }
            actionsMap[r.lead_action_name].data.push({
                id: r.id,
                lead_action_name: r.subaction_name || r.lead_action_name,
                isClickable: !isDisabled,
                isSubAction: false,
                isRemarkRequired: remarks.includes(r.id),
                data: [],
            });
        }
    }

    return Object.values(actionsMap);
};

/**
 * Get lead insights with ownership verification.
 */

export const getLeadCompetiterInsights = async (vendor_id, lead_id) => {
    try {
        const vendor = await Vendor.findByPk(vendor_id, {
            attributes: ['lead_insight_display'],
            raw: true
        });

        // if (!vendor || Number(vendor.lead_insight_display) !== 1) {
        //     return [];
        // }

        const lead = await TblLeads.findByPk(lead_id, {
            attributes: ['id', 'customer_id', 'category_id', 'product_id', 'product_name', 'original_parent_id'],
            raw: true
        });

        if (!lead || !lead.customer_id) {
            return [];
        }

        const db = mongoose.connection?.db;

        if (!db) {
            console.warn("MongoDB connection not established for Lead Insights");
            return [];
        }

        // const customerRelatedData = await getCustomerRelatedGuuids(
        //     lead.customer_id
        // );

        // const guuids = customerRelatedData
        //     ?.map(item => item.guuid)
        //     ?.filter(Boolean);

        let relatedProducts = [];

        // if (guuids?.length) {

        //     const activityQuery = [
        //         {
        //             $match: {
        //                 "feeds.guuid": {
        //                     $in: guuids
        //                 }
        //             }
        //         },

        //         {
        //             $unwind: "$feeds"
        //         },

        //         {
        //             $match: {
        //                 "feeds.page_info.category_id": String(lead.category_id),

        //                 "feeds.page_info.product_id": {
        //                     $exists: true,
        //                     $ne: null,
        //                     $nin: [
        //                         String(lead.product_id),
        //                         Number(lead.product_id)
        //                     ]
        //                 }
        //             }
        //         },

        //         {
        //             $group: {
        //                 _id: "$feeds.page_info.product_id",

        //                 product_id: {
        //                     $first: "$feeds.page_info.product_id"
        //                 },

        //                 product_name: {
        //                     $first: "$feeds.page_info.product_name"
        //                 },

        //                 visits: {
        //                     $sum: 1
        //                 }
        //             }
        //         },

        //         {
        //             $project: {
        //                 _id: 0,
        //                 product_id: 1,
        //                 product_name: 1,
        //                 visits: 1
        //             }
        //         },

        //         {
        //             $sort: {
        //                 visits: -1
        //             }
        //         },

        //         {
        //             $limit: 20
        //         }
        //     ];

        //     relatedProducts = await db
        //         .collection('tracks')
        //         .aggregate(activityQuery)
        //         .toArray();
        // }

        const MAX_RECOMMENDED_PRODUCTS = 3;

        const addUniqueProducts = (map, items = [], idKey = 'product_id', nameKey = 'product_name') => {
            items.forEach(item => {
                const productId = item[idKey];
                const productName = item[nameKey]?.trim();

                if (
                    !productId ||
                    !productName ||
                    String(productId) === String(lead.product_id) ||
                    map.has(String(productId))
                ) {
                    return;
                }

                map.set(String(productId), {
                    product_id: productId,
                    product_name: productName,
                    visits: item.visits ?? 0
                });
            });
        };

        const productsMap = new Map();
        addUniqueProducts(productsMap, relatedProducts);

        if (productsMap.size < MAX_RECOMMENDED_PRODUCTS) {
            const siblingProducts = await TblLeads.findAll({
                attributes: ['product_id', 'product_name'],
                where: {
                    original_parent_id: lead.id
                },
                raw: true
            });
console.log(`siblingProducts`, siblingProducts);
            addUniqueProducts(productsMap, siblingProducts);
        }

        if (productsMap.size < MAX_RECOMMENDED_PRODUCTS) {
            const remainingSlots = MAX_RECOMMENDED_PRODUCTS - productsMap.size;
            const excludedProductIds = [lead.product_id, ...productsMap.keys()];

            const topAlternatives = await ProductAlternative.findAll({
                attributes: ['alternate_product_id'],
                where: {
                    product_id: lead.product_id,
                    alternate_product_id: { [Op.notIn]: excludedProductIds }
                },
                order: [['weightage', 'DESC'], ['sort_order', 'ASC']],
                limit: remainingSlots,
                raw: true
            });
console.log(`topAlternatives`, topAlternatives);
            if (topAlternatives.length) {
                const alternateProducts = await TblProduct.findAll({
                    attributes: ['product_id', 'product_name'],
                    where: {
                        product_id: { [Op.in]: topAlternatives.map(item => item.alternate_product_id) }
                    },
                    raw: true
                });
console.log(`alternateProducts`,alternateProducts);
                addUniqueProducts(productsMap, alternateProducts);
            }
        }

        return Array.from(productsMap.values()).slice(0, MAX_RECOMMENDED_PRODUCTS);

    } catch (error) {

        console.error(
            "Error while fetching getLeadCompetiterInsights:",
            error
        );

        return [];
    }
};


export const getCustomerRelatedGuuids = async (customerId) => {
    try {
        const db = mongoose.connection?.db;
        if (!db) {
            return [];
        }

        const tracksCollection = db.collection("tracks");

        const runAggregation = async (customerIdValue) => {
            return await tracksCollection
                .aggregate(
                    [
                        {
                            $unwind: "$feeds",
                        },
                        {
                            $match: {
                                "feeds.customer_id": customerIdValue,
                                "feeds.guuid": {
                                    $exists: true,
                                    $ne: null,
                                },
                            },
                        },
                        {
                            $sort: {
                                "feeds.created_at": -1,
                            },
                        },
                        {
                            $group: {
                                _id: "$feeds.guuid",
                                guuid: {
                                    $first: "$feeds.guuid",
                                },
                            },
                        },
                        {
                            $limit: 10,
                        },
                        {
                            $project: {
                                _id: 0,
                                guuid: 1,
                            },
                        },
                    ],
                    {
                        batchSize: 10,
                    }
                )
                .toArray();
        };

        // First try string customer_id
        let customerRelatedGuuids = await runAggregation(
            String(customerId)
        );

        // Retry with number customer_id if empty
        if (!customerRelatedGuuids.length) {
            customerRelatedGuuids = await runAggregation(
                Number(customerId)
            );
        }

        return customerRelatedGuuids;
    } catch (error) {

        return [];
    }
};

/**
 * Get map data (leads grouped by state or city).
 * `filters` (all optional, backward compatible): date_from, date_to,
 * product_id, plan_scope ('current' scopes to leads created inside a
 * currently-active plan's own date window for that product - tbl_leads has
 * no reliable oms_pi_id to join on, it's NULL on every row in this dataset).
 */
export const getMapData = async (vendor_id, type, filters = {}) => {
    try {
        const { date_from, date_to, product_id, plan_scope } = filters;
        const needsPlanScope = plan_scope === "current";

        const currentPlanExists = `
            EXISTS (
                SELECT 1 FROM oms_pi_details d
                JOIN oms_pi_products p ON p.pi_id = d.id
                WHERE d.vendor_id = l.vendor_id
                  AND p.product_id = l.product_id
                  AND d.pi_status = 3
                  AND CURDATE() BETWEEN d.start_date AND d.end_date
                  AND l.created_at BETWEEN d.start_date AND d.end_date
            )
        `;

        const extraWhere = [
            date_from && date_to ? "AND l.created_at BETWEEN :date_from AND :date_to_end" : "",
            product_id ? "AND l.product_id = :product_id" : "",
            needsPlanScope ? `AND ${currentPlanExists}` : "",
        ].join("\n");

        let query = "";

        if (type === 'state') {
            query = `
                SELECT l.state as name, COUNT(*) as value
                FROM tbl_leads l
                JOIN tbl_state_master s ON l.state = s.state_name
                WHERE l.vendor_id = :vendor_id
                  AND s.countries_id = 99
                  AND l.state IS NOT NULL
                  AND l.state != ''
                  AND (l.lead_visibility = 1 OR (l.lead_visibility = 0 AND l.is_trashed = 1))
                  ${extraWhere}
                GROUP BY l.state
            `;
        } else if (type === 'city') {
            query = `
                SELECT l.city as name, l.state as state, COUNT(*) as value
                FROM tbl_leads l
                JOIN tbl_state_master s ON l.state = s.state_name
                WHERE l.vendor_id = :vendor_id
                  AND s.countries_id = 99
                  AND l.city IS NOT NULL
                  AND l.city != ''
                  AND l.state IS NOT NULL
                  AND l.state != ''
                  AND (l.lead_visibility = 1 OR (l.lead_visibility = 0 AND l.is_trashed = 1))
                  ${extraWhere}
                GROUP BY l.state, l.city
            `;
        }

        const results = await sequelize.query(query, {
            replacements: {
                vendor_id,
                product_id,
                date_from,
                date_to_end: date_to ? `${date_to} 23:59:59` : undefined,
            },
            type: QueryTypes.SELECT
        });

        return results;
    } catch (error) {
        throw new AppError(error.message, StatusCodes.INTERNAL_SERVER_ERROR);
    }
};