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

/** 403 `SESSION_KIND_UNAVAILABLE`: this client can't get a session by code yet (D-025). */
export function sessionKindUnavailableException(): ApiException {
  return new ApiException(
    403,
    "SESSION_KIND_UNAVAILABLE",
    "Sign-in to the supplier cabinet and the admin panel is not available yet",
  );
}

/** 403 `ORIGIN_NOT_ALLOWED`: a cookie session request not from its web client's origin. */
export function cookieOriginNotAllowedException(): ApiException {
  return new ApiException(
    403,
    "ORIGIN_NOT_ALLOWED",
    "Cookie sessions can only be used from the web client's own site",
  );
}
