import { prefersLowDataMode } from "../mobile-data";

describe("native iOS terminal data policy", () => {
  const keys = ["window", "document", "navigator"] as const;
  const original = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));

  afterEach(() => {
    keys.forEach((key, index) => {
      const descriptor = original[index];
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    });
  });

  function browser(native: boolean) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { matchMedia: () => ({ matches: false }) },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { documentElement: { dataset: native ? { terminalzNative: "true" } : {} } },
    });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  }

  test("large native iPads use low-data even beyond the portable viewport breakpoint", () => {
    browser(true);
    expect(prefersLowDataMode()).toBe(true);
  });

  test("unconstrained desktop web clients retain normal mode", () => {
    browser(false);
    expect(prefersLowDataMode()).toBe(false);
  });
});
