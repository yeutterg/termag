import { scrubSentryEvent } from "../sentry-scrub";

describe("scrubSentryEvent", () => {
  test("removes secrets from string, record, and tuple query representations", () => {
    expect(
      scrubSentryEvent({ request: { query_string: "safe=1&token=gone&passwordHint=gone" } }).request
        .query_string
    ).toBe("safe=1");
    expect(
      scrubSentryEvent({ request: { query_string: { safe: "1", secretKey: "gone" } } }).request
        .query_string
    ).toEqual({ safe: "1" });
    expect(
      scrubSentryEvent({
        request: {
          query_string: [
            ["safe", "1"],
            ["Token", "gone"],
          ] as Array<[string, string]>,
        },
      }).request.query_string
    ).toEqual([["safe", "1"]]);
  });

  test("does not throw on malformed percent encoding and strips credential headers", () => {
    const event = {
      request: {
        headers: { authorization: "secret", cookie: "secret", accept: "application/json" },
        query_string: "%ZZ=1&safe=2",
      },
    };
    expect(() => scrubSentryEvent(event)).not.toThrow();
    expect(event.request.headers).toEqual({ accept: "application/json" });
    expect(event.request.query_string).toBe("%ZZ=1&safe=2");
  });
});
