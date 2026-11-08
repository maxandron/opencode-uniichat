import { expect, test } from "bun:test";
import { AssistantMessage, Media, Message, ToolMessage, UserMessage } from "@opencode/ai/effect";
import { hostMessages } from "./messages.ts";

// Stands in for the `@opencode/ai` copy OpenCode runs (2.2.6 on): one class per role, all distinct
// from the plugin's, each rejecting an attachment of another copy's asset class.
class HostAsset {
  constructor(readonly input: { source: Media.Asset["source"] }) {}
  get source() { return this.input.source; }
}
type Part = { type: string; media?: unknown };
const check = (content: readonly Part[]) => {
  if (content.some((part) => part.type === "media" && !(part.media instanceof HostAsset))) throw new Error("Schema validation failed");
  return content;
};
class HostUser {
  readonly role = "user";
  readonly content: readonly Part[];
  constructor(input: { content: readonly Part[] }) { this.content = check(input.content); }
  // Effect's schema-class `make`, which throws when detached from its class; the plugin must not use it.
  static get make() { return () => { throw new TypeError("undefined is not a constructor"); }; }
}
class HostAssistant {
  readonly role = "assistant";
  readonly content: readonly Part[];
  constructor(input: { content: readonly Part[] }) { this.content = check(input.content); }
}
const png = { type: "base64" as const, data: "iVBORw0KGgo=", mediaType: "image/png" };
const host = [
  new HostUser({ content: [{ type: "media", media: new HostAsset({ source: png }) }] }),
  new HostAssistant({ content: [{ type: "text" }] }),
] as unknown as Message[];

test("an attachment OpenCode made goes back to OpenCode in its own classes", () => {
  const [out] = host.slice(0, 1).map(hostMessages(host)) as unknown as HostUser[];
  expect(out).toBeInstanceOf(HostUser);
  expect(out!.content[0]!.media).toBeInstanceOf(HostAsset);
});

test("an attachment the plugin rebuilt is moved to OpenCode's asset class", () => {
  const ours = { role: "user" as const, content: [Message.media(Media.base64(png.data, png.mediaType))] };
  const [out] = [ours].map(hostMessages(host)) as unknown as HostUser[];
  expect(out).toBeInstanceOf(HostUser);
  expect((out!.content[0]!.media as HostAsset).source).toEqual(png);
  expect(out!.content[0]!.media).toBeInstanceOf(HostAsset);
});

test("each role is built with OpenCode's class for that role", () => {
  const out = [
    { role: "assistant" as const, content: [{ type: "text" as const, text: "reply" }] },
    { role: "user" as const, content: [{ type: "text" as const, text: "next" }] },
  ].map(hostMessages(host));
  expect(out[0]).toBeInstanceOf(HostAssistant);
  expect(out[1]).toBeInstanceOf(HostUser);
});

test("a role OpenCode sent none of falls back to the plugin's own class", () => {
  const result = { type: "tool-result" as const, id: "call_1", name: "read", result: { type: "text" as const, value: "ok" } };
  const [out] = [{ role: "tool" as const, content: [result] }].map(hostMessages(host));
  expect(out).toBeInstanceOf(ToolMessage);
});

test("with no OpenCode messages to learn from, the plugin's own classes are used", () => {
  const out = [
    { role: "user" as const, content: [Message.media(Media.base64(png.data, png.mediaType))] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "reply" }] },
  ].map(hostMessages([]));
  expect(out[0]).toBeInstanceOf(UserMessage);
  expect(out[1]).toBeInstanceOf(AssistantMessage);
});
