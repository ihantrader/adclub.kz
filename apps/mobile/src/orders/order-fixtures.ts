import type { ActiveOrder, ActiveOrdersResponse } from "@adclub/contracts";

/**
 * Orders in the shape the server answers, for the tests of `orders/*` only
 * (nothing in the app imports this file). The code and the QR are made up
 * to be easy to look for in what a test stores.
 */
export const SUPPLIER_A = "11111111-1111-4111-8111-111111111111";
export const SUPPLIER_B = "22222222-2222-4222-8222-222222222222";

let next = 0;

export function activeOrder(overrides: Partial<ActiveOrder> = {}): ActiveOrder {
  next += 1;
  const hex = next.toString(16).padStart(12, "0");
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`,
    number: 1000 + next,
    kind: "stock",
    status: "accepted",
    fulfillment: "pickup",
    quantity: 2,
    unitPrice: 6_500,
    total: 13_000,
    currency: "KZT",
    item: {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      type: "part",
      name: { text: "Колодки тормозные передние", isFallback: false },
      article: "04465-0K090",
      brand: "Geely",
      photo: null,
    },
    supplier: { id: SUPPLIER_A, name: "Автомаркет", cityName: "Алматы", district: "Жетысуский" },
    pickupPoint: {
      address: "ул. Райымбека, 200",
      district: "Жетысуский",
      cityName: "Алматы",
      timeZone: "Asia/Almaty",
      weeklyHours: null,
      closedDates: [],
      phone: "+77055550101",
    },
    confirmation: { code: "482915", qrPayload: "ADCLUB-ORDER:Zm9vYmFyYmF6cXV4cXV1eHh4" },
    mainDate: { kind: "reserve_until", at: "2026-10-05T10:00:00.000Z" },
    awaitsReceipt: true,
    needsAnswer: false,
    respondBy: "2026-10-04T12:00:00.000Z",
    reserveUntil: "2026-10-05T10:00:00.000Z",
    createdAt: "2026-10-04T10:00:00.000Z",
    updatedAt: "2026-10-04T10:30:00.000Z",
    ...overrides,
  };
}

export function activeOrdersResponse(orders: ActiveOrder[]): ActiveOrdersResponse {
  return {
    language: "ru",
    serverTime: "2026-10-04T10:12:00.000Z",
    orders,
    total: orders.length,
    limit: 50,
    truncated: false,
  };
}
