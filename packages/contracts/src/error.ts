import { z } from "zod";
import { clientPlatformSchema } from "./client";

/**
 * Machine-readable error codes shared by every endpoint (ARCHITECTURE 7.1).
 *
 * - `LOGIN_CODE_INVALID` (400): wrong code; `details` is
 *   `LoginCodeInvalidDetails`.
 * - `LOGIN_CODE_EXPIRED` (400): no code is accepted for this number any
 *   more (expired, already used, attempts exhausted, replaced by a newer
 *   one, or never sent) — request a new one.
 * - `LOGIN_CODE_DELIVERY_FAILED` (503, retryable): no channel delivered
 *   the code.
 * - `RATE_LIMITED` (429, retryable): `details` is `RateLimitedDetails`.
 * - `SERVICE_UNAVAILABLE` (503, retryable): a dependency the request
 *   needs is down; try again later. Never a reason to sign the user out.
 * - `ACCESS_TOKEN_EXPIRED` (401): the access token is past its lifetime —
 *   exchange the refresh token (`POST /auth/session/refresh`) and repeat.
 * - `AUTH_REQUIRED` (401): no usable credentials (no token, or a
 *   malformed, forged or foreign one) — sign in.
 * - `SESSION_ENDED` (401): the session was ended (logout, ended from
 *   another device, refresh token reuse) or expired — sign in again and
 *   wipe local data of the account.
 * - `SESSION_KIND_UNAVAILABLE` (403): this client can't get a session this
 *   way. Was returned to cabinet and admin panel sign-ins before TASK-006;
 *   no longer returned, kept for compatibility.
 * - `ORIGIN_NOT_ALLOWED` (403): a browser request from a site that isn't
 *   one of the web clients, or a cookie-based request without a trusted
 *   `Origin`.
 * - `NOT_SUPPLIER_MEMBER` (403): the number isn't an active employee of any
 *   company — the code was checked and spent; show "this number is not
 *   linked to a supplier cabinet" (SCREENS S-AUTH-01/02).
 * - `NOT_ADMIN` (403): the number isn't an administrator — the code was
 *   checked and spent.
 * - `SUPPLIER_SELECTION_REQUIRED` (403): the number works for several
 *   companies; `details` is `SupplierSelectionRequiredDetails`.
 * - `TOTP_SETUP_REQUIRED` (403): the administrator must set up the
 *   authenticator app first; `details` is `TotpStepRequiredDetails`.
 * - `TOTP_REQUIRED` (403): enter the code from the authenticator app or a
 *   backup code; `details` is `TotpStepRequiredDetails`.
 * - `TOTP_INVALID` (400): wrong, already used or out-of-time code from the
 *   authenticator app, or a backup code that isn't valid (any more).
 * - `SIGN_IN_STEP_INVALID` (401): the unfinished sign-in is unknown,
 *   expired or already used — start again with a new code.
 * - `SUPPLIER_ACCESS_CLOSED` (401): the employee was removed from the
 *   company of this cabinet session; the session is over — show "access to
 *   the cabinet is closed" (SCREENS 6.0).
 * - `FORBIDDEN` (403): this session can't use this route (e.g. a mobile app
 *   session calling an admin route); signing in again won't change that.
 * - `TOTP_SELF_RESET_FORBIDDEN` (403): an administrator can't reset their
 *   own second factor — another administrator has to.
 * - `SETTING_VERSION_CONFLICT` (409): the setting was changed by someone
 *   else since the version the change was made from; nothing was written.
 *   `details` is `SettingVersionConflictDetails` — reload and decide again.
 * - `SETTING_OPERATOR_ONLY` (403): a sign-in security setting; only the
 *   server operator command changes it (D-053).
 *
 * The catalog structure (TASK-010, ARCHITECTURE 4.15):
 * - `CATALOG_VERSION_CONFLICT` (409): the category, attribute or option was
 *   changed by someone else since the version the change was made from;
 *   nothing was written. `details` is `CatalogVersionConflictDetails`.
 * - `CATALOG_CODE_TAKEN` (409): the code is already used (categories —
 *   anywhere; attributes — in the category; options — in the attribute).
 * - `CATALOG_NAME_TAKEN` (409): a sibling already has this name in this
 *   language, ignoring case; `details` is `CatalogNameTakenDetails`.
 * - `CATALOG_DEPTH_EXCEEDED` (400): the parent is a subcategory — there
 *   are two levels only.
 * - `CATALOG_KIND_MISMATCH` (400): the parent is of the other kind (goods /
 *   services), or the kind of a category was asked to change.
 * - `CATALOG_LEVEL_IMMUTABLE` (400): a node can't become a subcategory and
 *   a subcategory can't become a node.
 * - `CATALOG_PARENT_ARCHIVED` (409): the node is archived — restore it (or
 *   choose another node) first.
 * - `CATALOG_NOT_SUBCATEGORY` (400): only a subcategory has attributes.
 * - `CATALOG_ATTRIBUTE_TYPE_IMMUTABLE` (400): the value type of an
 *   attribute never changes — archive it and create another one.
 * - `CATALOG_ORDER_MISMATCH` (409): the new order doesn't name every
 *   sibling exactly once (someone may have added one meanwhile) — reload.
 * - `CATALOG_ORDER_CONFLICT` (409): the siblings were reordered by someone
 *   else since the order the change was made from (`expectedOrder`);
 *   nothing was written. `details` is `CatalogOrderConflictDetails`.
 *
 * Items of the catalog (TASK-011, ARCHITECTURE 4.17):
 * - `CATALOG_BRAND_SPELLING_TAKEN` (409): another brand already has this
 *   name or spelling (case and spaces ignored); `details` is
 *   `CatalogBrandSpellingTakenDetails`.
 * - `CATALOG_BRAND_ARCHIVED` (409): an archived brand can't be chosen.
 * - `CATALOG_CATEGORY_ARCHIVED` (409): an archived subcategory (or one of an
 *   archived node) can't take items.
 * - `CATALOG_ITEM_DUPLICATE` (409): «Такая позиция уже есть» — the same
 *   brand and article, or a product with the same brand and identifying
 *   values in the category; `details` is `CatalogItemDuplicateDetails`.
 * - `CATALOG_ITEM_TYPE_IMMUTABLE` (400): the type of an item never changes.
 * - `CATALOG_ITEM_HAS_ANALOGS` (409): an item with analogs stays in its
 *   subcategory — remove the links first.
 * - `CATALOG_VALUES_REJECTED` (400; 409 when a value was changed by someone
 *   else meanwhile): nothing was written; `details` is
 *   `CatalogValuesRejectedDetails` with every refused value.
 * - `CATALOG_ANALOG_INVALID` (400): `details` is
 *   `CatalogAnalogInvalidDetails`.
 * - `CONFLICT` (409, retryable): a brand's spelling or an item's article was
 *   refused by the unique key while no other brand or item has it any more
 *   (the rival change was rolled back meanwhile); nothing was written,
 *   repeating the request decides it (TASK-011.A).
 * - `TRANSLATION_MANUALLY_EDITED` (409): "translate again" was asked for a
 *   text an administrator wrote by hand — automatic translation never
 *   overwrites it; release the manual edit first (TASK-012).
 * - `TRANSLATION_NOT_MANUAL` (409): the manual edit to release isn't one
 *   (the text is automatic).
 *
 * Photos of items (TASK-013, ARCHITECTURE 4.22):
 * - `CATALOG_PHOTO_INVALID` (400): the uploaded bytes are not a picture the
 *   catalog takes — the content is looked at, not the name or the declared
 *   type; `details` is `CatalogPhotoInvalidDetails`. A file above the size
 *   limit comes back as `PAYLOAD_TOO_LARGE` (413).
 * - `CATALOG_PHOTO_NOT_APPROVED` (409): only an approved photo is the
 *   primary one or takes a place in the order.
 * - `CATALOG_PHOTO_FILES_DELETED` (409): the files of this photo were
 *   removed after their retention — nothing brings it back, upload again.
 *
 * The vehicle catalog (TASK-014, ARCHITECTURE 4.24):
 * - `VEHICLE_VERSION_CONFLICT` (409): the record was changed by someone
 *   else since the version the change was made from; nothing was written.
 *   `details` is `VehicleVersionConflictDetails`.
 * - `VEHICLE_DUPLICATE` (409): «Такая запись уже есть» — a make or model
 *   with this name or spelling, a generation with this name, an engine
 *   with this code, an option with this code or name, or a modification
 *   with the same set of values; `details` is `VehicleDuplicateDetails`.
 * - `VEHICLE_PARENT_ARCHIVED` (409): the make, model or generation above is
 *   archived — restore it (or choose another one) first.
 * - `VEHICLE_REFERENCE_ARCHIVED` (409): an archived engine or option can't
 *   be chosen; `details` is `VehicleReferenceArchivedDetails`.
 * - `VEHICLE_YEARS_INVALID` (400): `details` is `VehicleYearsInvalidDetails`.
 * - `VEHICLE_IMPORT_FILE_INVALID` (400): the import file can't be taken;
 *   `details` is `VehicleImportFileInvalidDetails`.
 * - `VEHICLE_IMPORT_STATE` (409): the import isn't in a state that allows
 *   this (applied twice, cancelled after it started to apply…); `details`
 *   is `VehicleImportStateDetails`.
 *
 * Compatibility of items with cars (TASK-015, ARCHITECTURE 4.25):
 * - `COMPATIBILITY_CONDITIONS_INVALID` (400): the levels of a record or a
 *   proposal don't hold together; `details` is
 *   `CompatibilityConditionsInvalidDetails`.
 * - `COMPATIBILITY_VEHICLE_INVALID` (400): the car of a check doesn't hold
 *   together; `details` is `CompatibilityVehicleInvalidDetails`.
 * - `COMPATIBILITY_VERSION_CONFLICT` (409): the record was changed by
 *   someone else; nothing was written. `details` is
 *   `CompatibilityVersionConflictDetails`.
 * - `COMPATIBILITY_DUPLICATE` (409): the item already has an approved
 *   record with these conditions; `details` is `CompatibilityDuplicateDetails`.
 * - `COMPATIBILITY_NOT_APPLICABLE` (409): compatibility isn't kept for
 *   services.
 * - `COMPATIBILITY_ITEM_ARCHIVED` (409): the item is archived.
 * - `COMPATIBILITY_NOT_ANALOG` (409): compatibility is copied only from an
 *   analog of the item.
 * - `COMPATIBILITY_PROPOSAL_STATE` (409): the proposal was already
 *   reviewed; `details` is `CompatibilityProposalStateDetails`.
 * - `COMPATIBILITY_PROPOSAL_DUPLICATE` (409): the company already waits
 *   on the same proposal for this item.
 *
 * Cities and suppliers (TASK-016, ARCHITECTURE 4.26):
 * - `CITY_VERSION_CONFLICT` (409): the city was changed by someone else;
 *   `details` is `SupplierVersionConflictDetails` — reload and decide again.
 * - `CITY_DUPLICATE` (409): another city has this code or name (case
 *   ignored); `details` is `CityDuplicateDetails`.
 * - `CITY_ORDER_MISMATCH` (409): the new order doesn't name every city
 *   exactly once — reload.
 * - `CITY_ARCHIVED` (409): an archived city can't be chosen for a request
 *   or a supplier — restore it or choose another.
 * - `SUPPLIER_VERSION_CONFLICT` (409): the request or the supplier was
 *   changed by someone else; `details` is `SupplierVersionConflictDetails`.
 * - `SUPPLIER_BIN_TAKEN` (409): a supplier with this БИН exists — one БИН,
 *   one supplier; `details` is `SupplierBinTakenDetails`.
 * - `SUPPLIER_LEAD_STATE` (409): the request can't do this in its status;
 *   `details` is `SupplierLeadStateDetails`.
 * - `SUPPLIER_STATE` (409): nothing to lift (or already blocked);
 *   `details` is `SupplierStateDetails`.
 *
 * Employees of a supplier (TASK-017, ARCHITECTURE 4.27):
 * - `SUPPLIER_LAST_MEMBER` (409): the company must keep at least one
 *   active employee — add another before removing this one.
 * - `SUPPLIER_MEMBER_EXISTS` (409): the number already has a membership in
 *   this company; `details` is `SupplierMemberExistsDetails`.
 * - `SUPPLIER_MEMBER_STATE` (409): the employee can't do this in their
 *   status; `details` is `SupplierMemberStateDetails`.
 * - `SUPPLIER_NOTIFICATION_LIMIT` (409): as many employees as the setting
 *   `max_notified_members` already have notifications on; `details` is
 *   `SupplierNotificationLimitDetails`.
 *
 * Offers of suppliers (TASK-018, ARCHITECTURE 4.28):
 * - `OFFER_EXISTS` (409): the pickup point already has an offer on this
 *   item (on sale or withdrawn — return it instead); `details` is
 *   `OfferExistsDetails`.
 * - `OFFER_VERSION_CONFLICT` (409): the offer was changed by someone
 *   else; `details` is `OfferVersionConflictDetails` — reload and decide again.
 * - `OFFER_STATE` (409): the offer can't do this in its status (withdraw
 *   one that isn't on sale, return one that isn't withdrawn); `details`
 *   is `OfferStateDetails`.
 * - `OFFER_PICKUP_NEEDS_ADDRESS` (409): pickup needs the address of the
 *   pickup point — fill it in on the company card first.
 * - `OFFER_NOT_APPLICABLE` (409): offers on services come with TASK-019.
 * - `OFFER_ITEM_UNAVAILABLE` (409): the item is no longer active in the
 *   catalog; the offer stays, but can't be returned to sale.
 *
 * The request itself, not its data (TASK-009.A; before it, all of these
 * came back as `VALIDATION_ERROR`, which is only for data that fails the
 * route's schema):
 * - `MALFORMED_REQUEST` (400): the body can't be read at all (not valid
 *   JSON, a broken length).
 * - `METHOD_NOT_ALLOWED` (405): the path exists, the method doesn't; the
 *   `Allow` header lists the methods it takes.
 * - `NOT_ACCEPTABLE` (406), `REQUEST_TIMEOUT` (408, retryable), `GONE`
 *   (410), `PAYLOAD_TOO_LARGE` (413), `URI_TOO_LONG` (414),
 *   `UNSUPPORTED_MEDIA_TYPE` (415 — the body isn't JSON, or in an encoding
 *   the API doesn't take).
 * - `REQUEST_REJECTED`: any other 4xx without a code of its own.
 *
 * Extended as real endpoints need more specific codes (e.g.
 * `SUBSCRIPTION_REQUIRED`, `ORDER_STATE_CONFLICT` in later tasks). Values
 * are only ever added: clients must treat a code they don't know as a
 * generic error (ARCHITECTURE 7.4), which `@adclub/api-client` does.
 */
export const errorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR",
  "CLIENT_UPDATE_REQUIRED",
  // Login codes (TASK-004, ARCHITECTURE 8.1).
  "LOGIN_CODE_INVALID",
  "LOGIN_CODE_EXPIRED",
  "LOGIN_CODE_DELIVERY_FAILED",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  // Sessions (TASK-005, ARCHITECTURE 8.2).
  "ACCESS_TOKEN_EXPIRED",
  "AUTH_REQUIRED",
  "SESSION_ENDED",
  "SESSION_KIND_UNAVAILABLE",
  "ORIGIN_NOT_ALLOWED",
  // Roles and contexts (TASK-006, ARCHITECTURE 8.1, 8.3).
  "NOT_SUPPLIER_MEMBER",
  "NOT_ADMIN",
  "SUPPLIER_SELECTION_REQUIRED",
  "TOTP_SETUP_REQUIRED",
  "TOTP_REQUIRED",
  "TOTP_INVALID",
  "SIGN_IN_STEP_INVALID",
  "SUPPLIER_ACCESS_CLOSED",
  "FORBIDDEN",
  "TOTP_SELF_RESET_FORBIDDEN",
  // Settings (TASK-007, ARCHITECTURE 14).
  "SETTING_VERSION_CONFLICT",
  "SETTING_OPERATOR_ONLY",
  // Catalog structure (TASK-010, ARCHITECTURE 4.15).
  "CATALOG_VERSION_CONFLICT",
  "CATALOG_CODE_TAKEN",
  "CATALOG_NAME_TAKEN",
  "CATALOG_DEPTH_EXCEEDED",
  "CATALOG_KIND_MISMATCH",
  "CATALOG_LEVEL_IMMUTABLE",
  "CATALOG_PARENT_ARCHIVED",
  "CATALOG_NOT_SUBCATEGORY",
  "CATALOG_ATTRIBUTE_TYPE_IMMUTABLE",
  "CATALOG_ORDER_MISMATCH",
  "CATALOG_ORDER_CONFLICT",
  // Catalog items (TASK-011, ARCHITECTURE 4.17).
  "CATALOG_BRAND_SPELLING_TAKEN",
  "CATALOG_BRAND_ARCHIVED",
  "CATALOG_CATEGORY_ARCHIVED",
  "CATALOG_ITEM_DUPLICATE",
  "CATALOG_ITEM_TYPE_IMMUTABLE",
  "CATALOG_ITEM_HAS_ANALOGS",
  "CATALOG_VALUES_REJECTED",
  "CATALOG_ANALOG_INVALID",
  // Translations of the catalog's texts (TASK-012, ARCHITECTURE 4.19).
  "TRANSLATION_MANUALLY_EDITED",
  "TRANSLATION_NOT_MANUAL",
  // Photos of items (TASK-013, ARCHITECTURE 4.22).
  "CATALOG_PHOTO_INVALID",
  "CATALOG_PHOTO_NOT_APPROVED",
  "CATALOG_PHOTO_FILES_DELETED",
  // The vehicle catalog (TASK-014, ARCHITECTURE 4.24).
  "VEHICLE_VERSION_CONFLICT",
  "VEHICLE_DUPLICATE",
  "VEHICLE_PARENT_ARCHIVED",
  "VEHICLE_REFERENCE_ARCHIVED",
  "VEHICLE_YEARS_INVALID",
  "VEHICLE_IMPORT_FILE_INVALID",
  "VEHICLE_IMPORT_STATE",
  // Compatibility of items with cars (TASK-015, ARCHITECTURE 4.25).
  "COMPATIBILITY_CONDITIONS_INVALID",
  "COMPATIBILITY_VEHICLE_INVALID",
  "COMPATIBILITY_VERSION_CONFLICT",
  "COMPATIBILITY_DUPLICATE",
  "COMPATIBILITY_NOT_APPLICABLE",
  "COMPATIBILITY_ITEM_ARCHIVED",
  "COMPATIBILITY_NOT_ANALOG",
  "COMPATIBILITY_PROPOSAL_STATE",
  "COMPATIBILITY_PROPOSAL_DUPLICATE",
  // Cities and suppliers (TASK-016, ARCHITECTURE 4.26).
  "CITY_VERSION_CONFLICT",
  "CITY_DUPLICATE",
  "CITY_ORDER_MISMATCH",
  "CITY_ARCHIVED",
  "SUPPLIER_VERSION_CONFLICT",
  "SUPPLIER_BIN_TAKEN",
  "SUPPLIER_LEAD_STATE",
  "SUPPLIER_STATE",
  // Employees of a supplier (TASK-017, ARCHITECTURE 4.27).
  "SUPPLIER_LAST_MEMBER",
  "SUPPLIER_MEMBER_EXISTS",
  "SUPPLIER_MEMBER_STATE",
  "SUPPLIER_NOTIFICATION_LIMIT",
  // Offers of suppliers (TASK-018, ARCHITECTURE 4.28).
  "OFFER_EXISTS",
  "OFFER_VERSION_CONFLICT",
  "OFFER_STATE",
  "OFFER_PICKUP_NEEDS_ADDRESS",
  "OFFER_NOT_APPLICABLE",
  "OFFER_ITEM_UNAVAILABLE",
  // The request itself (TASK-009.A, ARCHITECTURE 7.1).
  "MALFORMED_REQUEST",
  "METHOD_NOT_ALLOWED",
  "NOT_ACCEPTABLE",
  "REQUEST_TIMEOUT",
  "GONE",
  "PAYLOAD_TOO_LARGE",
  "URI_TOO_LONG",
  "UNSUPPORTED_MEDIA_TYPE",
  "REQUEST_REJECTED",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * Single error shape returned by every failed request, whatever the
 * cause: validation, a missing resource, a conflict or an unhandled
 * server error. Internal details (stack traces, driver errors) never go
 * into `details` — only information safe to show a client.
 */
export const apiErrorResponseSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
  retryable: z.boolean(),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/**
 * `details` of a `CLIENT_UPDATE_REQUIRED` error (HTTP 426). `message` of
 * that error is the localized update text from the client policy.
 */
export const clientUpdateRequiredDetailsSchema = z.object({
  platform: clientPlatformSchema,
  clientVersion: z.string(),
  minSupportedVersion: z.string(),
});

export type ClientUpdateRequiredDetails = z.infer<typeof clientUpdateRequiredDetailsSchema>;
