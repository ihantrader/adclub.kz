import { createRequestCache } from "./request-cache";

/**
 * The last answers of `GET /orders/{id}` (TASK-049.B): the order screen
 * writes them, and «Оценить поставщика» / «Пожаловаться» opened from it
 * start with the order already on screen — the score and the text of a
 * refused review, the reasons allowed now, the limits of the text — instead
 * of a skeleton while the screen slides in. Each of them still asks the
 * server afresh (`useRequest` option `cache`).
 */
export const orderAnswers = createRequestCache(60_000);

export function orderRequestKey(orderId: string, lang: string): string {
  return `order:${orderId}:${lang}`;
}
