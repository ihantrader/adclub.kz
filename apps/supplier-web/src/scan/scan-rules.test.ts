import { ApiError } from "@adclub/api-client";
import type { SupplierOrder, SupplierScanOrder } from "@adclub/contracts";
import { supplierText } from "@adclub/i18n";
import { describe, expect, it } from "vitest";
import type { Translate } from "../i18n";
import { cameraApiProblem, cameraProblemOf, cropOf } from "./camera";
import {
  FOREIGN_FORGET_MS,
  answerOfClose,
  answerOfError,
  answerOfLookup,
  createScanGate,
  credentialOfScan,
  resultTone,
  resultWords,
  typedCode,
  type ScanResult,
} from "./scan-rules";

const t: Translate = (key, params) => supplierText("ru", key, params);
const format = () => "6 октября, 14:02";
const QR = "ADCLUB-ORDER:abcdefghijklmnopqrstuv";

const scanOrder: SupplierScanOrder = {
  id: crypto.randomUUID(),
  number: 4821,
  status: "ready",
  version: 3,
  isTest: false,
  quantity: 2,
  unitPrice: 6_250,
  total: 12_500,
  currency: "KZT",
  fulfillment: "pickup",
  item: {
    id: crypto.randomUUID(),
    type: "part",
    name: { text: "Колодки тормозные передние", isFallback: false },
    article: "04465-0K090",
    brand: "Geely",
  },
  receiptOn: "2026-10-06",
  createdAt: "2026-10-06T06:00:00Z",
};

function error(code: string, status: number, details?: unknown): ApiError {
  return new ApiError({
    code: code as ApiError["code"],
    message: "x",
    status,
    retryable: false,
    details,
  });
}

describe("what the camera saw", () => {
  it("takes only the club's QR; anything else is somebody else's", () => {
    expect(credentialOfScan(QR)).toEqual({ qr: QR });
    expect(credentialOfScan("https://example.com")).toBeNull();
    expect(credentialOfScan("adclub-order:x")).toBeNull();
  });

  it("makes one request of one QR held in front of the camera, and goes on only by «Сканировать следующую»", () => {
    const gate = createScanGate();
    expect(gate.seen(QR, 0)).toBe("act");
    for (let frame = 1; frame < 50; frame += 1) expect(gate.seen(QR, frame * 200)).toBe("ignore");
    // Another QR in view meanwhile is ignored too: the screen shows the result.
    expect(gate.seen("ADCLUB-ORDER:another0000000000000000", 10_000)).toBe("ignore");
    gate.resume();
    expect(gate.seen(QR, 20_000)).toBe("act");
  });

  it("tells about a foreign QR once while it stays in view, again after it left", () => {
    const gate = createScanGate();
    expect(gate.seen("hello", 0)).toBe("foreign");
    expect(gate.seen("hello", 200)).toBe("ignore");
    expect(gate.seen("hello", 400)).toBe("ignore");
    expect(gate.seen("hello", 400 + FOREIGN_FORGET_MS)).toBe("foreign");
    expect(gate.seen("other", 400 + FOREIGN_FORGET_MS + 1)).toBe("foreign");
    // A foreign QR never blocks the club's one.
    expect(gate.seen(QR, 400 + FOREIGN_FORGET_MS + 2)).toBe("act");
    // The server said «not an order QR»: scanning goes on, and that string is not sent again.
    const fake = "ADCLUB-ORDER:not-a-real-token";
    gate.resume();
    expect(gate.seen(fake, 10_000)).toBe("act");
    gate.reject(fake, 10_100);
    expect(gate.busy()).toBe(false);
    expect(gate.seen(fake, 10_300)).toBe("ignore");
    expect(gate.seen(fake, 10_500)).toBe("ignore");
    expect(gate.seen(QR, 10_700)).toBe("act");
  });

  it("keeps digits of what was typed or pasted — «482 915», «482-915»", () => {
    expect(typedCode("482 915")).toBe("482915");
    expect(typedCode("482-915")).toBe("482915");
    expect(typedCode("4829151")).toBe("482915");
  });
});

describe("the answers of the server (S-SCAN-03, S-SCAN-04)", () => {
  it("finds an order to give out now, or late inside the window", () => {
    expect(answerOfLookup({ result: "ready", order: scanOrder })).toEqual({
      kind: "found",
      order: scanOrder,
      late: null,
    });
    expect(
      answerOfLookup({ result: "late", order: scanOrder, expiredAt: "a", until: "b" }),
    ).toEqual({ kind: "found", order: scanOrder, late: { expiredAt: "a", until: "b" } });
  });

  it("words every row of the table", () => {
    const words = (result: ScanResult) => resultWords(result, format, t);
    expect(
      words({
        kind: "givenOut",
        itemName: "Колодки тормозные передние",
        quantity: 1,
        customerName: "Әлия",
        late: false,
      }),
    ).toEqual({
      title: "Выдано",
      text: "Колодки тормозные передние × 1 · Әлия",
    });
    expect(
      words({ kind: "givenOut", itemName: "Колодки", quantity: 2, customerName: null, late: false })
        .text,
    ).toBe("Колодки × 2");
    expect(words({ kind: "otherSupplier", supplier: null }).text).toBe(
      "Эта заявка оформлена у другого поставщика",
    );
    expect(words({ kind: "otherSupplier", supplier: { id: "x", name: "Шины Юг" } }).text).toBe(
      "Эта заявка оформлена у Шины Юг. Переключиться?",
    );
    expect(words({ kind: "notFound" }).text).toBe("Код не найден. Проверьте цифры");
    expect(
      words({
        kind: "closed",
        at: "x",
        by: { kind: "member", memberId: "m", name: "Айжан", removed: false },
      }).text,
    ).toBe("Заявка уже выдана 6 октября, 14:02, закрыл(а) Айжан");
    expect(
      words({ kind: "refused", reason: "cancelled_by_user", at: "x", lateCloseHours: null }).text,
    ).toBe("Клиент отменил заявку 6 октября, 14:02. Клубная цена по ней не действует");
    expect(
      words({ kind: "refused", reason: "response_expired", at: "x", lateCloseHours: null }).text,
    ).toBe("Заявка истекла без ответа — закрыть её нельзя");
    expect(
      words({ kind: "refused", reason: "late_window_passed", at: "x", lateCloseHours: 48 }).text,
    ).toBe(
      "Закрыть нельзя: прошло больше 48 часов после истечения. Обратитесь к администратору клуба",
    );
    expect(words({ kind: "offline", code: "482915" }).text).toBe(
      "Нет связи. Запишите код клиента и закройте заявку, когда связь появится",
    );
    expect(words({ kind: "rateLimited", minutes: 12, until: 0 }).text).toBe(
      "Слишком много неверных кодов. Попробуйте через 12 мин",
    );
  });

  it("colours a given out order success, a settled one warning, an error danger — never red for an outcome", () => {
    expect(
      resultTone({ kind: "givenOut", itemName: "", quantity: 1, customerName: null, late: false }),
    ).toBe("success");
    expect(
      resultTone({ kind: "refused", reason: "cancelled_by_user", at: null, lateCloseHours: null }),
    ).toBe("warning");
    expect(resultTone({ kind: "closed", at: "x", by: { kind: "system" } })).toBe("warning");
    expect(resultTone({ kind: "otherSupplier", supplier: null })).toBe("warning");
    expect(resultTone({ kind: "notFound" })).toBe("danger");
    expect(resultTone({ kind: "offline", code: null })).toBe("danger");
  });

  it("reads the given out order with the customer's name once accepted", () => {
    const order = {
      item: scanOrder.item,
      quantity: 1,
      customer: { kind: "revealed", phone: "+77011234567", name: "Әлия" },
    } as unknown as SupplierOrder;
    expect(answerOfClose({ result: "given_out", order, late: true })).toEqual({
      kind: "givenOut",
      itemName: "Колодки тормозные передние",
      quantity: 1,
      customerName: "Әлия",
      late: true,
    });
    expect(answerOfClose({ result: "not_found" })).toEqual({ kind: "notFound" });
  });

  it("turns a refusal of the request into what the screen says", () => {
    expect(answerOfError(error("ORDER_QR_UNKNOWN", 400), { qr: QR }, 0)).toEqual({
      kind: "foreignQr",
    });
    expect(answerOfError(error("NETWORK_ERROR", 0), { code: "482915" }, 0)).toEqual({
      kind: "offline",
      code: "482915",
    });
    // A scanned QR has no code to show: nothing is written down from it.
    expect(answerOfError(error("NETWORK_ERROR", 0), { qr: QR }, 0)).toEqual({
      kind: "offline",
      code: null,
    });
    expect(
      answerOfError(error("RATE_LIMITED", 429, { retryAfterSeconds: 600 }), { code: "1" }, 1_000),
    ).toEqual({
      kind: "rateLimited",
      minutes: 10,
      until: 601_000,
    });
    expect(answerOfError(error("SERVICE_UNAVAILABLE", 503), { code: "482915" }, 0)).toEqual({
      kind: "unavailable",
      code: "482915",
    });
    expect(answerOfError(new Error("boom"), { code: "1" }, 0)).toEqual({ kind: "failed" });
  });
});

describe("the camera", () => {
  it("says why there is no picture by the standard names of the errors", () => {
    expect(cameraProblemOf({ name: "NotAllowedError" })).toBe("denied");
    expect(cameraProblemOf({ name: "NotFoundError" })).toBe("noCamera");
    expect(cameraProblemOf({ name: "NotReadableError" })).toBe("busy");
    expect(cameraProblemOf(new Error("x"))).toBe("failed");
    expect(cameraApiProblem({ isSecureContext: false, hasGetUserMedia: true })).toBe("insecure");
    expect(cameraApiProblem({ isSecureContext: true, hasGetUserMedia: false })).toBe("unsupported");
    expect(cameraApiProblem({ isSecureContext: true, hasGetUserMedia: true })).toBeNull();
  });

  it("decodes the middle of the frame, scaled down", () => {
    expect(cropOf(1280, 720)).toEqual({ sx: 334, sy: 54, size: 612, scaled: 480 });
    expect(cropOf(400, 400)).toEqual({ sx: 30, sy: 30, size: 340, scaled: 340 });
  });
});
