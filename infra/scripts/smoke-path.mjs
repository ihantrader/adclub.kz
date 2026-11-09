// The path through a deployed stack (TASK-055): a supplier's employee signs
// in to the cabinet, a user signs in to the app and places an order, the
// employee accepts it and gives it out by the user's code — every request
// through the front proxy, as the clients make them (the cabinet's cookie
// session with its Origin, the app's bearer tokens).
//
//   ADCLUB_API=https://api.staging.adclub.kz ADCLUB_CABINET=https://cabinet.staging.adclub.kz \
//   ADCLUB_MEMBER_PHONE=+7705… ADCLUB_USER_PHONE=+7701… ADCLUB_CODE_FILE=<file with the testers' code> \
//   node infra/scripts/smoke-path.mjs
//
// The numbers are testers' numbers (`review-login:enable … --tester`) with one
// constant code, read from a file and never printed; the member's company
// needs working hours and an item to offer (ADCLUB_ITEM_QUERY, default the
// brake pads 04465-0K090), the user club access. The rehearsal's certificate
// is Caddy's own: run it with NODE_TLS_REJECT_UNAUTHORIZED=0 there only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const api = process.env.ADCLUB_API ?? "https://localhost:8443";
const cabinet = process.env.ADCLUB_CABINET ?? "https://localhost:8444";
const memberPhone = process.env.ADCLUB_MEMBER_PHONE ?? "+77055550101";
const userPhone = process.env.ADCLUB_USER_PHONE ?? "+77010000361";
const code = readFileSync(
  process.env.ADCLUB_CODE_FILE ?? ".dev-staging/tester-code",
  "utf8",
).trim();
const itemQuery = process.env.ADCLUB_ITEM_QUERY ?? "04465 0k090";
const CABINET_CLIENT = "supplier-web/0.1.0";
const APP_CLIENT = "mobile/1.0.0 (android)";

function step(text) {
  console.log(`smoke: ${text}`);
}

async function call(method, path, { client, token, body, cookies, origin } = {}) {
  const headers = { "X-Client": client };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (origin) headers.Origin = origin;
  if (cookies?.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await fetch(`${api}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const at = pair.indexOf("=");
    cookies?.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, body: json };
}

function expectStatus(result, status, what) {
  if (result.status !== status) {
    // Error codes only — bodies of successful answers carry tokens and codes.
    const details = result.body?.details?.limit ? ` (${result.body.details.limit})` : "";
    throw new Error(`${what}: ${result.status} ${result.body?.code ?? ""}${details}`);
  }
  return result.body;
}

async function signIn(phone, client, options = {}) {
  expectStatus(
    await call("POST", "/auth/login-code", { client, body: { phone }, ...options }),
    200,
    `login code for ${client}`,
  );
  return expectStatus(
    await call("POST", "/auth/login-code/verify", { client, body: { phone, code }, ...options }),
    200,
    `sign-in of ${client}`,
  );
}

async function main() {
  // 1. The employee: the cabinet's session (refresh token in the HttpOnly cookie).
  const cookies = new Map();
  const member = await signIn(memberPhone, CABINET_CLIENT, { cookies, origin: cabinet });
  const memberToken = member.access?.accessToken ?? member.session?.accessToken;
  if (!memberToken) throw new Error("the cabinet sign-in gave no access token");
  step(
    `employee signed in to the cabinet (refresh cookie: ${cookies.size > 0 ? "set" : "missing"})`,
  );
  const asMember = { client: CABINET_CLIENT, token: memberToken, origin: cabinet };

  // 2. The offer: the one on sale for the item, or a new one.
  const search = expectStatus(
    await call(
      "GET",
      `/supplier/catalog/items/search?q=${encodeURIComponent(itemQuery)}`,
      asMember,
    ),
    200,
    "item search",
  );
  const found = search.results?.[0];
  if (!found) throw new Error(`no item for «${itemQuery}»`);
  const item = found.item;
  let offerId = found.offer?.id;
  if (!offerId) {
    const created = expectStatus(
      await call("POST", "/supplier/offers", {
        ...asMember,
        body: {
          itemId: item.id,
          price: 12500,
          availability: "in_stock",
          leadDays: 0,
          pickup: true,
          delivery: false,
        },
      }),
      201,
      "new offer",
    );
    offerId = created.offer?.id ?? created.id;
    step(`offer created for ${item.article ?? item.id}`);
  }
  const offer = expectStatus(
    await call("GET", `/supplier/offers/${offerId}`, asMember),
    200,
    "offer",
  );
  const current = offer.offer ?? offer;
  if (current.status !== "active") {
    expectStatus(
      await call("POST", `/supplier/offers/${offerId}/return`, {
        ...asMember,
        body: { expectedVersion: current.version },
      }),
      200,
      "offer back on sale",
    );
  }
  step(`offer on sale: ${current.price} ₸, visible to users: ${current.showcase?.visible}`);

  // 3. The user: the app's session, registration, the order.
  const user = await signIn(userPhone, APP_CLIENT);
  const userToken = user.session.accessToken;
  const asUser = { client: APP_CLIENT, token: userToken };
  await call("POST", "/auth/complete-registration", {
    ...asUser,
    body: { name: "Тест Смоук", phoneShareConsent: true, phoneShareConsentVersion: "2026-09-mvp" },
  });
  const placed = expectStatus(
    await call("POST", "/orders", {
      ...asUser,
      body: {
        offerId,
        quantity: 1,
        fulfillment: "pickup",
        expectedPrice: current.price,
        idempotencyKey: randomUUID(),
        allowAnotherActive: true,
      },
    }),
    201,
    "order",
  );
  const order = placed.order;
  step(`user placed order № ${order.number} (${order.status}), the code is shown to the user`);

  // 4. The employee accepts it and gives it out by the user's code.
  const seen = expectStatus(
    await call("GET", `/supplier/orders/${order.id}`, asMember),
    200,
    "order in the cabinet",
  );
  const accepted = expectStatus(
    await call("POST", `/supplier/orders/${order.id}/accept`, {
      ...asMember,
      body: { expectedVersion: (seen.order ?? seen).version },
    }),
    200,
    "accept",
  );
  step(`employee accepted it: ${(accepted.order ?? accepted).status}`);
  const closed = expectStatus(
    await call("POST", "/supplier/orders/close", {
      ...asMember,
      body: { code: placed.confirmation?.code ?? order.confirmation?.code },
    }),
    200,
    "give out by code",
  );
  step(`given out by the code: ${closed.result}`);
  const after = expectStatus(
    await call("GET", `/orders/${order.id}`, asUser),
    200,
    "the user's order",
  );
  step(`the user sees: ${(after.order ?? after).status}`);
}

main().catch((error) => {
  console.error(`smoke: FAILED — ${error.message}`);
  process.exitCode = 1;
});
