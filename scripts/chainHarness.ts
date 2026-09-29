/**
 * 生产链台架（从 probe-selection-chain 拆出来，供探针与真模型诊断脚本共用）。
 *
 * 从 ChatPanel AST 提取原函数（不复制执行逻辑），仅替换 React/UI/TTS I/O。
 * 选兵、权限、G 票、解析、applyOrders、回执均调用生产实现；核实际下令 ID。
 */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as core from "@ai-commander/core";
import * as shared from "@ai-commander/shared";
import type { GameState, AdvisorOption, Order } from "@ai-commander/shared";
import { isKnownLocation, isValidTarget, canAutoExecute, decideBucket, detectStaleSquadRefs } from "../apps/web/src/autoExecuteGate";
import { buildExecReceipt, buildExecFeedback } from "../apps/web/src/execReceipt";
import { cloneSelectionOption, optionWithResolvedIntents, selectionEnvelope } from "../apps/web/src/selectionOption";
import { intentFacts } from "../apps/web/src/traceFacts";
import { planVoiceSpeech } from "../apps/web/src/voiceSpeech";

export const panelPath = new URL("../apps/web/src/ChatPanel.tsx", import.meta.url);
export const source = readFileSync(panelPath, "utf8");
export const serverIndexSource = readFileSync(new URL("../apps/server/src/index.ts", import.meta.url), "utf8");

// ════════════════════════════════════════════════════════════════════
// 整条回复链（第六轮）：模型 → 生产服务端路由 → 生产 sendCommand → 生产
// processAdvisorData（含闸/桶/自动执行那一段）→ handleApprove → applyOrders。
//
// 旧 `turn()` 只跑 processAdvisorData 的前半（批准判官 → 选择 → 确认案），
// 闸 / 桶 / 自动执行那一段一格都够不到——「通讯兜底被当成正常答复执行」
// 就落在那一段里，所以一直没被抓住。
// ════════════════════════════════════════════════════════════════════

/** 从 index.ts 取 `app.post("<path>", handler)` 的 handler 原文（不复制逻辑）。 */
function routeHandler(src: string, routePath: string): string {
  const sf = ts.createSourceFile("index.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = "";
  function visit(n: ts.Node) {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "app.post"
        && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === routePath) {
      found = n.arguments[1].getText(sf);
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  assert.ok(found, `production route missing: ${routePath}`);
  return found;
}

/** 一次假模型调用该怎么回：正常文本 / HTTP 错误（429 等）/ 直接抛错（网络）。 */
export type LlmStep =
  | { kind: "text"; text: string }
  | { kind: "status"; status: number; body?: string }
  | { kind: "throw"; message: string };

/**
 * 生产服务端两条命令路由（AST 取 index.ts 原 handler；只把日志换成空函数）。
 * 模型那一端是假的：`llm.queue` 里排好每一次调用的回法，服务端的 provider、
 * 解析、校验、归一化、兜底全走生产代码。
 */
export async function serverRoutes(opts: { real?: boolean; gapMs?: number } = {}) {
  process.env.ADVISOR_TRACE = "off"; // 不往旁路服务的对账日志里掺台架的行
  if (!opts.real) {
    // 与生产同一种 provider（陈＝gemini-2.5-flash，OpenAI 兼容接口，收音频）；密钥是假的，
    // 请求被下面的假 fetch 截住，发不出去。语音回合因此能走生产的收音判定（rejectCommandBody）。
    process.env.LLM_PROFILE = "gemini-2.5-flash"; process.env.LLM_PROFILE_COMBAT = "";
    process.env.GEMINI_API_KEY = "stub-key";
  }
  const ai = await import("../apps/server/src/ai");
  const voice = await import("../apps/server/src/voiceInput");
  const llm = { queue: [] as LlmStep[], calls: [] as { stream: boolean }[], raw: [] as { stream: boolean; status: number; text: string }[] };
  if (opts.real) {
    // 真模型：请求原样发出去（串行＋间隔，不吃光与正在玩的那一局共用的配额），回包原文另存一份作证据。
    const realFetch = globalThis.fetch;
    let last = 0;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const wait = last + (opts.gapMs ?? 0) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const stream = typeof init?.body === "string" && JSON.parse(init.body).stream === true;
      llm.calls.push({ stream });
      const res = await realFetch(url, init);
      const text = await res.clone().text();
      llm.raw.push({ stream, status: res.status, text });
      return res;
    }) as typeof fetch;
  } else globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const wantsStream = !!init?.body && JSON.parse(init.body).stream === true;
    llm.calls.push({ stream: wantsStream });
    const step = llm.queue.shift();
    assert.ok(step, "fake model called more times than scripted");
    if (step.kind === "throw") throw new TypeError(step.message);
    if (step.kind === "status") {
      return new Response(step.body ?? "rate limited", { status: step.status });
    }
    if (!wantsStream) {
      return new Response(JSON.stringify({ choices: [{ message: { content: step.text } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const t = step.text;
    const chunks = [t.slice(0, 5), t.slice(5)].map(c =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode(chunks)); ctl.close(); } }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const deps: Record<string, unknown> = {
    rejectCommandBody: voice.rejectCommandBody, audioOf: voice.audioOf,
    callAdvisor: ai.callAdvisor, callAdvisorStream: ai.callAdvisorStream,
    logEvent: noop, speechDiagOf: () => undefined, traceWrite: noop, envelopeOf: () => undefined,
    logHeard: noop, logAdvisorIntents: noop, traceResult: noop,
  };
  const build = (routePath: string) => {
    const js = ts.transpileModule(`const handler = ${routeHandler(serverIndexSource, routePath)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return new Function(...Object.keys(deps), `${js}\nreturn handler;`)(...Object.values(deps)) as
      (req: { body: unknown }, res: unknown) => Promise<void>;
  };
  const handlers = { "/api/command": build("/api/command"), "/api/command-stream": build("/api/command-stream") };
  /** 浏览器看到的 fetch：请求交给生产路由 handler，回一个真正的 Response。 */
  const clientFetch = async (url: string, init?: { body?: string }): Promise<Response> => {
    const routePath = new URL(url, "http://harness").pathname as keyof typeof handlers;
    const handler = handlers[routePath];
    assert.ok(handler, `harness has no route for ${routePath}`);
    let status = 200; let body = ""; const headers: Record<string, string> = {};
    const res = {
      status(code: number) { status = code; return res; },
      json(obj: unknown) { headers["Content-Type"] = "application/json"; body = JSON.stringify(obj); },
      setHeader(k: string, v: string) { headers[k] = v; },
      flushHeaders: noop,
      write(chunk: string) { body += chunk; },
      end: noop,
    };
    await handler({ body: init?.body ? JSON.parse(init.body) : {} }, res);
    return new Response(body, { status, headers });
  };
  return { llm, clientFetch, ai };
}

/** 模型的一整段输出：正文（流给长官看的那段）＋ ---JSON--- ＋ JSON。 */
export function modelText(prose: string, json: Record<string, unknown> | string): string {
  return `${prose}\n---JSON---\n${typeof json === "string" ? json : JSON.stringify(json)}`;
}

export function declaration(src: string, name: string): string {
  const sf = ts.createSourceFile("ChatPanel.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = "";
  function visit(n: ts.Node) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n.getText(sf);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      found = `const ${n.getText(sf)};`;
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  assert.ok(found, `production declaration missing: ${name}`);
  return found;
}

/** Extract the complete real selection-response branch, including lifecycle and reask wiring. */
export function selectionIngress(src: string): string {
  const text = declaration(src, "processAdvisorData");
  const sf = ts.createSourceFile("ingress.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0];
  const body = (decl.initializer as ts.ArrowFunction).body as ts.Block;
  const statements = body.statements.map(s => s.getText(sf));
  const start = statements.findIndex(s => s.startsWith("const selSlotAtJudge ="));
  const end = statements.findIndex(s => s.startsWith('if (selTurn.plan.kind !== "passthrough")'));
  assert.ok(start >= 0 && end > start, "production selection ingress structure changed");
  return `const answerResponse = (data, selectionTag) => {
    const state = getState(); const ch = getActiveChannel();
    ${statements.slice(start, end + 1).join("\n")}
  };`;
}

/**
 * 刀寅：回复入口的更长一段——**批准合同判官 → 候选选择 → 确认案登记**（生产原文）。
 * 返回 "passthrough" 表示这一轮会落到后面的普通执行/澄清分支（台架不含那一段）。
 */
export function responseIngress(src: string): string {
  const text = declaration(src, "processAdvisorData");
  const sf = ts.createSourceFile("ingress.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0];
  const body = (decl.initializer as ts.ArrowFunction).body as ts.Block;
  const statements = body.statements.map(s => s.getText(sf));
  // 起点＝「参谋答了新的一轮」那一行（审核 B 的轮次计数），它紧挨在批准合同判官之前。
  const bump = statements.findIndex(s => s.startsWith("if (!data.error) bumpReplyTurn("));
  const judge = statements.findIndex(s => s.startsWith("if (!data.error) {") && s.includes("pendingContractRef.current"));
  const start = bump >= 0 && bump === judge - 1 ? bump : judge;
  const end = statements.findIndex(s => s.startsWith("{") && s.includes("confirm_captured"));
  assert.ok(start >= 0 && end > start, "production response ingress structure changed");
  return `const turnResponse = (data, tags) => {
    const state = getState(); const ch = getActiveChannel();
    const pendingTag = tags.pendingTag ?? null; const selectionTag = tags.selectionTag ?? null;
    const userMsg = tags.userMsg ?? "";
    const traceId = tags.traceId ?? nextTraceId();
    ${statements.slice(start, end + 1).join("\n")}
    return "passthrough";
  };`;
}

export const noop = () => {};
/**
 * ★线上传输的真实边界：模型原始 JSON → **生产** `validateAdvisorResponse`
 * → `JSON.stringify` / `JSON.parse`（SSE 的 `res.write(JSON.stringify(event))`
 * 与 `/api/command` 的 `res.json(result.data)` 都是这一步）→ 浏览器收到的对象。
 *
 * 旧 `answer()` 直接把**模型原始格式**塞给客户端分支，**绕过了这一层**——
 * 于是 schema 把 `{decision,candidate}` 规范成 `{kind,candidateKey}`、core 又拿
 * 原始 parser 再解析一遍、得到 undefined 的那个 bug，台架一条都看不见，
 * 玩家实测却连答两次「派出去的那批」都被判协议失败、重复第一问。
 * 这里不手写"等价 schema"，也不在交给客户端前偷偷转回原始格式。
 */
export function overTheWire(rawModelResponse: Record<string, unknown>): Record<string, unknown> {
  const validated = shared.validateAdvisorResponse(rawModelResponse);
  assert.ok(validated, "production schema rejected the model response");
  return JSON.parse(JSON.stringify(validated));
}

export function harness(
  state: GameState,
  src = source,
  channel = "combat",
  /** 负对照注入口：替换 core 的 planSelectionTurn（默认就是生产实现）。 */
  planOverride?: typeof core.planSelectionTurn,
  /** 负对照注入口：旧版本 core/shared 函数（配旧源码的 handler 用）。默认不替任何东西。 */
  overrides: Record<string, unknown> = {},
) {
  const screen: Array<{ level: string; text: string; source?: string }> = [];
  const context: string[] = [];
  /** 整条回复链用：带角色的 context（区分长官原话与参谋那一句）。 */
  const contextEntries: Array<{ role: string; text: string }> = [];
  /** 每一声交给 TTS 的话，连同嗓子（persona 一换，tts 模块会掐掉前一声）。 */
  const speech: Array<{ text: string; persona: string }> = [];
  /** 整条回复链用：浏览器发出去的每个请求（路由 + 请求体）。 */
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const clientFetchRef = { current: null as null | ((url: string, init?: { body?: string }) => Promise<Response>) };
  const channelCommander = channel === "combat" ? "chen" : channel === "logistics" ? "emily" : "marcus";
  const audio: string[] = [];
  const applications: Order[][] = [];
  const results: shared.ApplyResult[] = [];
  const doctrineSources: unknown[] = [];
  const burned: string[] = [];
  const traces: Array<{ stage: string; data: Record<string, unknown> }> = [];
  const pendingSelectionRef = { current: null as any };
  const pendingContractRef = { current: null as any };
  const gameEpochRef = { current: 0 };
  const replyTurnRef = { current: {} as Record<string, unknown> };
  /** 注入口：此刻"正在请示"的那一条（生产里是 messageStore 的 getActiveEscalation）。 */
  const escalation = { current: null as null | { actionId: string; createdAt: number; question?: string } };
  let traceSerial = 0;
  const response = { recommended: "B", options: [], standingOrder: { type: "must_hold" } };
  const execCtx = { channel, requestId: "test", run: shared.stampRun(0, state) };
  let lastDecision: ReturnType<typeof core.planSelectionTurn>;
  let serial = 0;
  const deps = {
    ...core, ...shared, isKnownLocation, isValidTarget,
    buildExecReceipt, buildExecFeedback, cloneSelectionOption, optionWithResolvedIntents,
    getState: () => state, getActiveChannel: () => channel, response,
    responseExecCtxRef: { current: execCtx }, gameEpochRef,
    selectedIdsSnapshotRef: { current: undefined }, pendingSelectionRef,
    pendingGroupResponsesRef: { current: [] }, latestRequestIdRef: { current: "test" },
    bareConfirmExecRef: { current: null }, channelContextRef: { current: {} },
    SESSION_ID: "test-session", makePendingId: () => `selection-${++serial}`,
    setResponse: noop, setError: noop, setClarification: noop, setApprovedIdx: noop,
    ttsEnabled: true, crypto: globalThis.crypto,
    // 整条回复链：生产代码用 `setTimeout(fn, 0)` 把自动执行推到下一拍——台架当场跑；
    //   带延迟的（400ms 清高亮、6s 中止请求）一律不跑，它们不是执行路径。
    setTimeout: (fn: () => void, ms?: number) => { if (!ms) fn(); return 0; }, clearTimeout: noop,
    pickVoiceConfirm: () => "收到。", resolveThread: noop,
    sayToEar: () => ({ speakExecReceipt: true }),
    planSelectionTurn: (args: Record<string, unknown>) => {
      // 历史负对照兼容：7a5ee05 的 handler 用旧参数名 `rawDecision` 递同一份数据。
      // 那两条对照要证明的是**旧 handler 的逻辑病**（双问回头 / G 票被改），
      // 所以这里只把参数名接上，让解析层正常工作，病才归因得到 handler 头上。
      const a = ("decision" in args ? args : { ...args, decision: args.rawDecision }) as
        Parameters<typeof core.planSelectionTurn>[0];
      lastDecision = (planOverride ?? core.planSelectionTurn)(a); return lastDecision;
    },
    addMessage: (level: string, text: string, _t?: number, _ch?: string, _cmd?: string, source?: string) =>
      screen.push({ level, text, source }),
    pushContext: (_c: unknown, _ch: string, entry: { role?: string; text: string }) => {
      context.push(entry.text); contextEntries.push({ role: entry.role ?? "", text: entry.text });
    },
    speak: (text: string, persona?: string) => { audio.push(text); speech.push({ text, persona: String(persona) }); }, flush: noop,
    processDoctrineFields: (data: unknown) => doctrineSources.push(data),
    applyOrders: (s: GameState, orders: Order[]) => {
      applications.push(structuredClone(orders));
      const result = core.applyOrders(s, orders);
      results.push(result);
      return result;
    },
    burnEscalationTicket: (g: string) => { burned.push(g); core.burnEscalationTicket(g); },
    // 刀寅：对账日志——生产代码照调，台架把每一行收下来（可断言「真落点」一层）
    traceId: "harness-trace", traceIdRef: { current: "harness-trace" }, intentFacts,
    traceClient: (_id: string, stage: string, data: Record<string, unknown>) => traces.push({ stage, data }),
    // 试玩记录仪：命令请求的观测头（sendCommand 里唯一新增的名字）。台架默认不记录＝空对象，请求与生产关闭时逐字节相同。
    recorderHeaders: () => ({}),
    // 刀寅：回复入口那一段要的依赖（批准合同 + 确认案登记）
    pendingContractRef, canAutoExecute, replyMark: () => undefined,
    // 刀寅（审核 B）：一次只挂一个问题——轮次计数与"新请示"注入口
    replyTurnRef, splitAskedRef: { current: null }, handledRepliesRef: { current: [] },
    getActiveEscalation: (ch: string) => (escalation.current && ch === channel ? escalation.current : null),
    nextTraceId: () => `harness-turn-${++traceSerial}`,
    isVoiceTurn: false, heard: "", isGroupChat: false, activeThreadOnChannel: undefined, escalateId: undefined,
    // ── 整条回复链（生产 sendCommand）要的依赖：React/DOM/TTS/摘要 一律换成空壳，
    //    执行判断一个不替——闸、桶、合同、主链全是生产原文 ──
    API_URL: "http://harness", activeThreads: [], selectedCommanders: [channelCommander],
    buildDigestForChannel: () => "DIGEST", buildPlayerViewContext: () => "", formatContext: () => "",
    commanderMemoryRef: { current: { combat: {}, ops: {}, logistics: {} } },
    lastGameStateRef: { current: state },
    clearEscalation: () => { escalation.current = null; },
    declinedContext: null, setDeclinedContext: noop,
    decideBucket, detectStaleSquadRefs, planVoiceSpeech, selectionEnvelope,
    cancel: noop, fireTransmit: noop, onPlayerSpoke: noop, updateLastPlayerMessage: noop,
    getSelectedUnitIds: () => [], getViewport: () => null, getVoiceOpenDiag: () => null, takeSpeechDiag: () => undefined,
    releaseMarkRef: { current: null }, speechTurnRef: { current: 0 }, voiceAutoSendRef: { current: false },
    setLoading: noop, setMessage: noop, setStreamingText: noop, sendGroupChat: noop,
    newTraceId: () => `harness-turn-${++traceSerial}`,
    fetch: (url: string, init?: { body?: string }) => {
      const path = new URL(url, "http://harness").pathname;
      requests.push({ path, body: init?.body ? JSON.parse(init.body) : {} });
      assert.ok(clientFetchRef.current, "send() needs a clientFetch");
      return clientFetchRef.current(url, init);
    },
    ...overrides,
  };
  // Constants and closure functions are taken verbatim from the current production file.
  const names = ["COMMANDERS", "COMMANDER_CHANNEL", "COMMANDER_META", "COMMANDER_REFS",
    "HIGH_IMPACT_CONFIRM_WINDOW_SEC", "HIGH_IMPACT_CONFIRM_WORDS", "normalizeReply", "isConfirmReply",
    "softFixTargetFields", "dispatchSourceOf",
    "refuseAloud", "askWhichDispatch", "handleApprove"];
  // 审核 B 新增的生产函数。旧版本源码（负对照）里没有它们 ⇒ 用**旧行为**顶上（旧 send 捷径原文的镜像），
  //   这样负对照测的仍是旧代码当时的真实表现。
  const pendingNames = ["HIGH_IMPACT_CANCEL_WORDS", "isCancelReply", "replyTurnOf", "bumpReplyTurn", "livePendingContract", "tryPendingShortcut"];
  const hasPendingFns = src.includes("const livePendingContract =");
  if (hasPendingFns) names.push(...pendingNames);
  // 第六轮：数量读法那一问（旧源码没有它）。
  if (src.includes("const askQuantityReading =")) names.push("askQuantityReading");
  // 第九轮：登记待批准方案的唯一入口（旧源码没有它）。
  if (src.includes("const registerApprovalPlan =")) names.push("registerApprovalPlan");
  const oldPendingFns = hasPendingFns ? "" : `
    const replyTurnOf = () => 0; const bumpReplyTurn = () => {};
    const livePendingContract = (st, ch) => {
      const pc = pendingContractRef.current;
      if (!pc) return null;
      if (pc.epoch !== gameEpochRef.current || st.time > pc.expiresAt) { pendingContractRef.current = null; return null; }
      return pc.channel === ch && pc.phase === "awaiting_reply" ? pc : null;
    };
    const tryPendingShortcut = (st, ch, userMsg) => {
      const pc = livePendingContract(st, ch);
      if (!pc || !isConfirmReply(userMsg)) return false;
      pendingContractRef.current = null;
      handleApprove(pc.opt, 0, "auto", pc.execCtx, pc.data);
      return true;
    };`;
  const withIngress = src.includes("confirm_captured");
  // 整条回复链：生产 sendCommand 及它自己的几个小帮手（旧源码缺哪个就不装，send() 不可用）。
  const sendNames = ["ESCALATION_DECLINE_WORDS", "isDeclineReply", "buildGateQuestion", "livePendingSelection", "syncGameEpoch", "sendCommand"];
  const hasSend = hasPendingFns && sendNames.every((n) => { try { declaration(src, n); return true; } catch { return false; } });
  if (hasSend) names.push(...sendNames);
  const js = ts.transpileModule(names.map(n => declaration(src, n)).join("\n") + oldPendingFns + "\n" + selectionIngress(src)
    + (withIngress ? "\n" + responseIngress(src) : "\nconst turnResponse = undefined;")
    + (hasSend ? "" : "\nconst sendCommand = undefined;"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const external = Object.entries(deps).filter(([name]) => !names.includes(name));
  // `message` 是 React 输入框的 state：每一次 send 用长官这一句重建一份闭包（refs 共用同一批对象，状态连续）。
  const factory = new Function(...external.map(([name]) => name), "message", `${js}\nreturn { handleApprove, answerResponse, turnResponse, isConfirmReply, livePendingContract, tryPendingShortcut, bumpReplyTurn, replyTurnOf, sendCommand };`);
  const api = factory(...external.map(([, value]) => value), "");
  /**
   * ★整条回复链：长官在输入框里打了这一句、按下发送（生产 sendCommand 原文）。
   * 浏览器的 fetch 交给 `clientFetch`（通常是 serverRoutes() 的生产路由）。
   */
  const send = async (userMsg: string, clientFetch: (url: string, init?: { body?: string }) => Promise<Response>, opts: { voice?: boolean; voiceData?: string } = {}) => {
    assert.ok(hasSend, "this source has no extractable sendCommand");
    clientFetchRef.current = clientFetch;
    // 语音回合：生产 sendCommand 收到一段录音（输入框是空的），长官说了什么要等模型交回 heard。
    // voiceData＝真录音的 base64（真模型复验用）；缺席＝一段空白 WAV（假模型台架不听内容）。
    const voice = opts.voice ? { data: opts.voiceData ?? "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=", format: "wav" } : undefined;
    await factory(...external.map(([, value]) => value), opts.voice ? "" : userMsg).sendCommand(voice);
  };
  const approve = (opt: AdvisorOption, playerText?: string) =>
    api.handleApprove(opt, 1, "auto", playerText === undefined ? execCtx : { ...execCtx, playerText }, response, true);
  // ★测试输入调整（有意为之，理由写明）：原先绕过了真实服务端边界。
  //   现在只构造**模型原始回包**，其余一律走生产代码：
  //   原始 JSON → validateAdvisorResponse → JSON 往返 → 客户端选择分支 → core → 主链。
  //   `extraOptions` 非空 ⇒ 覆盖 schema 的"非空 options"那条 return 路径，并顺带
  //   验证"回答轮另带的 options 不许造成第二次执行"。
  const answer = (key?: string, unclear = false, extraOptions: unknown[] = []) => {
    const slot = pendingSelectionRef.current;
    assert.ok(slot, "answer requires an actual pending question");
    const raw = {
      brief: unclear ? "您指哪一批？" : "明白，就撤那一批。",
      options: extraOptions,
      dispatchSelection: unclear ? { decision: "unclear" } : { decision: "chose", candidate: key },
    };
    api.answerResponse(overTheWire(raw),
      { selectionId: slot.id, channel: slot.channel, sessionId: slot.sessionId });
    return lastDecision;
  };
  /** 刀寅：一整轮回复从模型原始 JSON 进（schema＋JSON 往返），走生产回复入口。 */
  const turn = (raw: Record<string, unknown>, tags: { pendingTag?: unknown; selectionTag?: unknown; userMsg?: string; traceId?: string } = {}) =>
    api.turnResponse(overTheWire(raw), tags);
  /** 服务端**已经交出来**的对象（callAdvisor/callAdvisorStream 的产物）：只做一次 JSON 往返，不再过 schema。 */
  const deliverTurn = (delivered: Record<string, unknown>, tags: { pendingTag?: unknown; selectionTag?: unknown; userMsg?: string; traceId?: string } = {}) =>
    api.turnResponse(JSON.parse(JSON.stringify(delivered)), tags);
  /**
   * 生产 send 开头的「确认词捷径」——**直接调生产函数** tryPendingShortcut（审核 B：不再镜像）。
   * 返回 true 表示这一句已经在捷径里处理完（执行存下的方案 / 取消），不问模型。
   */
  const confirmShortcut = (userMsg: string): boolean => api.tryPendingShortcut(state, channel, userMsg);
  /** 发请求那一刻的合同标签：与生产 send 同一个判定（livePendingContract）。 */
  const pendingTagNow = () => {
    const pc = api.livePendingContract(state, channel);
    return pc ? { pendingId: pc.id, channel, sessionId: "test-session" } : null;
  };
  /** 模拟"参谋又答了一轮"（例如长官换了话题、陈回了一句不带合同的话）。 */
  const replyTurn = (traceId = `harness-turn-${++traceSerial}`) => api.bumpReplyTurn(channel, traceId);
  return { approve, answer, deliver: api.answerResponse, turn, deliverTurn, confirmShortcut, pendingTagNow, replyTurn, escalation, replyTurnRef, pendingContractRef, gameEpochRef, pendingSelectionRef, screen, context, audio, applications, results, burned, doctrineSources, response, traces,
    send, requests, contextEntries, speech };
}


// ════════════════════════════════════════════════════════════════════
// 第五轮（交接给第六轮时）的生产代码——负对照用。
//
// 第五轮从未提交：它只存在于 detached 工作区的未提交改动里。归档里那份 diff
// （review-round4/code-state/retreat-dev-tracked.diff）＋ ef01bac 可以逐字重建它；
// 重建后按交接档记的 SHA-256 核对，对不上就直接失败（不拿一个"差不多"的旧版本当对照）。
// ════════════════════════════════════════════════════════════════════
const ROUND5_SHA: Record<string, string> = {
  "apps/web/src/ChatPanel.tsx": "3615474f6cbab0285e29008eeb1ee9747fbf4ccd0d89f0f64e27b6cdc9a6b4b0",
  "packages/core/src/tacticalPlanner.ts": "114106c67f39724db1f21858c090a84e823955e32970ff31901ba282a9962202",
  "packages/shared/src/schema.ts": "4a5cd291a3527294287c951a54b2dc449195fe760a1b9a220feee14100e9466d",
  // 交接档没记这一个；取自第六轮开工时对 detached 工作区的原样备份（同一备份的上面三个与交接档逐字一致）。
  "apps/web/src/execReceipt.ts": "758a06e345822dedf4af75c7b8cb1be8b10c08f927c09f29f36df16940cdf968",
};
export const ROUND5_DIFF = join(homedir(), "MyProjects/_archive/retreat-scope-g-batch-20260923/review-round4/code-state/retreat-dev-tracked.diff");
export function round5Sources(): Record<string, string> {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "round5-"));
  const files = Object.keys(ROUND5_SHA);
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), execFileSync("git", ["show", `ef01bac:${f}`], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }));
  }
  execFileSync("git", ["apply", ...files.map((f) => `--include=${f}`), ROUND5_DIFF], { cwd: dir });
  const out: Record<string, string> = {};
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    const sha = createHash("sha256").update(text).digest("hex");
    assert.equal(sha, ROUND5_SHA[f], `round-5 ${f} rebuilt from the archive does not match the handoff SHA`);
    out[f] = text;
  }
  return out;
}
/** 从一份源码里取几个声明，转成可调用的函数（旧版本 core/shared 函数，负对照用）。
 *  `deps`：旧函数引用、但没有一起取出来的外部名字（例如 core 里未改动的导出）。 */
export function oldFunctions(src: string, names: string[], exportNames: string[], deps: Record<string, unknown> = {}): Record<string, unknown> {
  const js = ts.transpileModule(names.map((n) => declaration(src, n).replace(/^export\s+/, "")).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(deps), `${js}\nreturn { ${exportNames.join(", ")} };`)(...Object.values(deps));
}

// ════════════════════════════════════════════════════════════════════
// 第六轮收工时的生产代码（第七轮的负对照基线）：ef01bac ＋ 归档 review-round6/code-state 的
// 最终 diff ＋ 未跟踪文件，按归档里记的 SHA-256 核对。
// ════════════════════════════════════════════════════════════════════
const ROUND6_DIR = join(homedir(), "MyProjects/_archive/retreat-scope-g-batch-20260923/review-round6/code-state");
const ROUND6_SHA: Record<string, string> = {
  "apps/web/src/ChatPanel.tsx": "3138d36ea298b67bd6e49ff38229830afc494fbf714781994c51fb475d40d8c1",
  "packages/core/src/tacticalPlanner.ts": "f967c440efcc11dca592df8f7472973f1e36dc2adf460c1a7a403a89d8493298",
  "packages/shared/src/schema.ts": "63765ff7a4e588b1fa0917c44f2033e28cd06ac9b7a02b63106e6620156fdcb7",
  "packages/core/src/repeatDispatch.ts": "84ce9bafa8d5a50a2e5d7b52eeae31c355113e9273ccd89116485ce1978af6d2",
  "apps/web/src/execReceipt.ts": "e176e363eb0edd971c37cb5652dc67719dedd02b6a662c706950bc95924ff926",
};
/** 某一轮收工态的逐字重建：ef01bac ＋ 那一轮归档的最终 diff ＋ 未跟踪文件，逐个核记下的 SHA-256。 */
function archivedRoundSources(label: string, dir0: string, prefix: string, sha: Record<string, string>): Record<string, string> {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  const tracked = ["apps/web/src/ChatPanel.tsx", "packages/core/src/tacticalPlanner.ts", "packages/shared/src/schema.ts",
    "apps/web/src/execReceipt.ts", "apps/web/src/voiceSpeech.ts", "apps/web/src/autoExecuteGate.ts"];
  for (const f of tracked) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), execFileSync("git", ["show", `ef01bac:${f}`], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }));
  }
  execFileSync("git", ["apply", ...tracked.map((f) => `--include=${f}`), join(dir0, `${prefix}-tracked.diff`)], { cwd: dir });
  execFileSync("tar", ["xf", join(dir0, `${prefix}-untracked.tar`), "-C", dir, "packages/core/src/repeatDispatch.ts"]);
  const out: Record<string, string> = {};
  for (const f of [...tracked, "packages/core/src/repeatDispatch.ts"]) {
    const text = readFileSync(join(dir, f), "utf8");
    if (sha[f]) {
      assert.equal(createHash("sha256").update(text).digest("hex"), sha[f], `${label} ${f} rebuilt from the archive does not match its recorded SHA`);
    }
    out[f] = text;
  }
  return out;
}
export function round6Sources(): Record<string, string> {
  return archivedRoundSources("round6", ROUND6_DIR, "round6-final", ROUND6_SHA);
}

// 第七轮收工时的生产代码（第八轮的负对照基线）：SHA 取自 review-round7/code-state/round7-final-sha256.txt。
const ROUND7_DIR = join(homedir(), "MyProjects/_archive/retreat-scope-g-batch-20260923/review-round7/code-state");
const ROUND7_SHA: Record<string, string> = {
  "apps/web/src/ChatPanel.tsx": "74c287ba19a0cbd8220b43a8947122004c811616416f5b9a2eedef4f0b466afb",
  "apps/web/src/voiceSpeech.ts": "acb0db8a7a4d3d8281629292a12927ac275aa9f451d74e233d23167605ab70b0",
  "packages/core/src/tacticalPlanner.ts": "1a3c6fe7a0caa1925626c2d3dad6494d5c6e9daa17bea0128443362ab066e869",
  "packages/core/src/repeatDispatch.ts": "f2a7848bf8f819665c14fee956a8129f59921192cfe8dc8dba898f6e733d6ecb",
};
export function round7Sources(): Record<string, string> {
  return archivedRoundSources("round7", ROUND7_DIR, "round7-final", ROUND7_SHA);
}

// 第八轮收工时的生产代码（第九轮的负对照基线）：SHA 取自 review-round8/code-state/round8-final-sha256.txt。
const ROUND8_DIR = join(homedir(), "MyProjects/_archive/retreat-scope-g-batch-20260923/review-round8/code-state");
const ROUND8_SHA: Record<string, string> = {
  "apps/web/src/ChatPanel.tsx": "19c8612e26614b04fb3ad12d45a1e3280ebb015121a48f2903c99ee3782b7ea0",
  "packages/core/src/tacticalPlanner.ts": "10d73529562697836f66ddc487ecc4ad149cd7a0610f3a5ef57911d5a1edb623",
};
export function round8Sources(): Record<string, string> {
  return archivedRoundSources("round8", ROUND8_DIR, "round8-final", ROUND8_SHA);
}
