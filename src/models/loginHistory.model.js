import { DataTypes } from "sequelize";
import sequelize from "../db/connection.js";
 
const LoginHistory = sequelize.define(
  "LoginHistory",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    email_id: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    source: {
      type: DataTypes.ENUM("website", "eseller", "eseller_app", "eseller_applaunch"),
      allowNull: false,
    },
    login_via: {
      type: DataTypes.ENUM(
        "native_auth",
        "one_tap_login",
        "google_button",
        "fb_button",
        "autologin_link"
      ),
      defaultValue: "native_auth",
    },
    ip: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    device_id: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    login_status: {
      type: DataTypes.TINYINT,
      defaultValue: 0,
    },
    profile_id: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    auth_token: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    created_date: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    last_access: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "tbl_login_history",
    timestamps: false,
  }
);
 
export default LoginHistory;
