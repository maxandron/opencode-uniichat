import { expect, test } from "bun:test";
import { Media, Message } from "@opencode/ai";
import { hostMessages } from "./messages.ts";

// Stands in for the `@opencode/ai` copy OpenCode runs: its classes differ from the plugin's.
class HostAsset {
  constructor(readonly input: { source: Media.Asset["source"] }) {}
  get source() { return this.input.source; }
}
class HostMessage {
  constructor(readonly input: { role: string; content: unknown[] }) {}
  get content() { return this.input.content as { type: string; media?: unknown }[]; }
  static make(input: { role: string; content: unknown }) {
    const content = Message.content(input.content as never) as { type: string; media?: unknown }[];
    if (content.some((part) => part.type === "media" && !(part.media instanceof HostAsset))) throw new Error("Schema validation failed");
    return new HostMessage({ ...input, content });
  }
}
const png = { type: "base64" as const, data: "iVBORw0KGgo=", mediaType: "image/png" };
const host = [HostMessage.make({ role: "user", content: [{ type: "media", media: new HostAsset({ source: png }) }] })] as unknown as Message[];

test("an attachment OpenCode made goes back to OpenCode in its own classes", () => {
  const [out] = host.map(hostMessages(host)) as unknown as HostMessage[];
  expect(out).toBeInstanceOf(HostMessage);
  expect(out!.content[0]!.media).toBeInstanceOf(HostAsset);
});

test("an attachment the plugin rebuilt is moved to OpenCode's asset class", () => {
  const ours = { role: "user" as const, content: [Message.media(Media.base64(png.data, png.mediaType))] };
  const [out] = [ours].map(hostMessages(host)) as unknown as HostMessage[];
  expect((out!.content[0]!.media as HostAsset).source).toEqual(png);
  expect(out!.content[0]!.media).toBeInstanceOf(HostAsset);
});

test("with no OpenCode messages to learn from, the plugin's own classes are used", () => {
  const [out] = [{ role: "user" as const, content: [Message.media(Media.base64(png.data, png.mediaType))] }].map(hostMessages([]));
  expect(out).toBeInstanceOf(Message);
});
