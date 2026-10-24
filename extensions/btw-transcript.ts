import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

export type BtwTranscriptEntry =
  | { id: number; turnId: number; type: "turn-boundary"; phase: "start" | "end"; outcome?: "completed" | "aborted" | "failed" }
  | { id: number; turnId: number; type: "user-message"; text: string }
  | { id: number; turnId: number; type: "thinking"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "assistant-text"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "assistant-message"; message: AssistantMessage; streaming: boolean }
  | {
      id: number;
      turnId: number;
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: string;
      argsValue?: unknown;
      executionStarted?: boolean;
      argsComplete?: boolean;
    }
  | {
      id: number;
      turnId: number;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      content: string;
      truncated: boolean;
      isError: boolean;
      streaming: boolean;
      resultValue?: {
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        details?: unknown;
        isError: boolean;
        durationMs?: number;
      };
    };

export type BtwTranscript = BtwTranscriptEntry[];

type UserEntry = Extract<BtwTranscriptEntry, { type: "user-message" }>;
type LegacyTextEntry = Extract<BtwTranscriptEntry, { type: "thinking" | "assistant-text" }>;
type ToolCallEntry = Extract<BtwTranscriptEntry, { type: "tool-call" }>;
type ToolResultEntry = Extract<BtwTranscriptEntry, { type: "tool-result" }>;
type ToolResult = NonNullable<ToolResultEntry["resultValue"]>;
type Outcome = Extract<BtwTranscriptEntry, { type: "turn-boundary" }>["outcome"];

type AssistantNode = {
  kind: "assistant";
  id: number;
  turnId: number;
  message: AssistantMessage;
  streaming: boolean;
  legacy?: LegacyTextEntry[];
};
type ToolNode = {
  kind: "tool";
  id: number;
  turnId: number;
  name: string;
  callId: string;
  call?: ToolCallEntry;
  result?: ToolResultEntry;
  failure?: ToolResult;
  ended?: boolean;
};
type Node = { kind: "user"; id: number; turnId: number; entry: UserEntry } | AssistantNode | ToolNode;

type CachedComponent =
  | { kind: "user"; component: UserMessageComponent; text: string }
  | { kind: "assistant"; component: AssistantMessageComponent; signature?: string }
  | {
      kind: "tool";
      component: ToolExecutionComponent;
      signature?: string;
      renderers: ToolRenderers;
      name: string;
      callId: string;
      hasResult: boolean;
      executionStarted: boolean;
      argsComplete: boolean;
    };

// Each builtin has narrower argument types than the erased ToolRenderers API.
const TOOL_DEFINITION_FACTORIES = new Map<string, (cwd: string) => unknown>([
  ["bash", createBashToolDefinition],
  ["edit", createEditToolDefinition],
  ["find", createFindToolDefinition],
  ["grep", createGrepToolDefinition],
  ["ls", createLsToolDefinition],
  ["powershell", createPowerShellToolDefinition],
  ["read", createReadToolDefinition],
  ["write", createWriteToolDefinition],
]);
// An empty renderer definition selects Pi's expandable generic call/result renderers.
const GENERIC_RENDERERS: ToolRenderers = {};
const OSC133_PROMPT_MARKER_RE = /(?:\x1b\]|\x9d)133;[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g;

function signature(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    // Non-JSON custom details are still passed through intact; just update on every render.
    return undefined;
  }
}

function legacyMessage(content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function readArgs(call?: ToolCallEntry): unknown {
  if (!call) return {};
  if (call.argsValue !== undefined) return call.argsValue;
  try {
    return JSON.parse(call.args);
  } catch {
    // Old persisted/partial arguments need not be valid JSON. Do not discard them.
    return call.args || {};
  }
}

function readResult(entry?: ToolResultEntry): ToolResult | undefined {
  return entry?.resultValue ?? (entry ? {
    content: [{ type: "text", text: entry.content }], isError: entry.isError,
  } : undefined);
}

/** Adapt transcript state to Pi's own message/tool components, without executing tools. */
export class BtwTranscriptRenderer {
  private readonly components = new Map<string, CachedComponent>();
  private readonly builtinRenderers = new Map<string, ToolRenderers | undefined>();
  private expanded = false;
  private hideThinking = false;

  constructor(
    private readonly tui: TUI,
    private readonly cwd: string,
    private readonly getToolRenderers?: (name: string, builtin?: ToolRenderers) => ToolRenderers | undefined,
  ) {}

  private buildNodes(entries: BtwTranscript): Node[] {
    const nodes: Node[] = [];
    const calls = new Map<string, ToolNode>();
    const endings = new Map<number, { id: number; outcome: Outcome }>();
    let adjacent: AssistantNode | undefined;
    for (const entry of entries) {
      if (entry.type === "thinking" || entry.type === "assistant-text") {
        if (!adjacent || adjacent.turnId !== entry.turnId) {
          adjacent = {
            kind: "assistant", id: entry.id, turnId: entry.turnId,
            message: legacyMessage(), streaming: false, legacy: [],
          };
          nodes.push(adjacent);
        }
        adjacent.legacy!.push(entry);
        adjacent.message.content.push(entry.type === "thinking"
          ? { type: "thinking", thinking: entry.text }
          : { type: "text", text: entry.text });
        adjacent.streaming ||= entry.streaming;
        continue;
      }
      // Results update an earlier row, but still break adjacency between assistant blocks.
      adjacent = undefined;
      if (entry.type === "turn-boundary") {
        if (entry.phase === "end") endings.set(entry.turnId, { id: entry.id, outcome: entry.outcome });
      } else if (entry.type === "user-message") {
        nodes.push({ kind: "user", id: entry.id, turnId: entry.turnId, entry });
      } else if (entry.type === "assistant-message") {
        nodes.push({ kind: "assistant", id: entry.id, turnId: entry.turnId, message: entry.message, streaming: entry.streaming });
      } else if (entry.type === "tool-call") {
        const node: ToolNode = {
          kind: "tool", id: entry.id, turnId: entry.turnId,
          name: entry.toolName, callId: entry.toolCallId, call: entry,
        };
        nodes.push(node);
        calls.set(`${entry.turnId}:${entry.toolCallId}`, node);
      } else if (entry.type === "tool-result") {
        const key = `${entry.turnId}:${entry.toolCallId}`;
        let node = calls.get(key);
        if (!node) {
          // A partial/restored transcript may contain only a result. Keep its original position.
          node = { kind: "tool", id: entry.id, turnId: entry.turnId, name: entry.toolName, callId: entry.toolCallId };
          calls.set(key, node);
          nodes.push(node);
        }
        node.result = entry;
      }
    }

    const nodesByTurn = new Map<number, Node[]>();
    for (const node of nodes) {
      const turnNodes = nodesByTurn.get(node.turnId) ?? [];
      turnNodes.push(node);
      nodesByTurn.set(node.turnId, turnNodes);
    }
    for (const [turnId, end] of endings) {
      const turnNodes = nodesByTurn.get(turnId) ?? [];
      const failed = end.outcome === "aborted" || end.outcome === "failed";
      let pendingFailure = false;
      for (const node of turnNodes) {
        if (node.kind !== "tool") continue;
        node.ended = true;
        if (failed && (!node.result || node.result.streaming)) {
          const partialResult = readResult(node.result);
          node.failure = {
            ...partialResult,
            content: [
              ...(partialResult?.content ?? []),
              { type: "text", text: end.outcome === "aborted" ? "Operation aborted" : "Request failed" },
            ],
            isError: true,
          };
          pendingFailure = true;
        }
      }
      const last = turnNodes.at(-1);
      // Whole messages already contain the exact native stopReason/errorMessage. Boundaries
      // only supply that information for the old persisted text-only representation.
      if (failed && last?.kind === "assistant" && last.legacy) {
        last.message.stopReason = end.outcome === "aborted" ? "aborted" : "error";
        const failureText = last.legacy.at(-1);
        if (failureText?.type === "assistant-text" && failureText.text.startsWith("❌ ")) {
          last.message.errorMessage = failureText.text.slice(2).trim();
          last.message.content.pop();
        } else if (end.outcome === "failed") {
          last.message.errorMessage = "Request failed";
        }
      } else if (failed && !pendingFailure && (!last || last.kind === "user")) {
        const message = legacyMessage();
        message.stopReason = end.outcome === "aborted" ? "aborted" : "error";
        message.errorMessage = end.outcome === "aborted" ? "Operation aborted" : "Request failed";
        // Insert beside this turn, not at the end of a later exchange.
        const index = last ? nodes.indexOf(last) + 1 : nodes.findIndex((node) => node.turnId > turnId);
        nodes.splice(index < 0 ? nodes.length : index, 0, {
          kind: "assistant", id: end.id, turnId, message, streaming: false,
        });
      }
    }
    return nodes;
  }

  private toolRenderers(name: string): ToolRenderers {
    if (!this.builtinRenderers.has(name)) {
      this.builtinRenderers.set(name, TOOL_DEFINITION_FACTORIES.get(name)?.(this.cwd) as ToolRenderers | undefined);
    }
    const builtin = this.builtinRenderers.get(name);
    // The child session resolves custom renderers with this native definition as
    // next(). Its defined result is authoritative (including deliberate omissions).
    return this.getToolRenderers?.(name, builtin) ?? builtin ?? GENERIC_RENDERERS;
  }

  private componentFor(node: Node, key: string): CachedComponent {
    const cached = this.components.get(key);
    if (node.kind === "user") {
      if (cached?.kind === "user" && cached.text === node.entry.text) return cached;
      return { kind: "user", text: node.entry.text, component: new UserMessageComponent(node.entry.text, getMarkdownTheme()) };
    }
    if (node.kind === "assistant") {
      const nextSignature = signature([node.message, node.streaming]);
      const record = cached?.kind === "assistant" ? cached : {
        kind: "assistant" as const,
        component: new AssistantMessageComponent(undefined, this.hideThinking, getMarkdownTheme()),
        signature: undefined as string | undefined,
      };
      if (nextSignature === undefined || record.signature !== nextSignature) {
        record.component.updateContent(node.message, node.streaming);
        record.signature = nextSignature;
      }
      return record;
    }

    const args = readArgs(node.call);
    const result = node.failure ?? readResult(node.result);
    const partial = !node.failure && !!node.result?.streaming;
    const executionStarted = node.call?.executionStarted ?? !!result;
    const argsComplete = node.call?.argsComplete ?? (!!result || !!node.ended);
    let record = cached?.kind === "tool" ? cached : undefined;
    // Pi has no clearResult/unmarkExecutionStarted API. Rewinding/replacing transcript
    // state needs a fresh component; normal streaming updates retain the existing one.
    if (!record || record.name !== node.name || record.callId !== node.callId ||
        (record.hasResult && !result) ||
        (record.executionStarted && !executionStarted) || (record.argsComplete && !argsComplete)) {
      // Resolve once per component, as Pi does. Fresh wrappers on every redraw
      // would discard renderer state; a new call/session or rewind resolves anew.
      const renderers = this.toolRenderers(node.name);
      const component = new ToolExecutionComponent(
        node.name, node.callId, args, { showImages: false }, renderers, this.tui, this.cwd,
      );
      component.setExpanded(this.expanded);
      record = {
        kind: "tool", component, renderers, name: node.name, callId: node.callId,
        hasResult: false, executionStarted: false, argsComplete: false,
      };
    }
    const nextSignature = signature([args, result, partial, executionStarted, argsComplete]);
    if (nextSignature === undefined || record.signature !== nextSignature) {
      record.component.updateArgs(args);
      if (executionStarted && !record.executionStarted) record.component.markExecutionStarted();
      if (argsComplete && !record.argsComplete) record.component.setArgsComplete();
      if (result) record.component.updateResult(result, partial);
      record.signature = nextSignature;
      record.hasResult = !!result;
      record.executionStarted = executionStarted;
      record.argsComplete = argsComplete;
    }
    return record;
  }

  render(entries: BtwTranscript, width: number): string[] {
    const columns = Math.max(0, Math.floor(width));
    const used = new Set<string>();
    const lines: string[] = [];
    for (const node of this.buildNodes(entries)) {
      const key = `${node.kind}:${node.id}`;
      used.add(key);
      const record = this.componentFor(node, key);
      this.components.set(key, record);
      if (columns === 0) continue;
      // Native Markdown/tools own wrapping and ANSI styling. Only guard rows which
      // still exceed the available width (e.g. an unbreakable wide glyph or padding).
      for (const nativeLine of record.component.render(columns)) {
        const line = nativeLine.replace(OSC133_PROMPT_MARKER_RE, "");
        lines.push(visibleWidth(line) > columns ? truncateToWidth(line, columns, "") : line);
      }
    }
    for (const key of this.components.keys()) {
      if (!used.has(key)) this.components.delete(key);
    }
    return lines;
  }

  invalidate(): void {
    for (const record of this.components.values()) record.component.invalidate();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    for (const record of this.components.values()) {
      if (record.kind === "tool") record.component.setExpanded(expanded);
    }
  }

  setHideThinking(hide: boolean): void {
    if (this.hideThinking === hide) return;
    this.hideThinking = hide;
    for (const record of this.components.values()) {
      if (record.kind === "assistant") record.component.setHideThinkingBlock(hide);
    }
  }

  dispose(): void {
    this.components.clear();
    this.builtinRenderers.clear();
  }
}
