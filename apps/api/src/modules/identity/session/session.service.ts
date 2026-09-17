import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  clientPlatformSchema,
  type ClientInfo,
  type CurrentAccountResponse,
  type RateLimitName,
  type SessionKind,
  type SessionListResponse,
  type SessionsEndedResponse,
  type SessionSummary,
  type SessionTokens,
} from "@adclub/contracts";
import { maskPhone } from "@adclub/domain";
import {
  ApiException,
  rateLimitedException,
  serviceUnavailableException,
} from "../../../common/errors";
import { describeError } from "../../../common/health";
import { APP_CONFIG, type AppConfig, type RateLimitSettings } from "../../../config";
import { withoutQueryParameters, type DbExecutor } from "../../../database";
import { RateLimiterService, RateLimiterUnavailableError } from "../../../redis";
import type { SessionRevokedReason } from "../schema";
import { rateLimitSubject } from "../login-code/rate-limit-subject";
import { ipHint } from "./ip-hint";
import {
  accessTokenExpiredException,
  authRequiredException,
  sessionEndedException,
} from "./session-errors";
import { SessionSettingsSource } from "./session-settings.source";
import {
  accessTokenIssuer,
  newRefreshSeed,
  parseRefreshToken,
  refreshTokenFor,
  refreshTokenMatches,
  signAccessToken,
  verifyAccessToken,
} from "./session-tokens";
import {
  SessionStore,
  type SessionRefreshRow,
  type SessionSelection,
  type SessionSummaryRow,
} from "./session.store";

/** Who is calling a protected route (set by `SessionGuard`). */
export interface AuthenticatedSession {
  sessionId: string;
  accountId: string;
  kind: SessionKind;
  /** Supplier cabinet context (TASK-006); `null` for other kinds. */
  supplierId: string | null;
  supplierMemberId: string | null;
}

export interface IssueSessionInput {
  account: { id: string; phone: string };
  kind: SessionKind;
  /** Only for `supplier_web` (TASK-006). */
  context?: { supplierId: string; supplierMemberId: string };
  client: ClientInfo | null;
  deviceName: string | null;
  ip: string | null;
  /** The login code that proved the phone number. */
  loginChallengeId: string | null;
}

/** A new or refreshed session: the tokens and when the session ends. */
export interface IssuedSession {
  tokens: SessionTokens & { refreshToken: string };
  sessionExpiresAt: Date;
}

export interface RefreshInput {
  token: string;
  /** `body` — the mobile app; a web kind — the token came from that client's cookie. */
  transport: "body" | Exclude<SessionKind, "mobile">;
  ip: string | null;
}

export interface EndSessionsResult {
  response: SessionsEndedResponse;
  /** Kind of the calling session if it was among the ended ones (to clear its cookie). */
  currentKind: SessionKind | null;
}

/** Recording last use at most this often per session. */
const TOUCH_INTERVAL_MS = 60_000;

type RefreshOutcome =
  | { kind: "rotated"; row: SessionRefreshRow; generation: number; expiresAt: Date }
  | { kind: "repeated"; row: SessionRefreshRow; generation: number; expiresAt: Date }
  | { kind: "reused"; row: SessionRefreshRow; currentGeneration: number }
  | { kind: "ended"; reason: string }
  | { kind: "invalid"; reason: string };

const rateLimitKeys = {
  refreshPerIp: (subject: string) => `session:refresh:ip:${subject}`,
  refreshPerSession: (sessionId: string) => `session:refresh:session:${sessionId}`,
};

function toSummary(row: SessionSummaryRow, currentSessionId: string): SessionSummary {
  const platform = clientPlatformSchema.safeParse(row.clientPlatform);
  return {
    id: row.id,
    kind: row.kind,
    current: row.id === currentSessionId,
    deviceName: row.deviceName,
    platform: platform.success ? platform.data : null,
    clientVersion: row.clientVersion,
    ipHint: ipHint(row.lastIp),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Sessions (ARCHITECTURE 8.2, 4.6): issue, refresh with rotation and
 * reuse detection, check access on every protected request, list and end.
 * Tokens never reach the log or the database; sessions appear in the log
 * by id, accounts by id and masked phone.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger("Session");
  private readonly issuer: string;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionSettingsSource) private readonly settingsSource: SessionSettingsSource,
    @Inject(SessionStore) private readonly store: SessionStore,
    @Inject(RateLimiterService) private readonly rateLimiter: RateLimiterService,
  ) {
    this.issuer = accessTokenIssuer(config.nodeEnv);
  }

  /**
   * Creates a session and its first token pair. Runs on `executor`, so the
   * sign-in can create it in the transaction that spends the login code.
   * Deciding who may get which kind is the caller's job (D-025).
   */
  async issue(input: IssueSessionInput, executor?: DbExecutor): Promise<IssuedSession> {
    if ((input.kind === "supplier_web") !== (input.context !== undefined)) {
      throw new Error("A supplier cabinet session needs a context, and only it may have one");
    }
    const settings = await this.settingsSource.getSettings();
    const now = new Date();
    const id = randomUUID();
    const seed = newRefreshSeed();
    const ttlMs = settings.ttlSeconds[input.kind] * 1000;
    const expiresAt = new Date(now.getTime() + ttlMs);
    // The admin session ends 12 hours after sign-in, whatever happens.
    const absoluteExpiresAt = input.kind === "admin_web" ? expiresAt : null;

    await this.store.create(
      {
        id,
        accountId: input.account.id,
        kind: input.kind,
        supplierId: input.context?.supplierId ?? null,
        supplierMemberId: input.context?.supplierMemberId ?? null,
        refreshSeed: seed,
        loginChallengeId: input.loginChallengeId,
        clientPlatform: input.client?.platform ?? null,
        clientVersion: input.client?.version ?? null,
        deviceName: input.deviceName,
        lastIp: input.ip,
        now,
        expiresAt,
        absoluteExpiresAt,
      },
      executor,
    );
    this.logger.log(
      `Session created session=${id} account=${input.account.id} kind=${input.kind} phone=${maskPhone(input.account.phone)}`,
    );
    return {
      tokens: this.tokens(
        { id, accountId: input.account.id, kind: input.kind },
        0,
        seed,
        expiresAt,
        now,
        settings.accessTokenTtlSeconds,
      ),
      sessionExpiresAt: expiresAt,
    };
  }

  /**
   * Exchanges a refresh token for a new pair. The current generation is
   * rotated; the generation just replaced gets the same new pair back
   * within the grace period (a retried or concurrent refresh); any older
   * generation is proof the token was copied, and ends the session.
   */
  async refresh(input: RefreshInput): Promise<IssuedSession> {
    const settings = await this.settingsSource.getSettings();
    await this.withRateLimiter(() =>
      this.enforce(
        rateLimitKeys.refreshPerIp(rateLimitSubject(input.ip ?? undefined)),
        settings.refreshPerIp,
        "session_refresh_per_ip",
        "-",
      ),
    );

    const parsed = parseRefreshToken(input.token);
    if (!parsed) {
      this.logger.warn("Session refresh refused reason=malformed_token");
      throw authRequiredException();
    }
    const sessionId = parsed.sessionId;
    const found = await this.withDatabase(() => this.store.findForRefresh(sessionId));
    const expectedKind = input.transport === "body" ? "mobile" : input.transport;
    if (
      !found ||
      !refreshTokenMatches(this.config.session.tokenSecret, parsed, found.refreshSeed)
    ) {
      // Not issued by this server for this session: never touches the session.
      this.logger.warn(
        `Session refresh refused session=${sessionId} reason=${found ? "bad_token" : "unknown_session"}`,
      );
      throw authRequiredException();
    }
    if (found.kind !== expectedKind) {
      this.logger.warn(
        `Session refresh refused session=${sessionId} reason=wrong_transport kind=${found.kind} transport=${input.transport}`,
      );
      throw authRequiredException();
    }
    await this.withRateLimiter(() =>
      this.enforce(
        rateLimitKeys.refreshPerSession(sessionId),
        settings.refreshPerSession,
        "session_refresh_per_session",
        sessionId,
      ),
    );

    const now = new Date();
    const outcome = await this.withDatabase(() =>
      this.store.refreshLocked<RefreshOutcome>(sessionId, now, (row) => {
        if (!row) {
          return { result: { kind: "invalid", reason: "unknown_session" } };
        }
        if (row.revokedAt) {
          return { result: { kind: "ended", reason: `revoked_${row.revokedReason ?? "unknown"}` } };
        }
        if (row.expiresAt.getTime() <= now.getTime()) {
          return { result: { kind: "ended", reason: "expired" } };
        }
        if (parsed.generation === row.refreshGeneration) {
          const slid = new Date(now.getTime() + settings.ttlSeconds[row.kind] * 1000);
          const expiresAt =
            row.absoluteExpiresAt && row.absoluteExpiresAt < slid ? row.absoluteExpiresAt : slid;
          const generation = row.refreshGeneration + 1;
          return {
            decision: { kind: "rotate", generation, expiresAt, lastIp: input.ip },
            result: { kind: "rotated", row, generation, expiresAt },
          };
        }
        const withinGrace =
          parsed.generation === row.refreshGeneration - 1 &&
          row.refreshRotatedAt !== null &&
          now.getTime() - row.refreshRotatedAt.getTime() <=
            settings.refreshReuseGraceSeconds * 1000;
        if (withinGrace) {
          return {
            decision: { kind: "touch", lastIp: input.ip },
            result: {
              kind: "repeated",
              row,
              generation: row.refreshGeneration,
              expiresAt: row.expiresAt,
            },
          };
        }
        if (parsed.generation < row.refreshGeneration) {
          return {
            decision: { kind: "revoke", reason: "refresh_reuse" },
            result: { kind: "reused", row, currentGeneration: row.refreshGeneration },
          };
        }
        // A later generation than the server ever issued.
        return { result: { kind: "invalid", reason: "unknown_generation" } };
      }),
    );

    switch (outcome.kind) {
      case "invalid":
        this.logger.warn(`Session refresh refused session=${sessionId} reason=${outcome.reason}`);
        throw authRequiredException();
      case "ended":
        this.logger.warn(`Session refresh refused session=${sessionId} reason=${outcome.reason}`);
        throw sessionEndedException();
      case "reused":
        this.logger.warn(
          `Refresh token reuse detected, session revoked session=${sessionId} account=${outcome.row.accountId} presentedGeneration=${parsed.generation} currentGeneration=${outcome.currentGeneration}`,
        );
        throw sessionEndedException();
      case "rotated":
      case "repeated":
        this.logger.log(
          outcome.kind === "rotated"
            ? `Session refreshed session=${sessionId} account=${outcome.row.accountId} generation=${outcome.generation}`
            : `Session refresh repeated within grace session=${sessionId} account=${outcome.row.accountId} generation=${outcome.generation}`,
        );
        return {
          tokens: this.tokens(
            outcome.row,
            outcome.generation,
            outcome.row.refreshSeed,
            outcome.expiresAt,
            now,
            settings.accessTokenTtlSeconds,
          ),
          sessionExpiresAt: outcome.expiresAt,
        };
    }
  }

  /**
   * The access check of every protected request: a valid signature is not
   * enough, the session row must exist, belong to the token's account and
   * be neither ended nor expired. If the database can't answer, the
   * request is refused as temporarily unavailable — never let through, and
   * never answered as "signed out".
   */
  async authenticate(
    authorization: string | string[] | undefined,
    ip: string | null,
  ): Promise<AuthenticatedSession> {
    if (authorization === undefined) {
      throw authRequiredException();
    }
    const match =
      typeof authorization === "string" ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
    if (!match) {
      this.logger.warn("Access refused reason=malformed_authorization");
      throw authRequiredException();
    }
    const now = new Date();
    const check = verifyAccessToken(
      this.config.session.tokenSecret,
      this.issuer,
      match[1]!,
      Math.floor(now.getTime() / 1000),
    );
    if (check.kind === "invalid") {
      this.logger.warn(`Access refused reason=${check.reason}`);
      throw authRequiredException();
    }
    if (check.kind === "expired") {
      throw accessTokenExpiredException();
    }

    const { sid, sub, knd } = check.claims;
    const row = await this.withDatabase(() => this.store.findForAccess(sid));
    if (!row || row.accountId !== sub || row.kind !== knd) {
      this.logger.warn(
        `Access refused session=${sid} reason=${row ? "session_mismatch" : "unknown_session"}`,
      );
      throw authRequiredException();
    }
    if (row.revokedAt) {
      this.logger.warn(
        `Access refused: session ended session=${sid} account=${sub} reason=${row.revokedReason ?? "unknown"}`,
      );
      throw sessionEndedException();
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      this.logger.warn(`Access refused: session expired session=${sid} account=${sub}`);
      throw sessionEndedException();
    }

    if (now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
      try {
        await this.store.touch(sid, now, ip, TOUCH_INTERVAL_MS);
      } catch (error) {
        // Bookkeeping only; the access decision is already made.
        this.logger.warn(`Could not record session use session=${sid}: ${describeError(error)}`);
      }
    }
    return {
      sessionId: row.id,
      accountId: row.accountId,
      kind: row.kind,
      supplierId: row.supplierId,
      supplierMemberId: row.supplierMemberId,
    };
  }

  async getCurrent(auth: AuthenticatedSession): Promise<CurrentAccountResponse> {
    const row = await this.withDatabase(() => this.store.findSummary(auth.sessionId));
    if (!row) {
      throw sessionEndedException();
    }
    return {
      account: {
        id: row.account.id,
        phone: row.account.phone,
        createdAt: row.account.createdAt.toISOString(),
      },
      session: toSummary(row, auth.sessionId),
    };
  }

  async list(auth: AuthenticatedSession): Promise<SessionListResponse> {
    const rows = await this.withDatabase(() => this.store.listActive(auth.accountId, new Date()));
    return { sessions: rows.map((row) => toSummary(row, auth.sessionId)) };
  }

  /** Ends one of the caller's own sessions; any other id is `NOT_FOUND`. */
  endOne(auth: AuthenticatedSession, sessionId: string): Promise<EndSessionsResult> {
    return this.end(auth, { kind: "one", sessionId }, (id) =>
      id === auth.sessionId ? "logout" : "ended_by_owner",
    ).then((result) => {
      if (result.response.ended === 0) {
        throw new ApiException(404, "NOT_FOUND", "Session not found");
      }
      return result;
    });
  }

  endOthers(auth: AuthenticatedSession): Promise<EndSessionsResult> {
    return this.end(auth, { kind: "all_except", sessionId: auth.sessionId }, () => "ended_others");
  }

  endAll(auth: AuthenticatedSession): Promise<EndSessionsResult> {
    return this.end(auth, { kind: "all" }, () => "ended_all");
  }

  logout(auth: AuthenticatedSession): Promise<EndSessionsResult> {
    return this.end(auth, { kind: "one", sessionId: auth.sessionId }, () => "logout");
  }

  private async end(
    auth: AuthenticatedSession,
    selection: SessionSelection,
    reasonFor: (sessionId: string) => SessionRevokedReason,
  ): Promise<EndSessionsResult> {
    const ended = await this.withDatabase(() =>
      this.store.revoke(auth.accountId, selection, reasonFor, new Date()),
    );
    for (const row of ended) {
      this.logger.log(
        `Session ended session=${row.id} account=${auth.accountId} reason=${reasonFor(row.id)} by=${auth.sessionId}`,
      );
    }
    if (selection.kind !== "one") {
      this.logger.log(
        `Sessions ended account=${auth.accountId} scope=${selection.kind} count=${ended.length} by=${auth.sessionId}`,
      );
    }
    const current = ended.find((row) => row.id === auth.sessionId);
    return {
      response: { ended: ended.length, currentEnded: current !== undefined },
      currentKind: current?.kind ?? null,
    };
  }

  private tokens(
    session: { id: string; accountId: string; kind: SessionKind },
    generation: number,
    seed: string,
    sessionExpiresAt: Date,
    now: Date,
    accessTokenTtlSeconds: number,
  ): IssuedSession["tokens"] {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    // Never outlives the session.
    const exp = Math.max(
      nowSeconds + 1,
      Math.min(nowSeconds + accessTokenTtlSeconds, Math.floor(sessionExpiresAt.getTime() / 1000)),
    );
    const secret = this.config.session.tokenSecret;
    return {
      sessionId: session.id,
      kind: session.kind,
      accessToken: signAccessToken(secret, this.issuer, {
        sub: session.accountId,
        sid: session.id,
        knd: session.kind,
        iat: nowSeconds,
        exp,
      }),
      accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
      refreshToken: refreshTokenFor(secret, session.id, generation, seed),
      sessionExpiresAt: sessionExpiresAt.toISOString(),
    };
  }

  private async enforce(
    key: string,
    limit: RateLimitSettings,
    name: RateLimitName,
    session: string,
  ): Promise<void> {
    const hit = await this.rateLimiter.hit(key, limit);
    if (!hit.allowed) {
      this.logger.warn(`Session rate limit hit limit=${name} session=${session}`);
      throw rateLimitedException(name, hit.retryAfterSeconds);
    }
  }

  /** Redis down: refuse refreshes rather than skip the limit (D-023); access checks don't need it. */
  private async withRateLimiter<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) {
        this.logger.warn(`Session refresh refused: ${error.message}`);
        throw serviceUnavailableException();
      }
      throw error;
    }
  }

  /** The database is where sessions are decided: if it can't answer, nothing is decided. */
  private async withDatabase<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ApiException) {
        throw error;
      }
      this.logger.error(
        `Session store unavailable: ${describeError(withoutQueryParameters(error))}`,
      );
      throw serviceUnavailableException();
    }
  }
}
