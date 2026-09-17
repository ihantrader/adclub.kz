import { describe, expect, it } from "vitest";
import {
  dailyAt,
  deadLetterQueueName,
  defineJob,
  definePeriodicJob,
  defineSweeperJob,
  EVERY_MINUTE,
} from "./job-definition";
import { z } from "zod";

const retry = { limit: 1, delaySeconds: 1, backoff: false };

describe("job declarations", () => {
  it("accepts a well-formed name and refuses anything else", () => {
    expect(
      defineJob({
        name: "identity.send-code",
        payload: z.object({}),
        timeoutSeconds: 10,
        retry,
        singleton: false,
      }).kind,
    ).toBe("on_demand");
    for (const name of [
      "Identity.Send",
      "identity",
      "identity.",
      "identity.send_code",
      "x.y.dead",
    ]) {
      expect(() =>
        defineJob({
          name,
          payload: z.object({}),
          timeoutSeconds: 10,
          retry,
          singleton: false,
        }),
      ).toThrow(/Invalid job name/);
    }
  });

  it("refuses an impossible time limit or retry rule", () => {
    const base = { name: "test.job", timeoutSeconds: 10, retry, singleton: false };
    expect(() =>
      definePeriodicJob({ ...base, timeoutSeconds: 0, schedule: () => EVERY_MINUTE }),
    ).toThrow(/timeoutSeconds/);
    expect(() =>
      definePeriodicJob({
        ...base,
        retry: { limit: -1, delaySeconds: 0, backoff: false },
        schedule: () => EVERY_MINUTE,
      }),
    ).toThrow(/retry/);
  });

  it("gives a sweeper a minute schedule, one run at a time and bounded batches", () => {
    const sweeper = defineSweeperJob({ name: "orders.expire-unanswered" });
    expect(sweeper).toMatchObject({
      kind: "periodic",
      singleton: true,
      sweep: { batchSize: 500, maxRunSeconds: 60 },
    });
    expect(sweeper.schedule(() => Promise.reject(new Error("no settings")))).toBe(EVERY_MINUTE);
    expect(() => defineSweeperJob({ name: "x.y", batchSize: 0 })).toThrow(/batchSize/);
    expect(() => defineSweeperJob({ name: "x.y", timeoutSeconds: 10, maxRunSeconds: 10 })).toThrow(
      /maxRunSeconds/,
    );
  });

  it("writes a daily Almaty schedule and names the dead letter queue", () => {
    expect(dailyAt(10)).toBe("0 10 * * *");
    expect(dailyAt(0, 5)).toBe("5 0 * * *");
    expect(() => dailyAt(24)).toThrow(/hour/);
    expect(() => dailyAt(1, 60)).toThrow(/minute/);
    expect(deadLetterQueueName("identity.send-code")).toBe("identity.send-code.dead");
  });
});
