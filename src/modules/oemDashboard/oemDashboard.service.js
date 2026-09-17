import { QueryTypes } from "sequelize";
import sequelize from "../../db/connection.js";
import { AppError } from "../../utilis/appError.js";
import StatusCodes from "../../utilis/statusCodes.js";

const ANALYTICS_DB = process.env.ANALYTICS_DB_NAME || "tj_analytics_reporting";

const LEAD_VISIBILITY_CLAUSE = "(l.lead_visibility = 1 OR (l.lead_visibility = 0 AND l.is_trashed = 1))";

/**
 * tbl_leads.oms_pi_id is NULL on every row in this dataset (checked live -
 * 0 of 167,928 rows populated), so "current plan only" for leads can't join
 * on it. Instead it's scoped by: does a currently-active plan exist for
 * this vendor+product, and does the lead's created_at fall inside that
 * plan's own date window (not just the requested report range).
 */
const CURRENT_PLAN_EXISTS_FOR_LEAD = `
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

/**
 * Builds the shared vendor/product/plan-scope WHERE fragment + replacements
 * used by the visibility_pool_daily queries below. `alias` is the
 * oms_pi_details table alias (already joined there via pi_id).
 */
const buildPlanScopeClause = ({ product_id, plan_scope }, alias = "d") => {
    const clauses = [];
    const replacements = {};

    if (product_id) {
        replacements.product_id = product_id;
    }

    if (plan_scope === "current") {
        clauses.push(`${alias}.pi_status = 3 AND CURDATE() BETWEEN ${alias}.start_date AND ${alias}.end_date`);
    }

    return { clauses, replacements };
};

const daysBetween = (date_from, date_to) => {
    const from = new Date(date_from);
    const to = new Date(date_to);
    return Math.round((to - from) / (1000 * 60 * 60 * 24)) + 1;
};

const previousPeriod = (date_from, date_to) => {
    const length = daysBetween(date_from, date_to);
    const from = new Date(date_from);
    const prevTo = new Date(from);
    prevTo.setDate(prevTo.getDate() - 1);
    const prevFrom = new Date(prevTo);
    prevFrom.setDate(prevFrom.getDate() - (length - 1));
    const toIso = (d) => d.toISOString().split("T")[0];
    return { date_from: toIso(prevFrom), date_to: toIso(prevTo) };
};

/**
 * Vendor's products (from oms_pi_products, scoped to their own plans),
 * each flagged with whether they currently have an active plan for it and
 * how many distinct days of visibility_pool_daily data exist for it so far
 * (across all its historical plans) - used to gate the dashboard behind a
 * "still syncing" state for freshly-activated products.
 */
export const getVendorProducts = async (vendor_id) => {
    try {
        // product_name is denormalized onto oms_pi_products per-plan and drifts
        // in casing across a product's plan history (e.g. "My Billbook" vs
        // "myBillBook" for the same product_id) - pick the name from the most
        // recent plan (highest pi_id) as the canonical one instead of grouping
        // on it, which would otherwise produce duplicate rows per spelling.
        const query = `
            SELECT
                p.product_id,
                SUBSTRING_INDEX(GROUP_CONCAT(p.product_name ORDER BY d.id DESC), ',', 1) AS product_name,
                MAX(CASE WHEN d.pi_status = 3 AND CURDATE() BETWEEN d.start_date AND d.end_date THEN 1 ELSE 0 END) AS has_current_plan,
                (
                    SELECT COUNT(DISTINCT v.report_date)
                    FROM ${ANALYTICS_DB}.visibility_pool_daily v
                    JOIN oms_pi_details d2 ON d2.id = v.pi_id
                    WHERE d2.vendor_id = :vendor_id AND v.product_id = p.product_id
                ) AS days_of_data
            FROM oms_pi_products p
            JOIN oms_pi_details d ON d.id = p.pi_id
            WHERE d.vendor_id = :vendor_id
            GROUP BY p.product_id
            ORDER BY product_name
        `;
        return await sequelize.query(query, {
            replacements: { vendor_id },
            type: QueryTypes.SELECT,
        });
    } catch (error) {
        throw new AppError(error.message, StatusCodes.INTERNAL_SERVER_ERROR);
    }
};

const getPoolTotals = async (vendor_id, filters) => {
    const { clauses, replacements } = buildPlanScopeClause(filters);
    const query = `
        SELECT COALESCE(SUM(v.visibility_pool), 0) AS impressions, COALESCE(SUM(v.clicks), 0) AS clicks
        FROM ${ANALYTICS_DB}.visibility_pool_daily v
        JOIN oms_pi_details d ON d.id = v.pi_id
        JOIN oms_pi_products p ON p.pi_id = d.id AND p.product_id = v.product_id
        WHERE d.vendor_id = :vendor_id
          AND v.report_date BETWEEN :date_from AND :date_to
          ${filters.product_id ? "AND v.product_id = :product_id" : ""}
          ${clauses.map((c) => `AND ${c}`).join(" ")}
    `;
    const [row] = await sequelize.query(query, {
        replacements: { vendor_id, date_from: filters.date_from, date_to: filters.date_to, ...replacements },
        type: QueryTypes.SELECT,
    });
    return { impressions: Number(row.impressions), clicks: Number(row.clicks) };
};

const getLeadsCount = async (vendor_id, filters, extraWhere = "") => {
    const query = `
        SELECT COUNT(*) AS count
        FROM tbl_leads l
        WHERE l.vendor_id = :vendor_id
          AND l.created_at BETWEEN :date_from AND :date_to_end
          ${filters.product_id ? "AND l.product_id = :product_id" : ""}
          AND ${LEAD_VISIBILITY_CLAUSE}
          ${filters.plan_scope === "current" ? `AND ${CURRENT_PLAN_EXISTS_FOR_LEAD}` : ""}
          ${extraWhere}
    `;
    const [row] = await sequelize.query(query, {
        replacements: {
            vendor_id,
            date_from: filters.date_from,
            date_to_end: `${filters.date_to} 23:59:59`,
            product_id: filters.product_id,
        },
        type: QueryTypes.SELECT,
    });
    return Number(row.count);
};

const getOpportunitiesTotal = (vendor_id, filters) => getLeadsCount(vendor_id, filters);

const getDemoRequestsTotal = (vendor_id, filters) =>
    getLeadsCount(vendor_id, filters, "AND l.user_intent = 'Demo'");

const pctChange = (current, previous) => {
    if (previous === 0) return current === 0 ? 0 : null;
    return Number((((current - previous) / previous) * 100).toFixed(1));
};

/**
 * KPI card summary: impressions, clicks, opportunities, and demo requests
 * for the range, each with a comparison against the immediately preceding
 * period of equal length.
 */
export const getSummary = async (vendor_id, filters) => {
    const prev = previousPeriod(filters.date_from, filters.date_to);
    const prevFilters = { ...filters, ...prev };

    const [pool, prevPool, opportunities, prevOpportunities, demoRequests, prevDemoRequests] = await Promise.all([
        getPoolTotals(vendor_id, filters),
        getPoolTotals(vendor_id, prevFilters),
        getOpportunitiesTotal(vendor_id, filters),
        getOpportunitiesTotal(vendor_id, prevFilters),
        getDemoRequestsTotal(vendor_id, filters),
        getDemoRequestsTotal(vendor_id, prevFilters),
    ]);

    return {
        impressions: {
            value: pool.impressions,
            previous_value: prevPool.impressions,
            change_pct: pctChange(pool.impressions, prevPool.impressions),
        },
        clicks: {
            value: pool.clicks,
            previous_value: prevPool.clicks,
            change_pct: pctChange(pool.clicks, prevPool.clicks),
        },
        opportunities: {
            value: opportunities,
            previous_value: prevOpportunities,
            change_pct: pctChange(opportunities, prevOpportunities),
        },
        demo_requests: {
            value: demoRequests,
            previous_value: prevDemoRequests,
            change_pct: pctChange(demoRequests, prevDemoRequests),
        },
        compared_to: prev,
    };
};

/**
 * Daily impressions + clicks trend (visibility_pool_daily), one row per
 * report_date. clicks is visibility_pool_daily.clicks - a day-driven
 * click-through-rate estimate computed in tj-impressions-app
 * (job/visibilityEngine.js), not a directly tracked click event.
 */
export const getImpressionsTrend = async (vendor_id, filters) => {
    try {
        const { clauses, replacements } = buildPlanScopeClause(filters);
        const query = `
            SELECT v.report_date AS date, SUM(v.visibility_pool) AS impressions, SUM(v.clicks) AS clicks
            FROM ${ANALYTICS_DB}.visibility_pool_daily v
            JOIN oms_pi_details d ON d.id = v.pi_id
            JOIN oms_pi_products p ON p.pi_id = d.id AND p.product_id = v.product_id
            WHERE d.vendor_id = :vendor_id
              AND v.report_date BETWEEN :date_from AND :date_to
              ${filters.product_id ? "AND v.product_id = :product_id" : ""}
              ${clauses.map((c) => `AND ${c}`).join(" ")}
            GROUP BY v.report_date
            ORDER BY v.report_date
        `;
        const rows = await sequelize.query(query, {
            replacements: { vendor_id, date_from: filters.date_from, date_to: filters.date_to, ...replacements },
            type: QueryTypes.SELECT,
        });

        const series = rows.map((r) => ({
            date: r.date,
            impressions: Number(r.impressions),
            clicks: Number(r.clicks),
        }));
        const total_impressions = series.reduce((sum, r) => sum + r.impressions, 0);
        const peak_daily_impressions = series.reduce((max, r) => Math.max(max, r.impressions), 0);
        const total_clicks = series.reduce((sum, r) => sum + r.clicks, 0);
        const peak_daily_clicks = series.reduce((max, r) => Math.max(max, r.clicks), 0);

        return { series, total_impressions, peak_daily_impressions, total_clicks, peak_daily_clicks };
    } catch (error) {
        throw new AppError(error.message, StatusCodes.INTERNAL_SERVER_ERROR);
    }
};

/**
 * Opportunities (leads) trend, bucketed either daily (one point per
 * report_date) or weekly (Monday-start weeks, the default).
 */
export const getOpportunitiesTrend = async (vendor_id, filters) => {
    try {
        const isDaily = filters.bucket === "daily";
        const periodStartExpr = isDaily
            ? "DATE(l.created_at)"
            : "DATE_SUB(DATE(l.created_at), INTERVAL WEEKDAY(l.created_at) DAY)";
        const query = `
            SELECT
                ${periodStartExpr} AS period_start,
                COUNT(*) AS count
            FROM tbl_leads l
            WHERE l.vendor_id = :vendor_id
              AND l.created_at BETWEEN :date_from AND :date_to_end
              ${filters.product_id ? "AND l.product_id = :product_id" : ""}
              AND ${LEAD_VISIBILITY_CLAUSE}
              ${filters.plan_scope === "current" ? `AND ${CURRENT_PLAN_EXISTS_FOR_LEAD}` : ""}
            GROUP BY period_start
            ORDER BY period_start
        `;
        const rows = await sequelize.query(query, {
            replacements: {
                vendor_id,
                date_from: filters.date_from,
                date_to_end: `${filters.date_to} 23:59:59`,
                product_id: filters.product_id,
            },
            type: QueryTypes.SELECT,
        });

        const series = rows.map((r) => {
            const start = new Date(r.period_start);
            const end = new Date(start);
            end.setDate(end.getDate() + (isDaily ? 0 : 6));
            return {
                period_start: r.period_start,
                period_end: end.toISOString().split("T")[0],
                count: Number(r.count),
            };
        });

        return { series, bucket: isDaily ? "daily" : "weekly" };
    } catch (error) {
        throw new AppError(error.message, StatusCodes.INTERNAL_SERVER_ERROR);
    }
};
