import { DataTypes } from "sequelize";
import sequelize from "../db/connection.js";

const ProductImage = sequelize.define(
  "ProductImage",
  {
    image_id: {
      type: DataTypes.INTEGER(11),
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },

    product_id: {
      type: DataTypes.INTEGER(11),
      allowNull: false,
    },

    image: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },

    image_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },

    default: {
      type: DataTypes.TINYINT(1),
      allowNull: false,
      defaultValue: 0,
    },

    status: {
      type: DataTypes.TINYINT(1),
      allowNull: false,
      defaultValue: 1,
    }
  },
  {
    tableName: "tbl_product_image",
    timestamps: false, // Set to true if you have createdAt/updatedAt columns
  }
);

export default ProductImage;