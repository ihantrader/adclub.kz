import { ApiException } from "../../../common/errors";

const bearer = (error: string) => ({
  "WWW-Authenticate": `Bearer realm="adclub", error="${error}"`,
});

/** 401 `AUTH_REQUIRED`: no usable credentials — sign in. The reason stays in the log. */
export function authRequiredException(): ApiException {
  return new ApiException(401, "AUTH_REQUIRED", "Sign in to continue", {
    headers: bearer("invalid_token"),
  });
}

/** 401 `ACCESS_TOKEN_EXPIRED`: refresh the token pair and repeat the request. */
export function accessTokenExpiredException(): ApiException {
  return new ApiException(401, "ACCESS_TOKEN_EXPIRED", "The access token has expired", {
    headers: bearer("invalid_token"),
  });
}

/** 401 `SESSION_ENDED`: the session was ended or expired — sign in again. */
export function sessionEndedException(): ApiException {
  return new ApiException(401, "SESSION_ENDED", "The session has ended, sign in again", {
    headers: bearer("invalid_token"),
  });
}

/**
 * 401 `SUPPLIER_ACCESS_CLOSED`: the employee was removed from the company
 * of this cabinet session; the session is over (SCREENS 6.0).
 */
export function supplierAccessClosedException(): ApiException {
  return new ApiException(
    401,
    "SUPPLIER_ACCESS_CLOSED",
    "Access to the supplier cabinet is closed",
    { headers: bearer("invalid_token") },
  );
}

/** 403 `FORBIDDEN`: the session's context doesn't serve this route. */
export function forbiddenException(): ApiException {
  return new ApiException(403, "FORBIDDEN", "This session can't use this route");
}

/** 403 `NOT_SUPPLIER_MEMBER`: the code was spent, the number has no active membership. */
export function notSupplierMemberException(): ApiException {
  return new ApiException(
    403,
    "NOT_SUPPLIER_MEMBER",
    "This number is not linked to a supplier cabinet",
  );
}

/** 403 `NOT_ADMIN`: the code was spent, the number is not an administrator. */
export function notAdminException(): ApiException {
  return new ApiException(403, "NOT_ADMIN", "This number is not an administrator");
}

/** 401 `SIGN_IN_STEP_INVALID`: unknown, expired or used step — sign in again. */
export function signInStepInvalidException(): ApiException {
  return new ApiException(
    401,
    "SIGN_IN_STEP_INVALID",
    "This sign-in is no longer valid, start again",
  );
}

/** 400 `TOTP_INVALID`: the second factor code isn't accepted. */
export function totpInvalidException(): ApiException {
  return new ApiException(400, "TOTP_INVALID", "The code is incorrect");
}

/** 403 `ORIGIN_NOT_ALLOWED`: a cookie session request not from its web client's origin. */
export function cookieOriginNotAllowedException(): ApiException {
  return new ApiException(
    403,
    "ORIGIN_NOT_ALLOWED",
    "Cookie sessions can only be used from the web client's own site",
  );
}
