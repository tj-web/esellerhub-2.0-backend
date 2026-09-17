import { v4 as uuidv4 } from "uuid";
export const AWS_paths = () => {
  //Base URL
  const AWS_PATH = process.env.AWS_PATH;
  const AWS_PATH_WEB = `${AWS_PATH}web`;
    const AWS_UPLOAD_WEB = "/web";
    const AWS_BRAND_IMAGES = `${AWS_UPLOAD_WEB}/assets/images/techjockey/brands/}`
  /* upload and fetch path of eseller and web and manage */
  const AWS_FETCH_PRODUCT_IMAGES = `${AWS_PATH_WEB}/assets/images/techjockey/products/`;
  const DIR_FS_PRODUCT_NOIMAGE = `${AWS_PATH}assets/images/techjockey/no-image.png`;
  return {
    AWS_PATH,
    AWS_PATH_WEB,
    AWS_FETCH_PRODUCT_IMAGES,
    DIR_FS_PRODUCT_NOIMAGE,
    AWS_BRAND_IMAGES,
  };
};

// AES-128-CBC key/IV for autoLogin link tokens, matching the legacy PHP encode/decodeData.
// As of now hardcoded to match the PHP-issued value; move to a secret store when rotated.
export const AUTOLOGIN_CIPHER_KEY = "9sqrEgP2JlbAijGZMH1fssfx0Lc9744Y";
export const AUTOLOGIN_CIPHER_IV = "9sqrEgP2JlbAijGZ";

// HS256 secret the legacy PHP eseller_app mobile client's session JWTs are signed with
// (Authlib::validate_jswt). As of now hardcoded to match the PHP-issued value.
export const ESELLER_APP_JWT_SECRET = "TokenByDeveloper";

export const EMAIL_DLQ_NAME = "email.dlx";

export const EMAIL_QUEUE_PRIORITY = {
  NORMAL: { routingKey: "email.normal", priority: "normal" },
  HIGH: { routingKey: "email.high", priority: "high" },
  LOW: { routingKey: "email.low", priority: "low" },
};

export const generateMessageId = () => uuidv4();
