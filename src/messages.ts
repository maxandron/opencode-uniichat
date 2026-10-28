// Session rows -> model messages, for the part of a turn that a UniiChat stub compaction hid from
// OpenCode's request. A port of OpenCode's `session/runner/to-llm-message.ts` (v2.1.0), which
// plugins cannot import. Native provider checkpoints are left out: a turn cut by one still fails.
import { Media, Message, ReasoningEfforts, ToolCallPart, ToolResultPart, type ContentPart, type ProviderMetadata } from "@opencode/ai/effect";
import { fileURLToPath } from "node:url";
import type { Row } from "./history.ts";

type UserRow = Extract<Row, { type: "user" }>;
type File = NonNullable<UserRow["files"]>[number];
type AssistantRow = Extract<Row, { type: "assistant" }>;
type ToolPart = Extract<AssistantRow["content"][number], { type: "tool" }>;
export interface ModelRef { readonly providerID: string; readonly id: string; readonly variant?: string }

const imageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const location = (file: File) => {
  if (file.source.type !== "uri") return undefined;
  const url = URL.parse(file.source.uri);
  if (url?.protocol !== "file:") return undefined;
  try { return fileURLToPath(url); } catch { return undefined; }
};

const attached = (file: File, label: string, name: string | undefined, body: string | undefined): ContentPart => ({
  type: "text",
  text: `\n\n${[
    `${label}: ${name}`,
    file.description === undefined ? undefined : `Description: ${file.description}`,
    body === undefined ? undefined : "",
    body,
  ].filter((line): line is string => line !== undefined).join("\n")}`,
  metadata: { attachment: { source: file.source, name: file.name, description: file.description } },
});

const attachment = (file: File): ContentPart[] => {
  const uri = file.source.type === "uri" ? file.source.uri : undefined;
  if (file.mime === "text/plain") {
    return [attached(file, "Attached file", file.name ?? uri ?? "inline attachment", Buffer.from(file.data, "base64").toString("utf8"))];
  }
  if (file.mime === "application/x-directory") {
    return [attached(file, "Attached directory", location(file) ?? file.name ?? uri ?? "directory", file.data.length === 0 ? undefined : Buffer.from(file.data, "base64").toString("utf8"))];
  }
  if (imageMimes.has(file.mime) || file.mime === "application/pdf") {
    const at = location(file);
    const media: ContentPart = {
      type: "media",
      media: Media.base64(file.data, file.mime),
      filename: file.name,
      metadata: file.description === undefined ? undefined : { description: file.description },
    } as ContentPart;
    return [...(at === undefined ? [] : [Message.text(`Attached file: ${at}`)]), media];
  }
  return [];
};

const attachments = (files: readonly File[]): ContentPart[] => {
  const eligible = files.filter((file) => imageMimes.has(file.mime) && file.source.type === "inline" && file.mention?.text);
  if (eligible.length < 2) return files.flatMap(attachment);
  const seen = new Map<string, Set<string>>();
  return files.flatMap((file) => {
    if (!imageMimes.has(file.mime) || file.source.type !== "inline" || !file.mention?.text) return attachment(file);
    const key = JSON.stringify([file.mime, file.name ?? null, file.description ?? null, file.mention.text]);
    const payloads = seen.get(key) ?? new Set<string>();
    if (payloads.has(file.data)) return [];
    payloads.add(file.data);
    seen.set(key, payloads);
    return attachment(file);
  });
};

const meta = (key: string, state: Record<string, unknown> | undefined): ProviderMetadata | undefined =>
  state === undefined ? undefined : { [key]: state } as ProviderMetadata;

const toolInput = (tool: ToolPart) => {
  if (tool.state.status !== "streaming") return tool.state.input;
  try { return JSON.parse(tool.state.input as string); } catch { return tool.state.input; }
};

const toolResult = (tool: ToolPart, providerMetadata: ProviderMetadata | undefined) => {
  if (tool.state.status === "completed") {
    const content = tool.state.content;
    const single = content.length === 1 ? content[0] : undefined;
    return ToolResultPart.make({
      id: tool.id,
      name: tool.name,
      result: single?.type === "text" ? { type: "text" as const, value: single.text } : { type: "content" as const, value: content },
      providerExecuted: tool.executed,
      providerMetadata,
    } as Parameters<typeof ToolResultPart.make>[0]);
  }
  if (tool.state.status === "error") {
    return ToolResultPart.make({
      id: tool.id,
      name: tool.name,
      result: { error: tool.state.error, content: tool.state.content ?? [] },
      resultType: "error",
      providerExecuted: tool.executed,
      providerMetadata,
    } as Parameters<typeof ToolResultPart.make>[0]);
  }
  return undefined;
};

const assistant = (message: AssistantRow, model: ModelRef, key: string): Message[] => {
  const sameProvider = String(message.model.providerID) === String(model.providerID);
  const sameModel = sameProvider && String(message.model.id) === String(model.id);
  const reuse = sameModel && message.error === undefined;
  const interrupted = message.content.some((item) => item.type === "reasoning" && item.time !== undefined && item.time.completed === undefined);
  const content = message.content.flatMap((item): ContentPart[] => {
    if (item.type === "text") return [{ type: "text", text: item.text, providerMetadata: reuse ? meta(key, item.native) : undefined } as ContentPart];
    if (item.type === "reasoning") {
      if (reuse && !interrupted) return [{ type: "reasoning", text: item.text, providerMetadata: meta(key, item.native) } as ContentPart];
      return item.text.length > 0 ? [{ type: message.error === undefined && !interrupted ? "reasoning" : "text", text: item.text } as ContentPart] : [];
    }
    if (item.type !== "tool") return [];
    const reuseTool = reuse || (sameModel && item.executed === true && (item.state.status === "completed" || item.state.status === "error"));
    const call = ToolCallPart.make({
      id: item.id,
      name: item.name,
      input: toolInput(item),
      providerExecuted: item.executed,
      providerMetadata: reuseTool ? meta(key, item.native) : undefined,
    } as Parameters<typeof ToolCallPart.make>[0]);
    if (item.executed !== true) return [call];
    const result = toolResult(item, sameProvider ? meta(key, item.native) : undefined);
    return result ? [call, result] : [call];
  });
  const meaningful = content.filter((part) => {
    if (part.type === "text") return part.text !== "";
    if (part.type !== "reasoning") return true;
    return part.text !== "" || (part.providerMetadata !== undefined && Object.keys(part.providerMetadata).length > 0);
  });
  const results = message.content
    .filter((item): item is ToolPart => item.type === "tool" && item.executed !== true)
    .map((item) => toolResult(item, reuse ? meta(key, item.native) : undefined))
    .filter((part) => part !== undefined)
    .map((part) => Message.tool(part));
  if (meaningful.length === 0) return results;
  return [Message.make({ id: message.id, role: "assistant", content: meaningful, metadata: message.metadata }), ...results];
};

const efforts = new Set<string>(ReasoningEfforts);
const variantEffort = (variant: string | undefined) => {
  if (variant === undefined || variant === "default") return { effort: undefined };
  return efforts.has(variant) ? { effort: variant as (typeof ReasoningEfforts)[number] } : undefined;
};

function toMessage(row: Row, model: ModelRef, key: string): Message[] {
  switch (row.type) {
    case "model-switched": {
      const previous = row.previous;
      if (previous === undefined) return [];
      const same = (ref: { providerID: string; id: string }) => ref.providerID === model.providerID && ref.id === model.id;
      if (!same(row.model) || !same(previous)) return [];
      const to = variantEffort(row.model.variant), from = variantEffort(previous.variant);
      if (to === undefined || from === undefined) return [];
      return [Message.effort({ effort: to.effort, previous: from.effort })];
    }
    case "location-switched":
      return [Message.make({ id: row.id, role: "user", content: `The working directory has been changed to ${row.location.directory}.`, metadata: row.metadata })];
    case "user": {
      const content = [
        ...(row.skills ?? []).flatMap((skill) => skill.text === undefined ? [] : [Message.text(skill.text)]),
        ...(row.text === "" ? [] : [Message.text(row.text)]),
        ...attachments(row.files ?? []),
      ];
      if (content.length === 0) return [];
      return [Message.make({ id: row.id, role: "user", content, metadata: { ...row.metadata, ...(row.agents?.length ? { agents: row.agents } : {}) } })];
    }
    case "synthetic":
      return [Message.make({ id: row.id, role: "user", content: row.text })];
    case "skill":
      return [Message.make({ id: row.id, role: "user", content: row.text, metadata: row.metadata })];
    case "system":
      return [Message.system(row.text)];
    case "shell":
      if (row.metadata?.background === true) return [];
      return [Message.make({
        id: row.id,
        role: "user",
        content: `The following shell command was executed by the user:\n\nCommand:\n${row.command}\n\nOutput:\n${row.output?.output ?? ""}`,
        metadata: row.metadata,
      })];
    case "assistant":
      return assistant(row, model, key);
    default:
      // idle, agent-switched; compactions are handled by the caller.
      return [];
  }
}

/** Model messages for `rows`, as OpenCode would send them to `model`. */
export function toMessages(rows: readonly Row[], model: ModelRef, key: string = model.providerID): Message[] {
  return rows.flatMap((row) => toMessage(row, model, key));
}

type Make = (input: Pick<Message, "role" | "content"> & Partial<Pick<Message, "id" | "metadata" | "providerMetadata" | "native">>) => Message;
type AssetClass = new (input: { source: Media.Asset["source"]; info?: Media.Asset["info"]; providerMetadata?: Media.Asset["providerMetadata"]; headers?: Media.Asset["headers"] }) => Media.Asset;

/**
 * Builds request messages with the classes of the `@opencode/ai` copy OpenCode itself runs, taken from the
 * messages it handed over. The plugin ships its own copy, and `Message` checks `media` with `instanceof
 * Media.Asset`: an attachment OpenCode made fails the plugin's `Message.make`, and one the plugin made could
 * fail OpenCode's. Each attachment is moved to the class of the copy that builds its message.
 */
export function hostMessages(host: readonly Message[]): (input: Parameters<Make>[0]) => Message {
  const own = { make: Message.make as Make, Asset: Media.Asset as AssetClass };
  const found = host.find((message) => typeof (message?.constructor as { make?: unknown } | undefined)?.make === "function");
  const make = found ? (found.constructor as unknown as { make: Make }).make : own.make;
  const media = host.flatMap((message) => message.content).find((part) => part.type === "media");
  const hostAsset = media && media.type === "media" ? media.media.constructor as AssetClass : undefined;
  const adopt = (input: Parameters<Make>[0], Asset: AssetClass): Parameters<Make>[0] => ({
    ...input,
    content: Message.content(input.content).map((part) => part.type !== "media" || part.media instanceof Asset ? part : {
      ...part,
      media: new Asset({ source: part.media.source, info: part.media.info, providerMetadata: part.media.providerMetadata, headers: part.media.headers }),
    }),
  });
  return (input) => {
    if (make === own.make) return own.make(adopt(input, own.Asset));
    if (hostAsset) return make(adopt(input, hostAsset));
    // OpenCode sent no attachment to learn its asset class from; one made here can only pass the plugin's own check.
    try { return make(input); } catch { return own.make(adopt(input, own.Asset)); }
  };
}
