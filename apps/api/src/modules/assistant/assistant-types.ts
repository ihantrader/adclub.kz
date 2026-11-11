import type { AssistantReply } from "@adclub/contracts";

/**
 * What of an answer is stored besides its text, kind and intent
 * (`assistant_message.reply`): what was shown, as it was shown. The text of a
 * question is the message's text; its quick replies are here.
 */
export type StoredReply = Omit<
  AssistantReply,
  "id" | "role" | "createdAt" | "kind" | "intent" | "text" | "question"
> & {
  question: { options: string[] } | null;
};

/** A call of a tool in a turn as it is kept for the administrator: the arguments and the cut result. */
export interface StoredToolCall {
  name: string;
  arguments: unknown;
  result: unknown;
}
