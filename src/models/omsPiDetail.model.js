import { DataTypes } from "sequelize";
import sequelize from "../db/connection.js";

const OmsPiDetail = sequelize.define(
  "OmsPiDetail",
  {
    id: {
      type: DataTypes.INTEGER(10).UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    pi_no: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    parent_pi_id: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    account_type: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    brand_id: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    brand_name: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    category_id: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    category_name: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    hsn_code: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    vendor_id: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    vendor_name: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    vendor_email: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    vendor_phone: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    plan_type: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    plan_name: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    payment_term: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    inventory_sold: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    base_amount: {
      type: DataTypes.DOUBLE(16, 2),
      allowNull: true,
    },
    discount: {
      type: DataTypes.DOUBLE(16, 2),
      allowNull: true,
    },
    amount: {
      type: DataTypes.DOUBLE(16, 2),
      allowNull: true,
    },
    gst_rate: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    cgst_amount: {
      type: DataTypes.DOUBLE(15, 2),
      allowNull: true,
    },
    sgst_amount: {
      type: DataTypes.DOUBLE(15, 2),
      allowNull: true,
    },
    igst_amount: {
      type: DataTypes.DOUBLE(15, 2),
      allowNull: true,
    },
    tds_percent: {
      type: DataTypes.DECIMAL(4, 2),
      allowNull: false,
      defaultValue: 0.0,
    },
    total_amount: {
      type: DataTypes.DOUBLE(16, 2),
      allowNull: true,
    },
    adjusted_amount: {
      type: DataTypes.DOUBLE(16, 2),
      allowNull: true,
    },
    plan_days: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    start_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    end_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    billing_to: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    country_id: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    country_name: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    address: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    state: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    state_name: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    city: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    city_name: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    pincode: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    gstin_number: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    pan_number: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    doc_number: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    pi_status: {
      type: DataTypes.TINYINT(4),
      allowNull: true,
      defaultValue: 0,
    },
    pi_sent_to_vendor: {
      type: DataTypes.TINYINT(4),
      allowNull: true,
      defaultValue: 0,
    },
    created_by: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    edited_by: {
      type: DataTypes.INTEGER(11),
      allowNull: false,
    },
    lead_plan_id: {
      type: DataTypes.INTEGER(11),
      allowNull: false,
      defaultValue: 0,
    },
    total_lead: {
      type: DataTypes.DOUBLE(8, 2),
      allowNull: true,
      defaultValue: 0.0,
    },
    used_lead: {
      type: DataTypes.DOUBLE(8, 2),
      allowNull: true,
      defaultValue: 0.0,
    },
    max_lead_limit: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
      defaultValue: 0,
    },
    custom_lead_limit: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    daily_quota: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
      defaultValue: 0,
    },
    remark: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    internal_remark: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    deliverables: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    invoice_id: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    invoice_number: {
      type: DataTypes.STRING(60),
      allowNull: true,
    },
    invoice_date: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    invoice_doc: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    office_location_id: {
      type: DataTypes.INTEGER(11),
      allowNull: false,
    },
    post_sales_status: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    post_sales_member: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    renewal_manager: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    full_payment: {
      type: DataTypes.TINYINT(4),
      allowNull: true,
      defaultValue: 0,
    },
    renewal_opp_id: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    opp_id: {
      type: DataTypes.INTEGER(11),
      allowNull: true,
    },
    impressions: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    profile_visits: {
      type: DataTypes.STRING(191),
      allowNull: true,
    },
    blog_addon: {
      type: DataTypes.TINYINT(1),
      allowNull: false,
      defaultValue: 0,
    },
    blog_start_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    blog_end_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "oms_pi_details",
    timestamps: false,
  }
);

export default OmsPiDetail;
