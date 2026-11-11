import { z } from "zod";
import { hiddenPhoneSchema } from "./account";
import { catalogLanguageSchema, localizedTextSchema } from "./catalog";
import { compatibilityVehicleSchema } from "./compatibility";
import { reviewAdminActorSchema } from "./reviews";
import { showcaseCitySchema, showcaseListItemSchema } from "./showcase";

/**
 * The AI Pilot assistant (TASK-062; PRODUCT 8.3; ARCHITECTURE 11, 4.85;
 * SCREENS M-AI-01, M-AI-02). A person writes; the server runs one turn of
 * the dialog — the model may only look things up with the tools over our
 * catalog and offers — and answers with the model's text (only text) and
 * the cards the server builds itself from the catalog. No item the tools
 * did not return in this dialog, and none that is not on sale now for this
 * car and city, is ever in an answer (grounding).
 *
 * A guest sends the device id the app made (as the photo recognitions,
 * TASK-057); a signed-in person is the account of the session.
 */

/** The longest message a person sends (characters). */
export const ASSISTANT_MESSAGE_MAX_CHARS = 1000;

/** At most this many quick replies to a question (SCREENS M-AI-01). */
export const ASSISTANT_QUESTION_OPTIONS_MAX = 6;

/**
 * What the person wants, as the model says it in the closing tool of a turn
 * (ARCHITECTURE 4.85): `pick_by_params` — an item by its parameters («нужно
 * масло»), `maintenance` — the scheduled service («ТО-2»), `symptom` — a
 * description of trouble («скрипит»), `other` — not what the assistant does.
 */
export const assistantIntentSchema = z.enum(["pick_by_params", "maintenance", "symptom", "other"]);

export type AssistantIntent = z.infer<typeof assistantIntentSchema>;

/**
 * `answer` — a final answer (cards, groups, or «В каталоге клуба пока нет
 * подходящего» — `notFound`); `question` — a clarifying question with quick
 * replies; `off_topic` — «Я помогаю только с подбором товаров и услуг
 * клуба»; `unavailable` — «AI Pilot сейчас недоступен…» (the provider or the
 * day's budget; the turn was not counted).
 */
export const assistantMessageKindSchema = z.enum([
  "answer",
  "question",
  "off_topic",
  "unavailable",
]);

export type AssistantMessageKind = z.infer<typeof assistantMessageKindSchema>;

/** Why `unavailable`: the provider could not answer, or a daily budget is spent. */
export const assistantUnavailableReasonSchema = z.enum(["provider", "budget", "guest_budget"]);

export type AssistantUnavailableReason = z.infer<typeof assistantUnavailableReasonSchema>;

/**
 * The car of the dialog (D-062: the assistant always works for a car): a
 * car of the signed-in person's garage by `carId`, or the levels as the
 * catalog takes them (a guest's car lives on the device). The make is the
 * least a car is.
 */
export const assistantCarSchema = z.union([
  z.object({ carId: z.uuid() }),
  compatibilityVehicleSchema,
]);

export type AssistantCar = z.infer<typeof assistantCarSchema>;

export const assistantMessageBodySchema = z.object({
  /** Left out — the first message of a new dialog. */
  dialogId: z.uuid().optional(),
  /** A guest's device (required for a guest; ignored with a session). */
  deviceId: z.uuid().optional(),
  text: z.string().min(1).max(ASSISTANT_MESSAGE_MAX_CHARS),
  car: assistantCarSchema,
  /** The chosen city; services are only ever by it. */
  cityId: z.uuid().optional(),
  /**
   * A guest's current mileage of the car, km, as the device keeps it; a
   * signed-in person's comes from the garage (`mileage_log`).
   */
  mileageKm: z.number().int().min(0).max(2_000_000).optional(),
  /** The text is a quick reply of the previous question. */
  quickReply: z.boolean().optional(),
});

export type AssistantMessageBody = z.infer<typeof assistantMessageBodySchema>;

/** An item of an answer: the row of a list (M-CAT-02) as the catalog has it now, with its subcategory. */
export const assistantCardSchema = showcaseListItemSchema.extend({
  category: z.object({
    id: z.uuid(),
    kind: z.enum(["goods", "services"]),
    name: localizedTextSchema,
  }),
});

export type AssistantCard = z.infer<typeof assistantCardSchema>;

/**
 * A group of an answer about a scheduled service (SCREENS M-AI-01 «список
 * ТО группами»): its title and the cards of it (ids of `cards`), from the
 * lowest price of them; `itemIds` empty — «на платформе пока нет».
 */
export const assistantGroupSchema = z.object({
  title: z.string(),
  itemIds: z.array(z.uuid()),
  minPrice: z.number().int().nullable(),
});

export type AssistantGroup = z.infer<typeof assistantGroupSchema>;

export const assistantQuestionSchema = z.object({
  text: z.string(),
  options: z.array(z.string()).max(ASSISTANT_QUESTION_OPTIONS_MAX),
});

export const assistantReplySchema = z.object({
  id: z.uuid(),
  role: z.literal("assistant"),
  createdAt: z.iso.datetime(),
  kind: assistantMessageKindSchema,
  intent: assistantIntentSchema.nullable(),
  /** The text as shown: the model's, cleaned of links and contacts, or a fixed one of the server. */
  text: z.string(),
  /** `question` only. */
  question: assistantQuestionSchema.nullable(),
  cards: z.array(assistantCardSchema),
  groups: z.array(assistantGroupSchema),
  /**
   * The groups together: the sum of the lowest price of each group that has
   * an item («итого от N ₸»); `null` without groups.
   */
  total: z.object({ minPrice: z.number().int(), currency: z.literal("KZT") }).nullable(),
  /** «Заявку оформляйте по каждой позиции» (D-074: no basket). */
  orderEachItem: z.boolean(),
  /** The titles of the service's works the platform has nothing for («на платформе пока нет: …»). */
  notOnPlatform: z.array(z.string()),
  /** The disclaimer of a symptom (`assistant_symptom_disclaimer`), set by the server; `null` — none. */
  disclaimer: z.string().nullable(),
  /**
   * The mileage the message named, when it is not the car's current one: the
   * app asks the person and writes it itself (`POST /garage/cars/{id}/mileage`).
   */
  mileageSuggestion: z.object({ km: z.number().int() }).nullable(),
  /** T-AI-03 «В каталоге клуба пока нет подходящего». */
  notFound: z.boolean(),
  /** `unavailable` only. */
  unavailable: z.object({ reason: assistantUnavailableReasonSchema }).nullable(),
});

export type AssistantReply = z.infer<typeof assistantReplySchema>;

export const assistantUserMessageSchema = z.object({
  id: z.uuid(),
  role: z.literal("user"),
  createdAt: z.iso.datetime(),
  text: z.string(),
});

export type AssistantUserMessage = z.infer<typeof assistantUserMessageSchema>;

/**
 * What is left without spending anything: dialogs (a guest's trial ones,
 * for good, on the device; a signed-in person's of the Almaty day) and turns
 * of the current dialog (`null` — no dialog).
 */
export const assistantLimitsSchema = z.object({
  scope: z.enum(["guest", "account"]),
  dialogsLeft: z.number().int(),
  dialogsLimit: z.number().int(),
  turnsLeft: z.number().int().nullable(),
  turnsLimit: z.number().int(),
});

export type AssistantLimits = z.infer<typeof assistantLimitsSchema>;

export const assistantMessageResponseSchema = z.object({
  dialogId: z.uuid(),
  message: assistantReplySchema,
  limits: assistantLimitsSchema,
});

export type AssistantMessageResponse = z.infer<typeof assistantMessageResponseSchema>;

export const assistantDialogPathSchema = z.object({ dialogId: z.uuid() });

export type AssistantDialogPath = z.infer<typeof assistantDialogPathSchema>;

/** A guest names the device; a session — nothing. */
export const assistantDeviceQuerySchema = z.object({ deviceId: z.uuid().optional() });

export type AssistantDeviceQuery = z.infer<typeof assistantDeviceQuerySchema>;

/** The car of a dialog in words, as the vehicle catalog names its levels. */
export const assistantCarWordsSchema = z.object({
  make: z.string(),
  model: z.string().nullable(),
  generation: z.string().nullable(),
  year: z.number().int().nullable(),
  engine: z.string().nullable(),
});

export type AssistantCarWords = z.infer<typeof assistantCarWordsSchema>;

export const assistantDialogResponseSchema = z.object({
  dialog: z.object({
    id: z.uuid(),
    language: catalogLanguageSchema,
    car: assistantCarWordsSchema,
    city: showcaseCitySchema.nullable(),
    createdAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
  }),
  messages: z.array(
    z.discriminatedUnion("role", [assistantUserMessageSchema, assistantReplySchema]),
  ),
  limits: assistantLimitsSchema,
});

export type AssistantDialogResponse = z.infer<typeof assistantDialogResponseSchema>;

export const assistantMessagePathSchema = z.object({ messageId: z.uuid() });

export type AssistantMessagePath = z.infer<typeof assistantMessagePathSchema>;

/** «Пожаловаться на ответ» (SCREENS M-AI-01). */
export const assistantComplaintReasonSchema = z.enum([
  "wrong_item",
  "not_compatible",
  "offensive",
  "other",
]);

export type AssistantComplaintReason = z.infer<typeof assistantComplaintReasonSchema>;

export const assistantComplaintBodySchema = z.object({
  deviceId: z.uuid().optional(),
  reason: assistantComplaintReasonSchema,
  text: z
    .string()
    .trim()
    .max(1000)
    .regex(/^(?:[^\p{Cc}]|\n)*$/u, { message: "Must not contain control characters" })
    .optional(),
});

export type AssistantComplaintBody = z.infer<typeof assistantComplaintBodySchema>;

export const assistantComplaintStatusSchema = z.enum(["new", "resolved"]);

export type AssistantComplaintStatus = z.infer<typeof assistantComplaintStatusSchema>;

/** One complaint per answer: the second one is the first one again. */
export const assistantComplaintResponseSchema = z.object({
  complaint: z.object({
    id: z.uuid(),
    messageId: z.uuid(),
    reason: assistantComplaintReasonSchema,
    status: assistantComplaintStatusSchema,
    createdAt: z.iso.datetime(),
  }),
});

export type AssistantComplaintResponse = z.infer<typeof assistantComplaintResponseSchema>;

// ------------------------------------------------------------------ admin

/** A dialog as the administrator sees it: who (an account, hidden number) or «гость», the car, the cost. */
export const adminAssistantDialogSummarySchema = z.object({
  id: z.uuid(),
  scope: z.enum(["guest", "account"]),
  user: z
    .object({ accountId: z.uuid(), name: z.string().nullable(), phone: hiddenPhoneSchema })
    .nullable(),
  car: assistantCarWordsSchema,
  city: z.string().nullable(),
  language: catalogLanguageSchema,
  turns: z.number().int(),
  /** The sum of every AI call of the dialog, USD (`ai_job`). */
  costUsd: z.number(),
  createdAt: z.iso.datetime(),
});

export const adminAssistantComplaintSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  status: assistantComplaintStatusSchema,
  reason: assistantComplaintReasonSchema,
  text: z.string().nullable(),
  comment: z.string().nullable(),
  message: z.object({
    id: z.uuid(),
    kind: assistantMessageKindSchema,
    intent: assistantIntentSchema.nullable(),
    /** `null` — made impersonal after `assistant_retention_days`. */
    text: z.string().nullable(),
    itemIds: z.array(z.uuid()),
  }),
  dialog: adminAssistantDialogSummarySchema,
  resolvedBy: reviewAdminActorSchema.nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export type AdminAssistantComplaint = z.infer<typeof adminAssistantComplaintSchema>;

export const adminAssistantComplaintListQuerySchema = z.object({
  status: z.enum(["new", "resolved", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type AdminAssistantComplaintListQuery = z.infer<
  typeof adminAssistantComplaintListQuerySchema
>;

export const adminAssistantComplaintPageSchema = z.object({
  complaints: z.array(adminAssistantComplaintSchema),
  total: z.number().int(),
  counts: z.record(assistantComplaintStatusSchema, z.number().int()),
  nextOffset: z.number().int().nullable(),
});

export type AdminAssistantComplaintPage = z.infer<typeof adminAssistantComplaintPageSchema>;

export const assistantComplaintPathSchema = z.object({ complaintId: z.uuid() });

export type AssistantComplaintPath = z.infer<typeof assistantComplaintPathSchema>;

/** A call of a tool in a turn, as it was made: the arguments and the (cut) result. */
export const adminAssistantToolCallSchema = z.object({
  name: z.string(),
  arguments: z.unknown(),
  result: z.unknown(),
});

export const adminAssistantMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(["user", "assistant"]),
  createdAt: z.iso.datetime(),
  /** `null` — made impersonal after `assistant_retention_days`. */
  text: z.string().nullable(),
  kind: assistantMessageKindSchema.nullable(),
  intent: assistantIntentSchema.nullable(),
  itemIds: z.array(z.uuid()),
  /** How many item ids of the model the server dropped (grounding). */
  droppedItems: z.number().int(),
  toolCalls: z.array(adminAssistantToolCallSchema),
  /** The AI calls of the turn: their number, models and cost. */
  ai: z.object({ calls: z.number().int(), models: z.array(z.string()), costUsd: z.number() }),
});

export const adminAssistantComplaintResponseSchema = z.object({
  complaint: adminAssistantComplaintSchema,
  messages: z.array(adminAssistantMessageSchema),
});

export type AdminAssistantComplaintResponse = z.infer<typeof adminAssistantComplaintResponseSchema>;

export const resolveAssistantComplaintBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  comment: z
    .string()
    .trim()
    .min(3, { message: "At least 3 characters" })
    .max(2000)
    .regex(/^(?:[^\p{Cc}]|\n)*$/u, { message: "Must not contain control characters" }),
});

export type ResolveAssistantComplaintBody = z.infer<typeof resolveAssistantComplaintBodySchema>;

/** `details` of 409 `ASSISTANT_COMPLAINT_CONFLICT`: the complaint as it is now. */
export const assistantComplaintConflictDetailsSchema = z.object({
  complaint: adminAssistantComplaintSchema,
});
