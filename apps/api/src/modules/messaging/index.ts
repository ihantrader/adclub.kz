export { MessagingJobsModule, MessagingModule } from "./messaging.module";
export type { MessagingModuleOptions } from "./messaging.module";
export {
  isTemporaryFailure,
  MessageChannel,
  MessageDeliveryError,
  TEMPORARY_FAILURES,
} from "./message-channel";
export type { MessageFailureKind, MessageSendRequest, MessageSendResult } from "./message-channel";
export { TestMessageChannel } from "./test-message-channel";
export { failureOf as whatsappFailureOf, WhatsappCloudChannel } from "./whatsapp-cloud-channel";
export {
  checkTemplateRegistry,
  isMessageTemplateKey,
  KK_LENGTH_RATIO_MAX,
  MESSAGE_LANGUAGES,
  MessageRenderError,
  messageTemplate,
  messageTemplates,
  orderedVariables,
  placeholdersOf,
  renderMessageText,
  TEMPLATE_BODY_MAX_LENGTH,
  TEMPLATE_BUTTON_TITLE_MAX_LENGTH,
} from "./message-templates";
export type {
  MessageLang,
  MessageTemplateButton,
  MessageTemplateDefinition,
  MessageTemplateKey,
} from "./message-templates";
export { deliveryTransition, MessageNotFoundError, Messaging } from "./messaging.service";
export type { DeliveryStatus, QueuedMessage, QueueMessageInput } from "./messaging.service";
export { MessageSubjects } from "./message-subjects";
export type { MessageOutcome, MessageSubject } from "./message-subjects";
export { MessageSender } from "./message-sender";
export {
  applyWebhookEventJob,
  messageRecoveryJob,
  messageVariablesCleanupJob,
  messagingJobCatalog,
  sendMessageJob,
  webhookEventCleanupJob,
} from "./message-jobs";
export { WebhookEvents } from "./webhook-events.service";
export { WebhookEventApplier } from "./webhook-apply.handler";
export { MessagingAdmin, MessagingCommandError } from "./messaging-admin";
export {
  isValidWebhookSignature,
  signWebhookBody,
  verifySubscription,
  WEBHOOK_SIGNATURE_HEADER,
  webhookEventId,
  webhookSignatureHeader,
} from "./webhook-signature";
export { DEV_MESSAGES_PATH } from "./dev-messages.controller";
export { messagingTables, outboundMessage } from "./schema";
export type { MessageStatus, OutboundMessageRow } from "./schema";
