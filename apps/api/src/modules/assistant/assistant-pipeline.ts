import { Inject, Injectable } from "@nestjs/common";
import type { AssistantCarWords } from "@adclub/contracts";
import {
  AiBudgetExhaustedError,
  AiGatewayError,
  AiService,
  type AiInitiator,
  type AssistantChatMessage,
} from "../ai";
import { AppSettings } from "../settings";
import { AssistantAnswers, type BuiltReply, type TurnEnd } from "./assistant-answer";
import { ASSISTANT_RULES, dialogContext, historyOf } from "./assistant-prompt";
import {
  ASSISTANT_TOOLS,
  AssistantTools,
  askUserArgs,
  FINAL_TOOLS,
  proposeArgs,
  type ToolContext,
} from "./assistant-tools";
import type { StoredToolCall } from "./assistant-types";
import type { AssistantMessageRow } from "./schema";

/**
 * What a model that answered in free text is told, once a turn: the turn ends
 * with `ask_user` or `propose` — the server shows nothing of a free text
 * but the text.
 */
const CLOSE_WITH_A_TOOL =
  "(The app, not the person:) end this turn by calling ask_user or propose, with the item ids the tools returned.";

/** What the model is told when its lookups of the turn are spent: close the turn now. */
const NO_MORE_LOOKUPS =
  "(The app, not the person:) no more lookups in this turn — call propose or ask_user now, with the item ids already found.";

/** What one turn came to. */
export type TurnOutcome =
  | ({
      ok: true;
      toolCalls: StoredToolCall[];
      foundIds: string[];
      aiJobIds: string[];
    } & BuiltReply)
  | {
      ok: false;
      reason: "provider" | "budget";
      toolCalls: StoredToolCall[];
      foundIds: string[];
      aiJobIds: string[];
    };

export interface TurnInput {
  dialogId: string;
  context: ToolContext;
  car: AssistantCarWords;
  cityName: string | null;
  mileageKm: number | null;
  history: readonly AssistantMessageRow[];
  text: string;
  initiator: AiInitiator;
  /** Ask this one model and no fallback (the model comparison, `ai:eval:assistant`). */
  model?: string;
}

/**
 * One turn of the assistant (TASK-062; ARCHITECTURE 4.85, 11.1): the rules,
 * the context of the dialog, the history and the person's message go to the
 * model; each step it either looks something up — a tool of
 * `AssistantTools`, at most `assistant_max_tool_calls` of them a turn — or
 * ends the turn with `ask_user` or `propose` (the intent is a field of them:
 * no separate call to classify it). The whole turn has `assistant_turn_seconds`.
 * Every step is one `AiService` call — the daily budget, the fallback model,
 * the `ai_job` record without content — and the answer is built by
 * `AssistantAnswers` (grounding, the text, the disclaimer).
 *
 * The provider failing or the budget spent is no answer: the outcome says
 * why, and the caller gives the person's attempt back.
 */
@Injectable()
export class AssistantPipeline {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AssistantTools) private readonly tools: AssistantTools,
    @Inject(AssistantAnswers) private readonly answers: AssistantAnswers,
  ) {}

  async turn(input: TurnInput): Promise<TurnOutcome> {
    const [maxCalls, turnSeconds] = await Promise.all([
      this.settings.get("assistant_max_tool_calls"),
      this.settings.get("assistant_turn_seconds"),
    ]);
    const deadline = Date.now() + turnSeconds * 1000;
    const messages: AssistantChatMessage[] = [
      { role: "system", content: ASSISTANT_RULES },
      {
        role: "system",
        content: dialogContext({
          car: input.car,
          city: input.cityName,
          mileageKm: input.mileageKm,
          lang: input.context.lang,
        }),
      },
      ...historyOf(input.history),
      { role: "user", content: input.text },
    ];
    // Grounding: what the tools of this dialog have returned, past turns included.
    const found = new Set(input.history.flatMap((row) => row.foundItemIds));
    const foundNow = new Set<string>();
    const toolCalls: StoredToolCall[] = [];
    const aiJobIds: string[] = [];
    let calls = 0;
    let reminded = false;
    let lastStep = false;
    let end: TurnEnd | null = null;

    for (let step = 0; end === null; step += 1) {
      if (calls >= maxCalls) {
        // The lookups are spent: one more step to close the turn with what was found.
        if (lastStep) {
          end = { kind: "exhausted" };
          break;
        }
        lastStep = true;
        messages.push({ role: "user", content: NO_MORE_LOOKUPS });
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        return { ok: false, reason: "provider", toolCalls, foundIds: [...foundNow], aiJobIds };
      }
      let output;
      try {
        const call = await this.ai.assistantStep(
          { messages, tools: ASSISTANT_TOOLS },
          {
            initiator: input.initiator,
            // Counts and ids, never the words (ARCHITECTURE 4.19 I175).
            inputRef: { dialogId: input.dialogId, step, messages: messages.length },
            deadlineMs: left,
            ...(input.model ? { model: input.model } : {}),
          },
        );
        aiJobIds.push(call.jobId);
        output = call.output;
      } catch (error) {
        if (error instanceof AiBudgetExhaustedError || error instanceof AiGatewayError) {
          return {
            ok: false,
            reason: error instanceof AiBudgetExhaustedError ? "budget" : "provider",
            toolCalls,
            foundIds: [...foundNow],
            aiJobIds,
          };
        }
        throw error;
      }
      if (output.toolCalls.length === 0) {
        // Free text instead of closing the turn: reminded once, then taken as it is.
        if (!reminded && output.text !== null) {
          reminded = true;
          calls += 1;
          messages.push(
            { role: "assistant", content: output.text, toolCalls: [] },
            { role: "user", content: CLOSE_WITH_A_TOOL },
          );
          continue;
        }
        end = { kind: "text", text: output.text };
        break;
      }
      messages.push({ role: "assistant", content: output.text, toolCalls: output.toolCalls });
      for (const toolCall of output.toolCalls) {
        if ((FINAL_TOOLS as readonly string[]).includes(toolCall.name)) {
          const parsed = this.finalOf(toolCall.name, toolCall.arguments);
          toolCalls.push({
            name: toolCall.name,
            arguments: argumentsOf(toolCall.arguments),
            result: parsed.ok ? "ok" : { error: parsed.error },
          });
          if (parsed.ok) {
            end = parsed.end;
            break;
          }
          calls += 1;
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: JSON.stringify({ error: parsed.error }),
          });
          continue;
        }
        if (lastStep) {
          end = { kind: "exhausted" };
          break;
        }
        calls += 1;
        if (calls > maxCalls) {
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: JSON.stringify({ error: "Too many tool calls in this turn: answer now" }),
          });
          continue;
        }
        const outcome = await this.tools.run(toolCall.name, toolCall.arguments, input.context);
        for (const id of outcome.foundIds) {
          found.add(id);
          foundNow.add(id);
        }
        toolCalls.push({
          name: toolCall.name,
          arguments: argumentsOf(toolCall.arguments),
          result: outcome.result,
        });
        messages.push({ role: "tool", toolCallId: toolCall.id, content: outcome.content });
      }
    }

    const built = await this.answers.build({
      end,
      found,
      context: input.context,
      userText: input.text,
      mileageKm: input.mileageKm,
    });
    return { ok: true, ...built, toolCalls, foundIds: [...foundNow], aiJobIds };
  }

  private finalOf(
    name: string,
    raw: string,
  ): { ok: true; end: TurnEnd } | { ok: false; error: string } {
    let args: unknown;
    try {
      args = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, error: "The arguments are not JSON" };
    }
    const schema = name === "ask_user" ? askUserArgs : proposeArgs;
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      return { ok: false, error: `Wrong arguments — ${issues.join("; ")}` };
    }
    return name === "ask_user"
      ? { ok: true, end: { kind: "ask", args: parsed.data as typeof askUserArgs._output } }
      : { ok: true, end: { kind: "propose", args: parsed.data as typeof proposeArgs._output } };
  }
}

/** The arguments as they are kept: parsed when they are JSON, else the text cut. */
function argumentsOf(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw.slice(0, 500);
  }
}
