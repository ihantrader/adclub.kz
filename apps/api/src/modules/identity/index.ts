export { IdentityModule } from "./identity.module";
export { identityTables } from "./schema";
export { LoginCodeService } from "./login-code/login-code.service";
export type { VerifiedPhone } from "./login-code/login-code.service";
export {
  LoginCodeChannels,
  LoginCodeDeliveryError,
} from "./login-code/channels/login-code-channels";
export { TestLoginCodeChannels } from "./login-code/channels/test-login-code-channels";
export { DevLoginCodeOutbox } from "./login-code/channels/dev-login-code-outbox";
export { DEV_LOGIN_CODE_OUTBOX_PATH } from "./login-code/dev-login-code-outbox.controller";
export {
  ConfigLoginCodeSettingsSource,
  LoginCodeSettingsSource,
} from "./login-code/login-code-settings.source";
