import { DataTypes } from "sequelize";
import sequelize from "../db/connection.js";

const Vendor = sequelize.define(
  "Vendor",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },

    first_name: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },

    last_name: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },

    email: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },

    dial_code: {
      type: DataTypes.STRING(5),
      allowNull: false,
      defaultValue: "91",
    },

    phone: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },

    password: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },

    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    last_updated: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    hash_string: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },

    vendor_type: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },

    signup_progress: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    email_verified: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    status: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },

    admin_verified: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    is_deleted: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    verified_by: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    app_dec_comment: {
      type: DataTypes.TEXT,
    },

    show_popup_date: {
      type: DataTypes.DATE,
    },

    registration_source: {
      type: DataTypes.STRING(50),
    },

    last_login_date: {
      type: DataTypes.DATE,
    },

    is_temp: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    vendor_mode: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    show_current_plan_data: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    acc_manager_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    trusted_seller: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    particular_score: {
      type: DataTypes.FLOAT(4, 1),
      allowNull: false,
      defaultValue: 0.0,
    },

    total_reviews: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    linkedin_id: {
      type: DataTypes.STRING(255),
    },

    creation_source: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },

    created_by: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    training_status: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    lead_insight_display: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 2,
    },
  },
  {
    tableName: "vendors",
    timestamps: false,
  }
);

export default Vendor;
