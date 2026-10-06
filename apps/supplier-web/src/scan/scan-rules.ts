import { isApiError } from "@adclub/api-client";
import {
  ORDER_QR_PREFIX,
  type CloseOrderResponse,
  type OrderActor,
  type OrderCloseRefusalReason,
  type OrderLookupResponse,
  type SupplierScanOrder,
} from "@adclub/contracts";
import { formatOrderCode } from "@adclub/ui-core";
import type { IconName } from "@adclub/ui-core";
import type { SupplierTextKey } from "@adclub/i18n";
import { retryMinutes } from "../errors";
import type { Translate } from "../i18n";
import { actorName } from "../orders/order-rules";

/**
 * The scanner's rules (TASK-033, SCREENS S-SCAN-01…04): what a decoded
 * string is, one request per QR held in front of the camera, and what the
 * screen says for every answer of the server. The code and the QR content
 * live only as long as the request they are for: never in the address,
 * the history, the storage of the browser or a log line.
 */

/** What the customer showed: the content of their QR, or the six digits they said. */
export type Credential = { qr: string } | { code: string };

/** A decoded QR: the club's own (`ADCLUB-ORDER:…`) or anybody else's. */
export function credentialOfScan(text: string): Credential | null {
  return text.startsWith(ORDER_QR_PREFIX) ? { qr: text } : null;
}

/** How long a foreign QR out of view is forgotten, so it may be told about again. */
export const FOREIGN_FORGET_MS = 2_000;

export type ScanVerdict = "act" | "foreign" | "ignore";

/**
 * The camera decodes the same QR many frames a second: it becomes one
 * request. After the club's QR is acted on, everything is ignored until
 * `resume()` («Сканировать следующую»); a foreign QR is told about once
 * while it stays in view (and again once it was out of view a moment).
 */
export function createScanGate() {
  let busy = false;
  let foreign: { text: string; at: number } | null = null;
  return {
    seen(text: string, now: number): ScanVerdict {
      if (busy) return "ignore";
      if (foreign && foreign.text === text && now - foreign.at < FOREIGN_FORGET_MS) {
        foreign = { text, at: now };
        return "ignore";
      }
      if (credentialOfScan(text)) {
        busy = true;
        foreign = null;
        return "act";
      }
      foreign = { text, at: now };
      return "foreign";
    },
    /**
     * The server said this `ADCLUB-ORDER:` string is not a QR of an order
     * (`ORDER_QR_UNKNOWN`): scanning goes on, and the same string in view is
     * not sent again — as any foreign QR.
     */
    reject(text: string, now: number): void {
      busy = false;
      foreign = { text, at: now };
    },
    resume(): void {
      busy = false;
      foreign = null;
    },
    busy: () => busy,
  };
}

export type ScanGate = ReturnType<typeof createScanGate>;

/** Six digits typed or pasted («482 915», «482-915») — digits only. */
export function typedCode(input: string): string {
  return input.replace(/\D/g, "").slice(0, 6);
}

/**
 * The manual entry searches by itself once the sixth digit is in (S-SCAN-02,
 * TASK-033.A) — there is no «Найти». **One request per code typed**: the same
 * six digits again (a double tap on the last key, a re-render, Enter) search
 * nothing; a digit erased and typed again, or another code pasted over, is a
 * new code. While the scanner may not search (`held` — 429 until
 * `Retry-After`), typing goes on and nothing is sent: the code waits, and is
 * searched once when it is asked about again with `held` false.
 */
export function createCodeEntryGate() {
  /** The code the last search went with, while it stays in the cells. */
  let searched: string | null = null;
  return {
    /** The cells now hold `code`: `true` — search it now. */
    typed(code: string, held: boolean): boolean {
      if (code.length < 6) {
        searched = null;
        return false;
      }
      if (held || code === searched) return false;
      searched = code;
      return true;
    },
    /** The cells were emptied for a new code («Ввести ещё раз», «Сканировать следующую»). */
    reset(): void {
      searched = null;
    },
  };
}

export type CodeEntryGate = ReturnType<typeof createCodeEntryGate>;

// --------------------------------------------------------------- answers

/** What the scanner shows after a request. */
export type ScanAnswer =
  /** S-SCAN-03: the order may be given out — after a second, explicit press. */
  | { kind: "found"; order: SupplierScanOrder; late: { expiredAt: string; until: string } | null }
  /** «Это не QR заявки клуба»: the camera goes on. */
  | { kind: "foreignQr" }
  | ScanResult;

/** S-SCAN-04: every row of the table, and what the network and the server can add to it. */
export type ScanResult =
  | {
      kind: "givenOut";
      itemName: string;
      quantity: number;
      customerName: string | null;
      late: boolean;
    }
  | { kind: "otherSupplier"; supplier: { id: string; name: string } | null }
  | { kind: "notFound" }
  | { kind: "closed"; at: string; by: OrderActor }
  | {
      kind: "refused";
      reason: OrderCloseRefusalReason;
      at: string | null;
      lateCloseHours: number | null;
    }
  /** T-SCAN-01; the code typed by hand is shown big — there is no queue of give-outs. */
  | { kind: "offline"; code: string | null }
  | { kind: "rateLimited"; minutes: number; until: number }
  /**
   * 503: the server can't count the tries (no Redis) and doesn't look codes
   * up uncounted; a code typed by hand is shown big, to be written down.
   */
  | { kind: "unavailable"; code: string | null }
  | { kind: "failed" };

type Settled = Extract<
  OrderLookupResponse,
  { result: "closed" | "refused" | "other_supplier" | "not_found" }
>;

function settled(response: Settled): ScanResult {
  switch (response.result) {
    case "closed":
      return { kind: "closed", at: response.at, by: response.by };
    case "refused":
      return {
        kind: "refused",
        reason: response.reason,
        at: response.at,
        lateCloseHours: response.lateCloseHours ?? null,
      };
    case "other_supplier":
      return { kind: "otherSupplier", supplier: response.supplier };
    case "not_found":
      return { kind: "notFound" };
  }
}

export function answerOfLookup(response: OrderLookupResponse): ScanAnswer {
  if (response.result === "ready") return { kind: "found", order: response.order, late: null };
  if (response.result === "late") {
    return {
      kind: "found",
      order: response.order,
      late: { expiredAt: response.expiredAt, until: response.until },
    };
  }
  return settled(response);
}

export function answerOfClose(response: CloseOrderResponse): ScanAnswer {
  if (response.result === "given_out") {
    const { order } = response;
    return {
      kind: "givenOut",
      itemName: order.item.name.text,
      quantity: order.quantity,
      customerName: order.customer.kind === "revealed" ? order.customer.name : null,
      late: response.late,
    };
  }
  return settled(response);
}

/** A request that got no answer of the scanner's own. */
export function answerOfError(error: unknown, credential: Credential, now: number): ScanAnswer {
  if (!isApiError(error)) return { kind: "failed" };
  switch (error.code) {
    case "ORDER_QR_UNKNOWN":
      return { kind: "foreignQr" };
    case "NETWORK_ERROR":
      return { kind: "offline", code: "code" in credential ? credential.code : null };
    case "RATE_LIMITED": {
      const minutes = retryMinutes(error);
      const seconds = (error.details as { retryAfterSeconds?: unknown } | undefined)
        ?.retryAfterSeconds;
      const wait = typeof seconds === "number" && seconds > 0 ? seconds * 1000 : minutes * 60_000;
      return { kind: "rateLimited", minutes, until: now + wait };
    }
    case "SERVICE_UNAVAILABLE":
      return { kind: "unavailable", code: "code" in credential ? credential.code : null };
    // Not six digits: the keypad never sends that; a code that points nowhere says the same.
    case "VALIDATION_ERROR":
      return { kind: "notFound" };
    default:
      return { kind: "failed" };
  }
}

// ---------------------------------------------------------------- words

export type ResultTone = "success" | "warning" | "danger";

/**
 * The colour of the top of S-SCAN-04 (DESIGN 7.10): `success` — given
 * out, `warning` — the order is settled otherwise, something to do about
 * it (red is never an outcome of an order, DESIGN 7.2), `danger` — an
 * error of the code, the network or the server.
 */
export function resultTone(result: ScanResult): ResultTone {
  switch (result.kind) {
    case "givenOut":
      return "success";
    case "otherSupplier":
    case "closed":
    case "refused":
      return "warning";
    default:
      return "danger";
  }
}

export function resultIcon(result: ScanResult): IconName {
  switch (resultTone(result)) {
    case "success":
      return "circleCheck";
    case "warning":
      return "alertTriangle";
    default:
      return result.kind === "offline" ? "wifiOff" : "circleX";
  }
}

const refusalTitle: Record<OrderCloseRefusalReason, SupplierTextKey> = {
  not_accepted: "scan.result.notAcceptedTitle",
  cancelled_by_user: "scan.result.cancelledTitle",
  declined_by_supplier: "scan.result.declinedTitle",
  response_expired: "scan.result.cannotCloseTitle",
  late_window_passed: "scan.result.cannotCloseTitle",
};

/** The title (`titleL`) and the text under it. */
export function resultWords(
  result: ScanResult,
  format: (iso: string) => string,
  t: Translate,
): { title: string; text: string | null } {
  switch (result.kind) {
    case "givenOut": {
      const line = t("scan.result.givenOutText", { item: result.itemName, n: result.quantity });
      return {
        title: t("scan.result.givenOutTitle"),
        text: result.customerName ? `${line} · ${result.customerName}` : line,
      };
    }
    case "otherSupplier":
      return {
        title: t("scan.result.otherSupplierTitle"),
        text: result.supplier
          ? t("scan.result.otherSupplierNamed", { company: result.supplier.name })
          : t("scan.result.otherSupplier"),
      };
    case "notFound":
      return { title: t("scan.result.notFoundTitle"), text: t("scan.result.notFound") };
    case "closed":
      return {
        title: t("scan.result.closedTitle"),
        text: t(result.by.kind === "admin" ? "scan.result.closedByAdmin" : "scan.result.closed", {
          when: format(result.at),
          who: actorName(result.by, t),
        }),
      };
    case "refused": {
      const when = result.at ? format(result.at) : "";
      const text = (() => {
        switch (result.reason) {
          case "not_accepted":
            return t("scan.result.notAccepted");
          case "cancelled_by_user":
            return t("scan.result.cancelled", { when });
          case "declined_by_supplier":
            return t("scan.result.declined", { when });
          case "response_expired":
            return t("scan.result.responseExpired");
          case "late_window_passed":
            return t("scan.result.lateWindowPassed", { n: result.lateCloseHours ?? 48 });
        }
      })();
      return { title: t(refusalTitle[result.reason]), text };
    }
    case "offline":
      return { title: t("scan.result.offlineTitle"), text: t("scan.result.offline") };
    case "rateLimited":
      return {
        title: t("scan.result.rateLimitedTitle"),
        text: t("scan.result.rateLimited", { n: result.minutes }),
      };
    case "unavailable":
      return { title: t("scan.result.unavailableTitle"), text: t("scan.result.unavailable") };
    case "failed":
      return { title: t("scan.result.failedTitle"), text: t("common.errorText") };
  }
}

/** The code as the customer's screen shows it — «482 915». */
export function shownCode(code: string): string {
  return formatOrderCode(code);
}
