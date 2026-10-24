import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  createReadToolDefinition,
  getMarkdownTheme,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { BtwTranscriptRenderer, type BtwTranscript, type BtwTranscriptEntry } from "../extensions/btw-transcript";

beforeAll(() => initTheme("dark", false));
afterEach(() => vi.restoreAllMocks());

const cwd = "/tmp/btw-transcript-test";
function fixture(getToolRenderers?: (name: string, builtin?: ToolRenderers) => ToolRenderers | undefined) {
  const tui = { requestRender: vi.fn() } as unknown as TUI;
  return { tui, renderer: new BtwTranscriptRenderer(tui, cwd, getToolRenderers) };
}
function message(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", content, api: "openai-responses", provider: "openai", model: "fixture",
    timestamp: 0, stopReason: "stop",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...extra,
  };
}
function whole(id: number, value: AssistantMessage, turnId = 1, streaming = false): BtwTranscriptEntry {
  return { id, turnId, type: "assistant-message", message: value, streaming };
}
function call(id: number, name = "lookup", turnId = 1): Extract<BtwTranscriptEntry, { type: "tool-call" }> {
  return { id, turnId, type: "tool-call", toolCallId: `call-${id}`, toolName: name, args: "{}" };
}
function result(id: number, toolCallId: string, content: string, turnId = 1): Extract<BtwTranscriptEntry, { type: "tool-result" }> {
  return { id, turnId, type: "tool-result", toolCallId, toolName: "lookup", content, truncated: false, isError: false, streaming: false };
}
function plain(lines: string[]): string {
  return lines.map(stripVTControlCharacters).join("\n");
}
function bounded(lines: string[], width: number): string[] {
  return lines.map((line) => {
    const clean = line.replace(/\x1b\]133;[^\x07]*\x07/g, "");
    return visibleWidth(clean) > width ? truncateToWidth(clean, width, "") : clean;
  });
}
function nativeAssistant(value: AssistantMessage, width: number, streaming = false, hideThinking = false): string[] {
  const component = new AssistantMessageComponent(undefined, hideThinking, getMarkdownTheme());
  component.updateContent(value, streaming);
  return bounded(component.render(width), width);
}
function assertOrder(text: string, ...parts: string[]) {
  let previous = -1;
  for (const part of parts) {
    const index = text.indexOf(part, previous + 1);
    expect(index, `${JSON.stringify(part)} after offset ${previous} in:\n${text}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("BtwTranscriptRenderer native messages", () => {
  it("uses native user and assistant rendering without role badges or extra indentation", () => {
    const { renderer } = fixture();
    const answer = message([{ type: "text", text: "A **native** reply." }]);
    const entries: BtwTranscript = [
      { id: 1, turnId: 1, type: "turn-boundary", phase: "start" },
      { id: 2, turnId: 1, type: "user-message", text: "A **question**?" },
      whole(3, answer),
      { id: 4, turnId: 1, type: "turn-boundary", phase: "end", outcome: "completed" },
    ];
    const expectedUser = new UserMessageComponent("A **question**?", getMarkdownTheme());
    expect(renderer.render(entries, 64)).toEqual([
      ...bounded(expectedUser.render(64), 64), ...nativeAssistant(answer, 64),
    ]);
    expect(renderer.render(entries, 64).join("\n")).not.toContain("\x1b]133;");
    expect(plain(renderer.render(entries, 64))).not.toMatch(/\[(?:You|Assistant)\]/);
  });

  it("preserves interleaved thinking and text in whole-message snapshots", () => {
    const { renderer } = fixture();
    const value = message([
      { type: "thinking", thinking: "first-thought" },
      { type: "text", text: "first-answer" },
      { type: "thinking", thinking: "second-thought" },
      { type: "text", text: "second-answer" },
    ]);
    const lines = renderer.render([whole(1, value)], 50);
    expect(lines).toEqual(nativeAssistant(value, 50));
    assertOrder(plain(lines), "first-thought", "first-answer", "second-thought", "second-answer");
    renderer.setHideThinking(true);
    expect(renderer.render([whole(1, value)], 50)).toEqual(nativeAssistant(value, 50, false, true));
    expect(plain(renderer.render([whole(1, value)], 50))).not.toContain("second-thought");
    renderer.setHideThinking(false);
    expect(renderer.render([whole(1, value)], 50)).toEqual(lines);
  });

  it("combines adjacent legacy thinking/text, but never merges across tools or turns", () => {
    const updates = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
    const { renderer } = fixture();
    const entries: BtwTranscript = [
      { id: 1, turnId: 1, type: "thinking", text: "reason-one", streaming: false },
      { id: 2, turnId: 1, type: "assistant-text", text: "answer-one", streaming: false },
      call(3), result(4, "call-3", "tool-one"),
      { id: 5, turnId: 1, type: "thinking", text: "reason-two", streaming: false },
      { id: 6, turnId: 1, type: "assistant-text", text: "answer-two", streaming: false },
      { id: 7, turnId: 2, type: "assistant-text", text: "next-turn", streaming: false },
    ];
    const output = plain(renderer.render(entries, 64));
    expect(updates).toHaveBeenCalledTimes(3);
    expect(updates.mock.calls[0][0].content).toEqual([
      { type: "thinking", thinking: "reason-one" }, { type: "text", text: "answer-one" },
    ]);
    assertOrder(output, "reason-one", "answer-one", "tool-one", "reason-two", "answer-two", "next-turn");
    renderer.render(entries, 64);
    expect(updates).toHaveBeenCalledTimes(3);
  });

  it.each([1, 2, 4, 8, 12, 20, 37, 80])("keeps native Markdown/code/table/unicode rows bounded at width %i", (width) => {
    const { renderer } = fixture();
    const markdown = [
      "# Heading 界 👩‍💻", "", "A café é and **bold 界** paragraph with a [link](https://example.com).", "",
      "```ts", "const greeting = 'こんにちは 🌍';", "console.log(greeting);", "```", "",
      "| Column 界 | Value |", "| --- | --- |", "| alpha | βeta |", "| emoji | 🌍 |",
    ].join("\n");
    const value = message([{ type: "text", text: markdown }]);
    const entries: BtwTranscript = [{ id: 1, turnId: 1, type: "user-message", text: markdown }, whole(2, value)];
    const lines = renderer.render(entries, width);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    // This is intentionally exact, including ANSI: no second wrapping pass over native lines.
    expect(lines).toEqual([
      ...bounded(new UserMessageComponent(markdown, getMarkdownTheme()).render(width), width),
      ...nativeAssistant(value, width),
    ]);
  });

  it("passes whole-message streaming updates and native assistant errors through unchanged", () => {
    const { renderer } = fixture();
    const updates = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
    const partial = message([{ type: "thinking", thinking: "working" }, { type: "text", text: "partial **" }]);
    const entry = whole(1, partial, 1, true);
    renderer.render([entry], 40);
    const component = updates.mock.contexts[0];
    expect(updates.mock.calls[0]).toEqual([partial, true]);
    const final = message([{ type: "text", text: "partial response" }], { stopReason: "error", errorMessage: "provider failed" });
    const lines = renderer.render([whole(1, final)], 40);
    expect(updates.mock.contexts[1]).toBe(component);
    expect(updates.mock.calls[1]).toEqual([final, false]);
    expect(lines).toEqual(nativeAssistant(final, 40));
    expect(plain(lines)).toContain("Error: provider failed");
    const aborted = message([{ type: "text", text: "unfinished" }], { stopReason: "aborted" });
    expect(renderer.render([whole(1, aborted)], 40)).toEqual(nativeAssistant(aborted, 40));
  });

  it("translates legacy failure boundaries into native error/abort styling", () => {
    const { renderer } = fixture();
    const entries: BtwTranscript = [
      { id: 1, turnId: 1, type: "assistant-text", text: "❌ failed request", streaming: false },
      { id: 2, turnId: 1, type: "turn-boundary", phase: "end", outcome: "failed" },
    ];
    const text = plain(renderer.render(entries, 50));
    expect(text).toContain("Error: failed request");
    expect(text).not.toContain("❌");
    const pending = call(3);
    expect(plain(renderer.render([pending, { id: 4, turnId: 1, type: "turn-boundary", phase: "end", outcome: "aborted" }], 50)))
      .toContain("Operation aborted");
  });
});

describe("BtwTranscriptRenderer native tools", () => {
  it("updates the preceding call rather than adding result rows, across repeated tool cycles/turns", () => {
    const render = vi.spyOn(ToolExecutionComponent.prototype, "render");
    const { renderer } = fixture();
    const entries: BtwTranscript = [
      whole(1, message([{ type: "text", text: "before-tool" }])),
      call(2), result(3, "call-2", "first-result"),
      whole(4, message([{ type: "text", text: "between-tools" }])),
      call(5), result(6, "call-5", "second-result"),
      whole(7, message([{ type: "text", text: "after-tools" }])),
      // Reuse a call ID in another turn: it must not update the first turn's component.
      { ...call(8, "lookup", 2), toolCallId: "call-2" }, result(9, "call-2", "next-turn-result", 2),
      result(10, "orphan", "result-only", 3),
    ];
    const output = plain(renderer.render(entries, 72));
    expect(render).toHaveBeenCalledTimes(4);
    assertOrder(output, "before-tool", "first-result", "between-tools", "second-result", "after-tools", "next-turn-result", "result-only");
    expect(output.match(/first-result/g)).toHaveLength(1);
    expect(output.match(/result-only/g)).toHaveLength(1);
  });

  it("retains full raw arguments, result content/images/details/duration, and native lifecycle context", () => {
    const calls: Array<{ args: unknown; context: any }> = [];
    const results: Array<{ value: any; options: any; context: any }> = [];
    const renderers: ToolRenderers = {
      renderCall(args, _theme, context) {
        calls.push({ args, context });
        return new Text("custom-call", 0, 0);
      },
      renderResult(value, options, _theme, context) {
        results.push({ value, options, context });
        return new Text("custom-result", 0, 0);
      },
    };
    const { renderer } = fixture(() => renderers);
    const args = { query: "argument-".repeat(800), nested: { all: [1, 2, 3] } };
    const toolCall = { ...call(1), args: "short summary", argsValue: args, argsComplete: false, executionStarted: false };
    renderer.render([toolCall], 50);
    expect(calls.at(-1)?.args).toBe(args);
    expect(calls.at(-1)?.context).toMatchObject({ argsComplete: false, executionStarted: false, showImages: false, expanded: false, cwd });
    const fullResult = {
      content: [
        { type: "text", text: "full output\n".repeat(800) },
        { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" },
      ],
      details: { nested: { retained: "detail-".repeat(800) } },
      isError: false, durationMs: 1234,
    };
    const toolResult = { ...result(2, "call-1", "short result summary"), truncated: true, streaming: true, resultValue: fullResult };
    const started = { ...toolCall, argsComplete: true, executionStarted: true };
    renderer.render([started, toolResult], 50);
    expect(results.at(-1)?.value.content).toBe(fullResult.content);
    expect(results.at(-1)?.value.details).toBe(fullResult.details);
    expect(results.at(-1)?.options).toEqual({ expanded: false, isPartial: true });
    expect(results.at(-1)?.context).toMatchObject({ args, argsComplete: true, executionStarted: true, showImages: false, isError: false });
    expect(results.at(-1)?.context.durationMs).toBeUndefined();
    renderer.render([started, { ...toolResult, streaming: false, resultValue: { ...fullResult, isError: true } }], 50);
    expect(results.at(-1)?.context).toMatchObject({ durationMs: 1234, isError: true, isPartial: false });
    expect(results.at(-1)?.value.content[0].text.length).toBeGreaterThan(400);
  });

  it("uses builtin definitions as fallback, with partial custom renderers taking precedence", () => {
    const { tui, renderer } = fixture();
    const toolCall = { ...call(1, "read"), argsValue: { path: "/tmp/界.ts", offset: 3, limit: 8 }, argsComplete: true, executionStarted: true };
    const toolResult = { ...result(2, "call-1", "const value = 42;"), toolName: "read" };
    const native = new ToolExecutionComponent("read", "call-1", toolCall.argsValue, { showImages: false }, createReadToolDefinition(cwd), tui, cwd);
    native.markExecutionStarted();
    native.setArgsComplete();
    native.updateResult({ content: [{ type: "text", text: toolResult.content }], isError: false });
    expect(renderer.render([toolCall, toolResult], 60)).toEqual(bounded(native.render(60), 60));

    const customResult: ToolRenderers["renderResult"] = () => new Text("CUSTOM RESULT", 0, 0);
    const partial = fixture((_name, builtin) => ({ ...builtin, renderResult: customResult }));
    const output = plain(partial.renderer.render([toolCall, toolResult], 60));
    expect(output).toContain("CUSTOM RESULT");
    expect(output).toContain("界.ts"); // Native read call renderer was not lost.
    expect(output).not.toContain("const value");

    const customCall: ToolRenderers["renderCall"] = () => new Text("CUSTOM CALL", 0, 0);
    const otherPartial = fixture((_name, builtin) => ({ ...builtin, renderCall: customCall, renderShell: "default" }));
    otherPartial.renderer.setExpanded(true);
    const otherOutput = plain(otherPartial.renderer.render([toolCall, toolResult], 60));
    expect(otherOutput).toContain("CUSTOM CALL");
    expect(otherOutput).toContain("const value"); // Native read result renderer was not lost.
  });

  it("passes builtin definitions into the resolver and treats its result as authoritative", () => {
    const custom: ToolRenderers = {
      renderShell: "self",
      renderCall: () => new Text("authoritative-call", 0, 0),
      renderResult: () => new Text("authoritative-result", 0, 0),
    };
    const resolve = vi.fn((name: string, _builtin?: ToolRenderers) => name === "read" ? custom : undefined);
    const { tui, renderer } = fixture(resolve);
    const toolCall = { ...call(1, "read"), argsValue: { path: "not-accessed.ts" }, executionStarted: true, argsComplete: true };
    const toolResult = { ...result(2, "call-1", "unused"), toolName: "read" };
    const actual = renderer.render([toolCall, toolResult], 40);
    const builtin = resolve.mock.calls[0][1];
    expect(builtin?.renderCall).toBeTypeOf("function");
    expect(builtin?.renderResult).toBeTypeOf("function");
    const native = new ToolExecutionComponent("read", "call-1", toolCall.argsValue, { showImages: false }, custom, tui, cwd);
    native.markExecutionStarted();
    native.setArgsComplete();
    native.updateResult({ content: [{ type: "text", text: "unused" }], isError: false });
    expect(actual).toEqual(bounded(native.render(40), 40));
    renderer.render([toolCall, toolResult], 40);
    expect(resolve).toHaveBeenCalledTimes(1);
    renderer.render([call(3, "unknown-tool")], 40);
    expect(resolve.mock.calls.at(-1)).toEqual(["unknown-tool", undefined]);
    renderer.dispose();
    renderer.render([toolCall, toolResult], 40);
    expect(resolve.mock.calls.at(-1)?.[1]).not.toBe(builtin);

    // A resolver may intentionally omit the builtin result renderer. The native
    // generic result fallback then applies, rather than silently re-merging it.
    const omitted = fixture(() => ({ renderCall: custom.renderCall }));
    expect(plain(omitted.renderer.render([toolCall, { ...toolResult, content: "generic-result-fallback" }], 60)))
      .toContain("generic-result-fallback");
  });

  it.each([1, 2, 4, 8, 20])("bounds native tool rows at width %i", (width) => {
    const { renderer } = fixture();
    const toolCall = { ...call(1), argsValue: { query: "界 👩‍💻 é ".repeat(10) } };
    const toolResult = result(2, "call-1", "wide output 界 🌍".repeat(10));
    for (const expanded of [false, true]) {
      renderer.setExpanded(expanded);
      for (const line of renderer.render([toolCall, toolResult], width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("expands native generic tools without losing full arguments or output", () => {
    const { renderer } = fixture();
    const toolCall = { ...call(1), argsValue: { query: "q".repeat(180) + "ARGUMENT-END" } };
    const toolResult = result(2, "call-1", Array.from({ length: 24 }, (_, i) => `output-${i}`).join("\n"));
    const entries: BtwTranscript = [toolCall, toolResult];
    const collapsed = plain(renderer.render(entries, 64));
    expect(collapsed).not.toContain("output-23");
    expect(collapsed).not.toContain("ARGUMENT-END");
    renderer.setExpanded(true);
    const expanded = plain(renderer.render(entries, 64));
    expect(expanded).toContain("output-23");
    expect(expanded.replace(/\s/g, "")).toContain("ARGUMENT-END");
    expect(expanded.split("\n").length).toBeGreaterThan(collapsed.split("\n").length);
    renderer.setExpanded(false);
    expect(renderer.render(entries, 64).map(stripVTControlCharacters)).toEqual(collapsed.split("\n"));
    renderer.setExpanded(true);
    expect(plain(renderer.render([{ ...toolCall, id: 3, toolCallId: "call-3" }, result(4, "call-3", toolResult.content)], 64)))
      .toContain("output-23");
  });

  it("renders partial and error results with exactly the native styling", () => {
    const { tui, renderer } = fixture();
    const toolCall = { ...call(1), argsValue: { input: "x" }, argsComplete: true, executionStarted: true };
    const toolResult = { ...result(2, "call-1", "partial-output"), streaming: true };
    const native = new ToolExecutionComponent("lookup", "call-1", toolCall.argsValue, { showImages: false }, {}, tui, cwd);
    native.markExecutionStarted();
    native.setArgsComplete();
    native.updateResult({ content: [{ type: "text", text: "partial-output" }], isError: false }, true);
    const partial = renderer.render([toolCall, toolResult], 50);
    expect(partial).toEqual(bounded(native.render(50), 50));
    native.updateResult({ content: [{ type: "text", text: "failed-output" }], isError: true });
    const failed = renderer.render([toolCall, { ...toolResult, content: "failed-output", isError: true, streaming: false }], 50);
    expect(failed).toEqual(bounded(native.render(50), 50));
    expect(failed).not.toEqual(partial);
  });
});

describe("BtwTranscriptRenderer cache and invalidation", () => {
  it("retains native component identities across updates, resize, and unchanged renders", () => {
    const argsUpdates = vi.spyOn(ToolExecutionComponent.prototype, "updateArgs");
    const resultUpdates = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
    const { renderer } = fixture();
    const toolCall = { ...call(1), argsValue: { query: "a" } };
    const toolResult = { ...result(2, "call-1", "first"), streaming: true };
    const entries: BtwTranscript = [toolCall, toolResult];
    renderer.render(entries, 60);
    const native = resultUpdates.mock.contexts[0];
    expect(argsUpdates).toHaveBeenCalledTimes(1);
    renderer.render(entries, 20);
    expect(resultUpdates).toHaveBeenCalledTimes(1);
    // The parent may mutate snapshots in place rather than replacing entry objects.
    toolCall.argsValue.query = "b";
    toolResult.content = "second";
    toolResult.streaming = false;
    renderer.render(entries, 20);
    expect(argsUpdates).toHaveBeenCalledTimes(2);
    expect(resultUpdates.mock.contexts[1]).toBe(native);
    expect(plain(renderer.render(entries, 20))).toContain("second");
    renderer.render([], 20); // Removed entries must not leak cached components.
    renderer.render(entries, 20);
    expect(resultUpdates.mock.contexts.at(-1)).not.toBe(native);
  });

  it("retains tool state when a resolver allocates fresh renderer wrappers", () => {
    const updates = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
    const resolve = vi.fn((): ToolRenderers => ({
      renderResult(_value, _options, _theme, context) {
        context.state.seen = (context.state.seen ?? 0) + 1;
        return new Text(`render-${context.state.seen}`, 0, 0);
      },
    }));
    const { renderer } = fixture(resolve);
    const firstResult = { ...result(2, "call-1", "partial"), streaming: true };
    const entries: BtwTranscript = [call(1), firstResult];
    renderer.render(entries, 40);
    const component = updates.mock.contexts[0];
    renderer.render(entries, 20);
    firstResult.content = "completed";
    firstResult.streaming = false;
    renderer.render(entries, 40);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(updates.mock.contexts.at(-1)).toBe(component);
    renderer.dispose();
    renderer.render(entries, 40);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(updates.mock.contexts.at(-1)).not.toBe(component);
  });

  it("honors renderer invalidation and asynchronous native updates without a flattened line cache", () => {
    let version = "first";
    let invalidate: (() => void) | undefined;
    const custom: ToolRenderers = {
      renderResult(_value, _options, _theme, context) {
        invalidate = context.invalidate;
        return new Text(version, 0, 0);
      },
    };
    const { tui, renderer } = fixture(() => custom);
    const entries: BtwTranscript = [call(1), result(2, "call-1", "unused")];
    expect(plain(renderer.render(entries, 30))).toContain("first");
    version = "async-update";
    invalidate!();
    expect(tui.requestRender).toHaveBeenCalled();
    expect(plain(renderer.render(entries, 30))).toContain("async-update");
    version = "theme-update";
    renderer.invalidate();
    expect(plain(renderer.render(entries, 30))).toContain("theme-update");
    renderer.dispose();
    renderer.dispose();
    version = "after-dispose";
    expect(plain(renderer.render(entries, 30))).toContain("after-dispose");
  });

  it("strips BEL and ST OSC133 markers while preserving other native ANSI styling", () => {
    const custom: ToolRenderers = {
      renderCall: () => new Text("\x1b]133;A\x07\x1b[31mred\x1b[0m\x1b]133;D;0\x1b\\", 0, 0),
    };
    const { renderer } = fixture(() => custom);
    const lines = renderer.render([call(1)], 24);
    expect(lines.join("\n")).not.toContain("133;");
    expect(lines.join("\n")).toContain("\x1b[31mred");
    expect(renderer.render([call(1)], 0)).toEqual([]);
  });
});
