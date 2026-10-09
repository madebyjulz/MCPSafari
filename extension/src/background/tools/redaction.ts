// Keeping credentials in tab URLs out of what the agent is shown.

// Bearer and session values are redacted before a tab URL leaves the
// extension. `code` is only treated as an OAuth code next to `state`;
// alone it is usually a SKU or coupon.
//
// Whole names rather than parts, deliberately. The pattern below requires an
// `=` straight after the name, which is what keeps `token_type=bearer` and
// `password_hint=cat` readable: both describe a secret rather than carrying
// one. Matching `token` as a substring redacts those too, and an agent shown
// `[redacted]` for a token's type learns nothing and loses something.
//
// The cost is that every spelling has to be listed. Bare `token` and `session`
// were missing, which are the two most ordinary names in the class this exists
// for, and the comment above already claimed session values were covered.
const SECRET_URL_PARAMS = [
  "access_token",
  "id_token",
  "refresh_token",
  "token",
  "client_secret",
  "secret",
  "api_key",
  "apikey",
  "api-key",
  "password",
  "passwd",
  "pwd",
  "session",
  "sessionid",
  "session_id",
  "sid",
  "jwt",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "signature",
  "sig",
  // Presigned S3 and CloudFront URLs, where the signature is the credential
  // and the whole URL is the thing worth not leaking.
  "x-amz-signature",
  "x-amz-security-token",
  "x-amz-credential",
];

export const redactUrlSecrets = (url: string | undefined): string => {
  if (!url) return "";

  // Only the query and fragment carry parameters; `&` is legal in a path.
  const start = url.search(/[?#]/);

  if (start === -1) return url;

  const tail = url.slice(start);
  const names = /[?&#]state(?=[=&#]|$)/i.test(tail) ? [...SECRET_URL_PARAMS, "code"] : SECRET_URL_PARAMS;
  const pattern = new RegExp(`([?&#](?:${names.join("|")})=)[^&#]*`, "gi");

  return url.slice(0, start) + tail.replace(pattern, "$1[redacted]");
};
