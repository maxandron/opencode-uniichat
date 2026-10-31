import * as fs from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Path } from "@opencode/util/global";
import { Data, Effect } from "effect";
import type { LogRecord } from "./record.ts";
import { last, type Ref } from "./tree.ts";
import { serializeBatch } from "./view.ts";

export class StoreError extends Data.TaggedError("StoreError")<{
  op: string;
  path: string;
  cause: unknown;
}> {
  override get message(): string {
    return `UniiChat ${this.op} failed at ${this.path}: ${String(this.cause)}`;
  }
}

export interface StoredNode { l: number; i: number; text: string; size: number }
export interface Batch { chat: boolean; compaction: boolean }
export interface TornLine { path: string; line: number }
export interface Loaded {
  records: LogRecord[];
  nodes: StoredNode[];
  view?: Ref[];
  compView?: Ref[];
  batch: Batch;
  system?: string;
  agents: Map<string, LogRecord[]>;
  tornLines: TornLine[];
}

export const chatDir = (sessionID: string): string => join(Path.data, "uniichat", sessionID);

function attempt<A>(op: string, path: string, f: () => A): Effect.Effect<A, StoreError> {
  return Effect.try({ try: f, catch: (cause) => new StoreError({ op, path, cause }) });
}

function day(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid record date");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fd, data, offset, data.length - offset);
    if (written === 0) throw new Error("Write made no progress");
    offset += written;
  }
  fs.fsyncSync(fd);
}

function atomic(path: string, text: string): void {
  atomicMany([[path, text]]);
}

function atomicMany(entries: readonly (readonly [string, string])[]): void {
  const files = entries.map(([path, text]) => ({ path, text, temp: `${path}.${randomUUID()}.tmp` }));
  try {
    for (const { temp, text } of files) {
      const fd = fs.openSync(temp, "wx", 0o600);
      try { writeAll(fd, Buffer.from(text)); } finally { fs.closeSync(fd); }
    }
    for (const { temp, path } of files) fs.renameSync(temp, path);
    for (const dir of new Set(files.map(({ path }) => dirname(path)))) {
      const fd = fs.openSync(dir, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  } finally {
    for (const { temp } of files) {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
}

const snapshotNames = ["view.json", "compaction-view.json", "view-batch.json"];

function syncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function recoverSnapshot(dir: string): void {
  const marker = join(dir, "snapshot.commit");
  const committed = fs.existsSync(marker);
  let changed = false;
  for (const name of snapshotNames) {
    const path = join(dir, name);
    const temp = `${path}.tmp`;
    if (!fs.existsSync(temp)) continue;
    if (committed) fs.renameSync(temp, path);
    else fs.unlinkSync(temp);
    changed = true;
  }
  if (committed) {
    syncDir(dir);
    fs.unlinkSync(marker);
  }
  if (changed || committed) syncDir(dir);
}

function snapshot(dir: string, texts: readonly string[]): void {
  recoverSnapshot(dir);
  for (const [i, name] of snapshotNames.entries()) {
    const fd = fs.openSync(join(dir, `${name}.tmp`), "wx", 0o600);
    try { writeAll(fd, Buffer.from(texts[i]!)); } finally { fs.closeSync(fd); }
  }
  const fd = fs.openSync(join(dir, "snapshot.commit"), "wx", 0o600);
  try { writeAll(fd, Buffer.from("")); } finally { fs.closeSync(fd); }
  // Flush the temp names and marker before any rename can publish the snapshot.
  syncDir(dir);
  recoverSnapshot(dir);
}

function jsonl<A>(path: string, torn: TornLine[]): A[] {
  const text = fs.readFileSync(path, "utf8");
  const lines = text.split("\n");
  const result: A[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && lines[i] === "") continue;
    try { result.push(JSON.parse(lines[i]) as A); } catch {
      torn.push({ path, line: i + 1 });
    }
  }
  return result;
}

function append(path: string, value: unknown, raw?: string): void {
  const fd = fs.openSync(path, "a+", 0o600);
  try {
    const size = fs.fstatSync(fd).size;
    const end = Buffer.alloc(1);
    if (size && fs.readSync(fd, end, 0, 1, size - 1) && end[0] !== 10) {
      // Flush the separator before a new record can follow a torn line.
      writeAll(fd, Buffer.from("\n"));
    }
    writeAll(fd, Buffer.from(`${raw ?? JSON.stringify(value)}\n`));
  } finally { fs.closeSync(fd); }
}

function safeName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error("Name must be one file name");
  }
}

function optional(path: string): string | undefined {
  try { return fs.readFileSync(path, "utf8"); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

// Rewrite a directory's day files without the lines `drop` selects, appending those to `archive`.
function cutLines(dir: string, archive: string, drop: (value: any) => boolean): number {
  let dropped = 0;
  for (const file of fs.readdirSync(dir).filter((s) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(s)).sort()) {
    const path = join(dir, file);
    const keep: string[] = [];
    const gone: string[] = [];
    for (const line of fs.readFileSync(path, "utf8").split("\n")) {
      if (line === "") continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { keep.push(line); continue; }
      (drop(value) ? gone : keep).push(line);
    }
    if (!gone.length) continue;
    append(archive, undefined, gone.join("\n"));
    atomic(path, keep.map((line) => `${line}\n`).join(""));
    dropped += gone.length;
  }
  return dropped;
}

export class Store {
  private constructor(readonly dir: string) {}

  static open(dir: string): Effect.Effect<Store, StoreError> {
    return Effect.gen(function* () {
      yield* attempt("mkdir", dir, () => fs.mkdirSync(dir, { recursive: true }));
      yield* attempt("mkdir", dir, () => {
        for (const name of ["main", "tree", "agents", "files"]) fs.mkdirSync(join(dir, name), { recursive: true });
      });
      return new Store(dir);
    });
  }

  load(): Effect.Effect<Loaded, StoreError> {
    return attempt("load", this.dir, () => {
      recoverSnapshot(this.dir);
      const tornLines: TornLine[] = [];
      const days = <A>(name: string): A[] => {
        const dir = join(this.dir, name);
        return fs.readdirSync(dir).filter((s) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(s)).sort()
          .flatMap((s) => jsonl<A>(join(dir, s), tornLines));
      };
      const readJSON = <A>(name: string): A | undefined => {
        const text = optional(join(this.dir, name));
        return text === undefined ? undefined : JSON.parse(text) as A;
      };
      const agents = new Map<string, LogRecord[]>();
      for (const file of fs.readdirSync(join(this.dir, "agents")).sort()) {
        if (!file.endsWith(".jsonl")) continue;
        agents.set(file.slice(0, -6), jsonl<LogRecord>(join(this.dir, "agents", file), tornLines).sort((a, b) => a.i - b.i));
      }
      const nodes = new Map<string, StoredNode>();
      for (const node of days<StoredNode>("tree")) {
        const id = `${node.l}:${node.i}`;
        if (!nodes.has(id)) nodes.set(id, node);
      }
      return {
        records: days<LogRecord>("main").sort((a, b) => a.i - b.i),
        nodes: [...nodes.values()],
        view: readJSON<Ref[]>("view.json"),
        compView: readJSON<Ref[]>("compaction-view.json"),
        batch: readJSON<Batch>("view-batch.json") ?? serializeBatch(false, false),
        system: optional(join(this.dir, "system.txt")), agents, tornLines,
      };
    });
  }

  appendRecord(rec: LogRecord): Effect.Effect<void, StoreError> {
    return attempt("appendRecord", join(this.dir, "main"), () => append(join(this.dir, "main", `${day(new Date(rec.date))}.jsonl`), rec));
  }

  appendNode(node: StoredNode): Effect.Effect<void, StoreError> {
    return attempt("appendNode", join(this.dir, "tree"), () => append(join(this.dir, "tree", `${day(new Date())}.jsonl`), node));
  }

  saveViews(chat: readonly Ref[], comp: readonly Ref[], batch: Batch): Effect.Effect<void, StoreError> {
    return attempt("saveViews", this.dir, () => {
      snapshot(this.dir, [
        JSON.stringify(chat),
        JSON.stringify(comp),
        JSON.stringify(serializeBatch(batch.chat, batch.compaction)),
      ]);
    });
  }

  // Undo in OpenCode deleted the turns from record k on. Move their records, the tree nodes that
  // cover them and their attachments to undone/<stamp>/, so record k can be written again.
  // Order matters for crash safety: tree and files first, then the views, then the log.
  // A crash in between leaves extra records that the next rewind removes again.
  rewind(k: number, chat: readonly Ref[], comp: readonly Ref[], batch: Batch): Effect.Effect<void, StoreError> {
    return attempt("rewind", this.dir, () => {
      const archive = join(this.dir, "undone", new Date().toISOString().replace(/[:.]/g, "-"));
      fs.mkdirSync(join(archive, "files"), { recursive: true });
      const cut = (name: string, drop: (value: any) => boolean) => cutLines(join(this.dir, name), join(archive, `${name}.jsonl`), drop);
      cut("tree", (node: StoredNode) => last(node.l, node.i) >= k);
      for (const file of fs.readdirSync(join(this.dir, "files"))) {
        const match = /^(\d+)-\d+\./.exec(file);
        if (match && Number(match[1]) >= k) fs.renameSync(join(this.dir, "files", file), join(archive, "files", file));
      }
      snapshot(this.dir, [JSON.stringify(chat), JSON.stringify(comp), JSON.stringify(serializeBatch(batch.chat, batch.compaction))]);
      cut("main", (rec: LogRecord) => rec.i >= k);
    });
  }

  /** The day file ("YYYY-MM-DD") each tree node was first written to, by "l:i". */
  nodeDays(): Effect.Effect<Map<string, string>, StoreError> {
    return attempt("nodeDays", join(this.dir, "tree"), () => {
      const days = new Map<string, string>();
      const dir = join(this.dir, "tree");
      for (const file of fs.readdirSync(dir).filter((s) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(s)).sort()) {
        for (const node of jsonl<StoredNode>(join(dir, file), [])) {
          const id = `${node.l}:${node.i}`;
          if (!days.has(id)) days.set(id, file.slice(0, 10));
        }
      }
      return days;
    });
  }

  // `/unii repair`: move the given tree nodes ("l:i") to repaired/<stamp>/tree.jsonl, so they are
  // built again from the log. Returns the archive directory.
  dropNodes(ids: ReadonlySet<string>): Effect.Effect<string, StoreError> {
    return attempt("dropNodes", this.dir, () => {
      const archive = join(this.dir, "repaired", new Date().toISOString().replace(/[:.]/g, "-"));
      fs.mkdirSync(archive, { recursive: true });
      cutLines(join(this.dir, "tree"), join(archive, "tree.jsonl"), (node: StoredNode) => ids.has(`${node.l}:${node.i}`));
      return archive;
    });
  }

  saveSystem(text: string): Effect.Effect<void, StoreError> {
    const path = join(this.dir, "system.txt");
    return attempt("saveSystem", path, () => {
      atomic(path, text);
    });
  }

  appendAgent(name: string, rec: LogRecord): Effect.Effect<void, StoreError> {
    return attempt("appendAgent", join(this.dir, "agents"), () => {
      safeName(name);
      append(join(this.dir, "agents", `${name}.jsonl`), rec);
    });
  }

  readAgent(name: string): Effect.Effect<LogRecord[] | undefined, StoreError> {
    return attempt("readAgent", join(this.dir, "agents"), () => {
      safeName(name);
      const path = join(this.dir, "agents", `${name}.jsonl`);
      if (!fs.existsSync(path)) return undefined;
      const torn: TornLine[] = [];
      const records = jsonl<LogRecord>(path, torn).sort((a, b) => a.i - b.i);
      for (const line of torn) console.warn(`UniiChat ignored torn line ${line.line} in ${line.path}`);
      return records;
    });
  }

  saveFile(name: string, data: Uint8Array): Effect.Effect<string, StoreError> {
    return attempt("saveFile", join(this.dir, "files"), () => {
      safeName(name);
      const fd = fs.openSync(join(this.dir, "files", name), "wx", 0o600);
      try { writeAll(fd, data); } finally { fs.closeSync(fd); }
      return `files/${name}`;
    });
  }

  readFile(rel: string): Effect.Effect<Uint8Array, StoreError> {
    return attempt("readFile", join(this.dir, "files"), () => {
      if (!rel.startsWith("files/") || rel.includes("\\")) throw new Error("Invalid attachment path");
      safeName(rel.slice(6));
      const path = resolve(this.dir, rel);
      const root = fs.realpathSync(join(this.dir, "files")) + sep;
      if (!fs.realpathSync(path).startsWith(root)) throw new Error("Attachment is outside files");
      return fs.readFileSync(path);
    });
  }
}
