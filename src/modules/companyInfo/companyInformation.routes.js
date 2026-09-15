import express from "express";
import multer from "multer";
import { getCompanyInfo, searchLocation, saveAccountInfo } from "./companyInformation.controller.js";

const router = express.Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

router.get("/", getCompanyInfo);
router.get("/search-location", searchLocation);
router.post("/save-account-info", upload.fields([
  { name: 'gst_document', maxCount: 1 },
  { name: 'pan_document', maxCount: 1 }
]), saveAccountInfo);

export default router;
