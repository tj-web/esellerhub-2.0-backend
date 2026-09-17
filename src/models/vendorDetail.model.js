import { DataTypes } from "sequelize";
import sequelize from "../db/connection.js";

const VendorDetails = sequelize.define(
  "VendorDetails",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    vendor_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    designation: {
      type: DataTypes.STRING(200),
    },
    company: {
      type: DataTypes.STRING(250),
      allowNull: false,
      defaultValue: "",
    },
    company_address: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: "",
    },
    website: {
      type: DataTypes.STRING(250),
      allowNull: false,
      defaultValue: "",
    },
    country: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 99,
    },
    state: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    city: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    pincode: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    company_logo: {
      type: DataTypes.STRING(250),
      allowNull: false,
      defaultValue: "",
    },
    cont_prsn_name: {
      type: DataTypes.CHAR(50),
      allowNull: false,
      defaultValue: "",
    },
    cont_prsn_desg: {
      type: DataTypes.CHAR(50),
    },
    cont_prsn_email: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: "",
    },
    cont_prsn_phone: {
      type: DataTypes.BIGINT(20),
      allowNull: false,
      defaultValue: 0,
    },
    bank_name: {
      type: DataTypes.CHAR(50),
      allowNull: false,
      defaultValue: "",
    },
    branch_name: {
      type: DataTypes.CHAR(50),
      allowNull: false,
      defaultValue: "",
    },
    acc_holder_name: {
      type: DataTypes.CHAR(50),
      allowNull: false,
      defaultValue: "",
    },
    acc_number: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "",
    },
    ifsc_code: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "",
    },
    is_contact_person: {
      type: DataTypes.TINYINT(1),
      allowNull: false,
      defaultValue: 0,
    },
    head_office_address: {
      type: DataTypes.STRING(250),
      allowNull: false,
      defaultValue: "",
    },
    legal_entry_name: {
      type: DataTypes.STRING(250),
      allowNull: false,
      defaultValue: "",
    },
    gst_registration_type: {
      type: DataTypes.TINYINT(4),
      defaultValue: 0,
    },
    gst_number: {
      type: DataTypes.STRING(250),
      allowNull: false,
      defaultValue: "",
    },
    gst_document: {
      type: DataTypes.STRING(250),
    },
    msmed_act: {
      type: DataTypes.TINYINT(4),
    },
    hsn_number: {
      type: DataTypes.STRING(250),
      allowNull: false,
      defaultValue: "",
    },
    company_type: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: "",
    },
    billing_address: {
      type: DataTypes.TEXT,
    },
    billing_country: {
      type: DataTypes.INTEGER,
    },
    billing_state: {
      type: DataTypes.INTEGER,
    },
    billing_city: {
      type: DataTypes.INTEGER,
    },
    billing_pincode: {
      type: DataTypes.INTEGER,
    },
    pan_number: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: "",
    },
    pan_document: {
      type: DataTypes.STRING(250),
    },
    gstin: {
      type: DataTypes.STRING(120),
      allowNull: false,
      defaultValue: "",
    },
    callback_duration: {
      type: DataTypes.STRING(10),
    }
  },
  {
    tableName: "vendor_details",
    timestamps: false,
  }
);

export default VendorDetails;
