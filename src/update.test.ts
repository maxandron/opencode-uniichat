import { afterEach, expect, test } from "bun:test";
import { available, LATEST_URL, newer, reset, VERSION } from "./update.ts";

afterEach(reset);

test("versions compare numerically", () => {
  expect(newer("0.2.10", "0.2.9")).toBe(true);
  expect(newer("v1.0.0", "0.9.9")).toBe(true);
  expect(newer("0.2.4", "0.2.4")).toBe(false);
  expect(newer("0.2.3", "0.2.4")).toBe(false);
  expect(newer("unknown", "0.2.4")).toBe(false);
});

test("a newer version on main is reported after one shared check; failures report nothing", async () => {
  const urls: string[] = [];
  const later = VERSION.replace(/\d+$/, (n) => String(Number(n) + 1));
  const fetcher = (async (url: string) => { urls.push(url); return Response.json({ version: later }); }) as unknown as typeof fetch;
  expect(available(fetcher, 1e13)).toBeUndefined();
  await Bun.sleep(20);
  expect(available(fetcher, 1e13 + 1)).toBe(later);
  expect(urls).toEqual([LATEST_URL]);

  reset();
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  available(offline, 1e13);
  await Bun.sleep(20);
  expect(available(offline, 1e13 + 1)).toBeUndefined();
});
