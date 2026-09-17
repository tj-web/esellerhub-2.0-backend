import crypto from "crypto";
import { AUTOLOGIN_CIPHER_KEY, AUTOLOGIN_CIPHER_IV } from "../config/constants.js";

export const generateToken = () => {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  return { token , hash };
};

export const hashPassword = (password) => {
  return crypto.createHash("md5").update(password).digest("hex");
};

// PHP's openssl_encrypt truncates an oversized key to the cipher's required length (16 bytes
// for AES-128-CBC) rather than hashing it, so we replicate that truncation here.
const getAutoLoginKey = () => Buffer.from(AUTOLOGIN_CIPHER_KEY, "utf8").subarray(0, 16);
const getAutoLoginIv = () => Buffer.from(AUTOLOGIN_CIPHER_IV, "utf8");

// PHP's openssl_encrypt/openssl_decrypt with options=0 already base64-encodes/decodes the
// ciphertext internally, and the legacy PHP code base64-encodes that result a second time
// before urlencoding it. We replicate that double base64 layer here for wire compatibility.
export const encodeData = (data) => {
  const cipher = crypto.createCipheriv("aes-128-cbc", getAutoLoginKey(), getAutoLoginIv());
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final(),
  ]);

  const innerBase64 = encrypted.toString("base64");
  const outerBase64 = Buffer.from(innerBase64, "utf8").toString("base64");
  return encodeURIComponent(outerBase64);
};

export const decodeData = (encoded) => {
  const innerBase64 = Buffer.from(decodeURIComponent(encoded), "base64").toString("utf8");
  const ciphertext = Buffer.from(innerBase64, "base64");

  const decipher = crypto.createDecipheriv("aes-128-cbc", getAutoLoginKey(), getAutoLoginIv());
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8"));
};

