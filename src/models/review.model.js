import { DataTypes } from "sequelize";
import sequelize from "../db/connection.js";

const Review = sequelize.define(
  "Review",
  {
    review_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },

    category_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    subcategory_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    name: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },

    email: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },

    features_rating: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },

    value_money_rating: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },

    ease_use_rating: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },

    support_rating: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },

    rating: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },

    title: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },

    pros: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    cons: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    description: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    image: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },

    prod_familiarity: {
      type: DataTypes.STRING(30),
      allowNull: false,
    },

    prod_duration: {
      type: DataTypes.STRING(30),
      allowNull: false,
    },

    customer_type: {
      type: DataTypes.ENUM(
        "User",
        "Administrator",
        "Manager",
        "Decision Maker",
        "Director",
        "Associate",
        "Executive",
        "VP",
        "President",
        "Owner"
      ),
      allowNull: false,
    },

    software_recomm: {
      type: DataTypes.TINYINT,
      allowNull: false,
    },

    industry: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    company_size: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },

    previously_using_software: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },

    previous_product: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },

    product_reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    social_opt_in: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 1,
    },

    offer_selected_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    date_added: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    video_publish_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },

    date_modified: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    status: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },

    is_deleted: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },

    source: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },

    show_on_pdp: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },

    show_on_first_fold_pdp: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },

    reject_reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    review_url: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },

    sort_order: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },

    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },

    // social_profile: {
    //   type: DataTypes.STRING(20),
    //   allowNull: true,
    // },

    review_type: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 1,
    },
  },
  {
    tableName: "tbl_review",
    timestamps: false,
  }
);

export default Review;
