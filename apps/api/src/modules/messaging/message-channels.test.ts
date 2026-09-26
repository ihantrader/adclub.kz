import { describe, expect, it } from "vitest";
import {
  isTemporaryFailure,
  MessageDeliveryError,
  type MessageFailureKind,
  type MessageSendRequest,
} from "./message-channel";
import { TestMessageChannel } from "./test-message-channel";
import { failureKindOfCode, WhatsappCloudChannel, type FetchLike } from "./whatsapp-cloud-channel";

/**
 * Both implementations of the port. **Nothing here touches a network:** the
 * real channel gets a substituted `fetch` (the project has no verified
 * business and no WhatsApp number, TASK-024), so what these tests prove is
 * the shape of the request it would make and how it reads the answers the
 * Cloud API documents — never that Meta accepts them.
 */

const TOKEN = "EAAG-a-secret-access-token-of-the-system-user";
const PHONE_ID = "1234567890";
const BASE = "https://graph.facebook.com/v21.0";

const REQUEST: MessageSendRequest = {
  phone: "+77055550101",
  template: "supplier_invitation",
  providerTemplateName: "adclub_supplier_invitation",
  lang: "kk",
  variables: ["Айгерим", "Автомаркет", "https://cabinet.adclub.kz"],
  buttons: [],
  text: "text of the message",
};

const QUICK_REPLIES: MessageSendRequest = {
  ...REQUEST,
  template: "order_new",
  providerTemplateName: "adclub_order_new",
  lang: "ru",
  variables: ["1042", "Колодки", "2", "24 500", "самовывоз", "18:30"],
  buttons: [
    {
      button: { kind: "quick_reply", name: "confirm", titles: { ru: "Подтвердить", kk: "Растау" } },
      payload: "confirm:1042:sig",
    },
    {
      button: { kind: "quick_reply", name: "decline", titles: { ru: "Отказать", kk: "Бас тарту" } },
      payload: "decline:1042:sig",
    },
    // A link button carries no payload and adds no component.
    { button: { kind: "url", name: "open", titles: { ru: "Открыть", kk: "Ашу" } } },
  ],
};

interface Call {
  url: string;
  init: RequestInit;
}

/** A `fetch` that answers once with what it is given and remembers the call. */
function answering(response: Response | (() => Promise<Response>)): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return typeof response === "function" ? response() : Promise.resolve(response);
    },
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const channelOf = (fetch: FetchLike) => new WhatsappCloudChannel(TOKEN, PHONE_ID, BASE, fetch);
const signal = () => new AbortController().signal;

async function failureOfSend(
  response: Response,
  request: MessageSendRequest = REQUEST,
): Promise<MessageDeliveryError> {
  const { fetch } = answering(response);
  const error = await channelOf(fetch)
    .send(request, signal())
    .then(
      () => undefined,
      (caught: unknown) => caught,
    );
  expect(error).toBeInstanceOf(MessageDeliveryError);
  return error as MessageDeliveryError;
}

describe("the Cloud API channel", () => {
  it("posts the approved template with its values in order, to the number's endpoint", async () => {
    const { fetch, calls } = answering(json(200, { messages: [{ id: "wamid.HBgLNzcwNTU1" }] }));
    const result = await channelOf(fetch).send(REQUEST, signal());

    expect(result).toEqual({ providerMessageId: "wamid.HBgLNzcwNTU1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/${PHONE_ID}/messages`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      // No leading `+`, as the Cloud API wants it.
      to: "77055550101",
      type: "template",
      template: {
        name: "adclub_supplier_invitation",
        language: { code: "kk" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Айгерим" },
              { type: "text", text: "Автомаркет" },
              { type: "text", text: "https://cabinet.adclub.kz" },
            ],
          },
        ],
      },
    });
  });

  it("sends the payload of each quick reply by its position, and none for a link button", async () => {
    const { fetch, calls } = answering(json(200, { messages: [{ id: "wamid.X" }] }));
    await channelOf(fetch).send(QUICK_REPLIES, signal());
    const components = JSON.parse(calls[0]!.init.body as string).template.components as unknown[];
    expect(components.slice(1)).toEqual([
      {
        type: "button",
        sub_type: "quick_reply",
        index: "0",
        parameters: [{ type: "payload", payload: "confirm:1042:sig" }],
      },
      {
        type: "button",
        sub_type: "quick_reply",
        index: "1",
        parameters: [{ type: "payload", payload: "decline:1042:sig" }],
      },
    ]);
  });

  it("does not put the text we render ourselves on the wire: the approved template holds it", async () => {
    const { fetch, calls } = answering(json(200, { messages: [{ id: "wamid.X" }] }));
    await channelOf(fetch).send(REQUEST, signal());
    expect(calls[0]!.init.body as string).not.toContain("text of the message");
  });

  it("passes the abort signal on, so the job's own time limit reaches the request", async () => {
    const controller = new AbortController();
    const { fetch, calls } = answering(json(200, { messages: [{ id: "wamid.X" }] }));
    await channelOf(fetch).send(REQUEST, controller.signal);
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  describe("reading what goes wrong", () => {
    const cases: [string, Response, MessageFailureKind][] = [
      ["a 500", json(500, { error: { message: "Internal", code: 2 } }), "unavailable"],
      ["a 503 with no body at all", new Response("", { status: 503 }), "unavailable"],
      [
        "a gateway page that is not JSON",
        new Response("<html>bad gateway</html>", { status: 502 }),
        "unavailable",
      ],
      ["a 429", json(429, { error: { message: "Too many", code: 130429 } }), "rate_limited"],
      ["a 429 without a body", new Response("", { status: 429 }), "rate_limited"],
      [
        "a template that is not approved",
        json(400, { error: { message: "Template name does not exist", code: 132001 } }),
        "template_not_approved",
      ],
      [
        "a template not in this language",
        json(400, {
          error: { message: "Translation missing", code: 132001, error_data: { details: "kk" } },
        }),
        "template_not_approved",
      ],
      [
        "a number that is not on WhatsApp",
        json(400, { error: { message: "Message undeliverable", code: 131026 } }),
        "no_whatsapp",
      ],
      [
        "a recipient outside the allowed list of a sandbox account (our configuration, not their phone)",
        json(400, {
          error: { message: "Recipient phone number not in allowed list", code: 131030 },
        }),
        "rejected",
      ],
      [
        "an authentication error the platform reports as code 0 (an expired token: nothing to retry)",
        json(401, { error: { message: "Unable to authenticate the app user", code: 0 } }),
        "rejected",
      ],
      [
        "a template whose parameters do not fit (the registry and the approved template disagree)",
        json(400, { error: { message: "Number of parameters does not match", code: 132000 } }),
        "rejected",
      ],
      [
        "a template whose parameter has the wrong format",
        json(400, { error: { message: "Parameter format does not match", code: 132012 } }),
        "rejected",
      ],
      [
        "a bad token",
        json(401, { error: { message: "Invalid OAuth access token", code: 190 } }),
        "rejected",
      ],
      [
        "an unknown request problem",
        json(400, { error: { message: "Bad", code: 100 } }),
        "rejected",
      ],
      ["an error code we don't know and a 400", json(400, { error: { code: 999999 } }), "rejected"],
      [
        "an error code we don't know and a 500",
        json(500, { error: { code: 999999 } }),
        "unavailable",
      ],
      [
        "an error inside a 200",
        json(200, { error: { message: "late", code: 131026 } }),
        "no_whatsapp",
      ],
    ];
    for (const [name, response, kind] of cases) {
      it(`${name} is ${kind}`, async () => {
        const error = await failureOfSend(response);
        expect(error.kind).toBe(kind);
        expect(isTemporaryFailure(error.kind)).toBe(
          kind === "unavailable" || kind === "rate_limited",
        );
      });
    }

    it("takes the wait of a 429 from Retry-After", async () => {
      const error = await failureOfSend(
        json(429, { error: { code: 130429 } }, { "retry-after": "17" }),
      );
      expect(error.retryAfterSeconds).toBe(17);
    });

    it("ignores a Retry-After it cannot read", async () => {
      expect(
        (await failureOfSend(json(429, {}, { "retry-after": "soon" }))).retryAfterSeconds,
      ).toBeUndefined();
      expect(
        (await failureOfSend(json(429, {}, { "retry-after": "-5" }))).retryAfterSeconds,
      ).toBeUndefined();
    });

    it("does not treat a 200 without a message id as sent, nor as safe to send again", async () => {
      // Nothing to follow the delivery by, and the provider may well have taken
      // the message: a second attempt could deliver a second copy.
      const error = await failureOfSend(json(200, { messages: [] }));
      expect(error.kind).toBe("outcome_unknown");
      expect(isTemporaryFailure(error.kind)).toBe(false);
    });

    it("does not send again after a 200 of a shape it does not know", async () => {
      const error = await failureOfSend(json(200, { messages: "yes" }));
      expect(error.kind).toBe("outcome_unknown");
    });

    /** A `fetch` that fails the way undici does: `TypeError: fetch failed` with the system error as its cause. */
    const failingWith = (code: string | undefined) => () =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), {
          cause: code === undefined ? undefined : Object.assign(new Error(code), { code }),
        }),
      );

    async function outcomeOf(fetch: FetchLike, abortSignal = signal()) {
      const error = await channelOf(fetch)
        .send(REQUEST, abortSignal)
        .then(
          () => undefined,
          (caught: unknown) => caught as MessageDeliveryError,
        );
      expect(error).toBeInstanceOf(MessageDeliveryError);
      return error!;
    }

    for (const code of [
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "UND_ERR_CONNECT_TIMEOUT",
    ]) {
      it(`retries a connection that was never made (${code}): nothing can have been delivered`, async () => {
        const error = await outcomeOf(failingWith(code));
        expect(error.kind).toBe("unavailable");
        expect(isTemporaryFailure(error.kind)).toBe(true);
      });
    }

    for (const code of ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", undefined]) {
      it(`does not retry a connection that failed after it was made (${String(code)}): the provider may have the message`, async () => {
        const error = await outcomeOf(failingWith(code));
        expect(error.kind).toBe("outcome_unknown");
        expect(isTemporaryFailure(error.kind)).toBe(false);
      });
    }

    it("does not retry a request the job's own time limit aborted: the provider may have taken it", async () => {
      // pg-boss aborts with a plain AbortError, not with one of our errors.
      const controller = new AbortController();
      controller.abort();
      const error = await outcomeOf(
        () => Promise.reject(new DOMException("This operation was aborted", "AbortError")),
        controller.signal,
      );
      expect(error.kind).toBe("outcome_unknown");
      expect(error.message).toContain("aborted");
    });

    it("counts a 5xx as the provider not having taken the message, and says so in the reason", async () => {
      const error = await failureOfSend(json(503, { error: { code: 2 } }));
      expect(error.kind).toBe("unavailable");
    });

    it("carries the wait a 429 asks for into the reason an operator reads", async () => {
      const error = await failureOfSend(
        json(429, { error: { code: 130429 } }, { "retry-after": "17" }),
      );
      expect(error.message).toContain("asks to wait 17 s");
    });

    it("hands back the caller's own reason when its time limit aborted the request", async () => {
      const reason = new MessageDeliveryError("unavailable", "the job's time limit");
      const controller = new AbortController();
      controller.abort(reason);
      const error = await channelOf(() => Promise.reject(new Error("aborted")))
        .send(REQUEST, controller.signal)
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBe(reason);
    });

    it("never puts the token, the number or a value into an error message", async () => {
      const responses = [
        json(400, { error: { message: "Template name does not exist", code: 132001 } }),
        json(401, { error: { message: "Invalid OAuth access token", code: 190 } }),
        json(500, { error: { message: "Internal", code: 2 } }),
      ];
      for (const response of responses) {
        const error = await failureOfSend(response);
        for (const secret of [TOKEN, "77055550101", "Айгерим", "Автомаркет"]) {
          expect(error.message).not.toContain(secret);
        }
      }
    });
  });

  it("classifies the documented error codes the decisions rest on", () => {
    expect(failureKindOfCode(132001)).toBe("template_not_approved");
    expect(failureKindOfCode(131026)).toBe("no_whatsapp");
    expect(failureKindOfCode(130429)).toBe("rate_limited");
    expect(failureKindOfCode(190)).toBe("rejected");
    // The same trouble as an expired token, so the same answer.
    expect(failureKindOfCode(0)).toBe("rejected");
    expect(failureKindOfCode(131030)).toBe("rejected");
    expect(failureKindOfCode(132000)).toBe("rejected");
    expect(failureKindOfCode(132012)).toBe("rejected");
    expect(failureKindOfCode(2)).toBe("unavailable");
    expect(failureKindOfCode(123456)).toBeUndefined();
    expect(failureKindOfCode(undefined)).toBeUndefined();
  });
});

describe("the test channel (development, tests and CI)", () => {
  it("sends nothing anywhere: it keeps the request and answers with an id shaped like a real one", async () => {
    const channel = new TestMessageChannel();
    const result = await channel.send(REQUEST, signal());
    expect(channel.provider).toBe("test");
    expect(result.providerMessageId).toMatch(/^wamid\.TEST[0-9A-F]{32}$/);
    expect(channel.sent).toEqual([REQUEST]);
  });

  it("gives every message its own id", async () => {
    const channel = new TestMessageChannel();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      ids.add((await channel.send(REQUEST, signal())).providerMessageId);
    }
    expect(ids.size).toBe(20);
  });

  it("gives ids that cannot collide between the channels of two worker processes", async () => {
    // Each process has its own channel, and the provider's id is unique in the table.
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      for (const channel of [new TestMessageChannel(), new TestMessageChannel()]) {
        ids.add((await channel.send(REQUEST, signal())).providerMessageId);
      }
    }
    expect(ids.size).toBe(100);
  });

  const failing: [TestMessageChannel["mode"], MessageFailureKind, boolean][] = [
    ["unavailable", "unavailable", true],
    ["rate_limited", "rate_limited", true],
    ["rejected", "rejected", false],
    ["template_not_approved", "template_not_approved", false],
    ["no_whatsapp", "no_whatsapp", false],
    // The request may have reached the provider: never retried by itself.
    ["outcome_unknown", "outcome_unknown", false],
  ];
  for (const [mode, kind, temporary] of failing) {
    it(`mode ${mode} fails as ${kind}, and ${temporary ? "is" : "is not"} worth retrying`, async () => {
      const channel = new TestMessageChannel();
      channel.mode = mode;
      const error = await channel.send(REQUEST, signal()).then(
        () => undefined,
        (caught: unknown) => caught as MessageDeliveryError,
      );
      expect(error).toBeInstanceOf(MessageDeliveryError);
      expect(error!.kind).toBe(kind);
      expect(isTemporaryFailure(error!.kind)).toBe(temporary);
      expect(channel.sent).toEqual([]);
    });
  }

  it("says how long the provider asks to wait when it limits us", async () => {
    const channel = new TestMessageChannel();
    channel.mode = "rate_limited";
    const error = await channel.send(REQUEST, signal()).then(
      () => undefined,
      (caught: unknown) => caught as MessageDeliveryError,
    );
    expect(error!.retryAfterSeconds).toBe(30);
  });

  it("names neither the number nor the values in a failure", async () => {
    const channel = new TestMessageChannel();
    for (const mode of [
      "unavailable",
      "rate_limited",
      "rejected",
      "template_not_approved",
      "no_whatsapp",
      "outcome_unknown",
    ] as const) {
      channel.mode = mode;
      const error = await channel.send(REQUEST, signal()).then(
        () => undefined,
        (caught: unknown) => caught as MessageDeliveryError,
      );
      for (const secret of ["77055550101", "Айгерим", "Автомаркет"]) {
        expect(error!.message, mode).not.toContain(secret);
      }
    }
  });

  it("mode slow answers after its delay, and stops when the job's time limit aborts it", async () => {
    const channel = new TestMessageChannel();
    channel.mode = "slow";
    channel.delayMs = 30;
    const started = Date.now();
    await channel.send(REQUEST, signal());
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(channel.sent).toHaveLength(1);

    channel.delayMs = 10_000;
    const controller = new AbortController();
    const pending = channel.send(REQUEST, controller.signal);
    controller.abort(new Error("timed out"));
    await expect(pending).rejects.toThrow("timed out");
    // The aborted send was never accepted.
    expect(channel.sent).toHaveLength(1);
  });

  it("does not start a slow send that was aborted before it began", async () => {
    const channel = new TestMessageChannel();
    channel.mode = "slow";
    const controller = new AbortController();
    controller.abort(new Error("already over"));
    await expect(channel.send(REQUEST, controller.signal)).rejects.toThrow("already over");
    expect(channel.sent).toEqual([]);
  });
});
