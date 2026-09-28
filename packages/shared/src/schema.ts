// ============================================================
// AI Commander — LLM Output Validation
// Validates and sanitizes JSON from DeepSeek/Claude/OpenAI
// Single source of truth for action/intent whitelists
// ============================================================

import type {
  AdvisorResponse,
  AdvisorOption,
  LightAdvisorResponse,
  OrderAction,
  ResponseType,
  PendingDecision,
  PendingRequestTag,
  PendingContractView,
  PendingVerdict,
  AdvisorFailure,
} from "./types";
import type { IntentType, Intent, UrgencyLevel, UnitCategoryHint } from "./intents";
// 刀己：选来源的答复，与 pendingDecision 同族的白名单登记
import { parseSelectionDecision } from "./dispatchSelection";

const VALID_RESPONSE_TYPES: readonly ResponseType[] = ["EXECUTE", "CONFIRM", "ASK", "NOOP"];

// ── Whitelists (single source of truth — import from here, don't duplicate) ──

export const VALID_ACTIONS: readonly OrderAction[] = [
  "attack_move", "defend", "retreat", "flank", "hold",
  "patrol", "escort", "sabotage", "recon", "produce", "trade",
] as const;

export const VALID_INTENT_TYPES: readonly IntentType[] = [
  "reinforce", "attack", "defend", "retreat", "flank",
  "sabotage", "recon", "patrol", "escort", "hold",
  "air_support", "produce", "trade", "capture", "cover_retreat",
] as const;

// Tactical planner supported intent types (Day 7 base + Day 9 economy + Day 11 sabotage).
export const DAY7_SUPPORTED_INTENT_TYPES: readonly IntentType[] = [
  "attack",
  "defend",
  "retreat",
  "recon",
  "hold",
  "produce",
  "trade",
  "patrol",
  "sabotage",
  "capture",
] as const;

const VALID_URGENCY: readonly UrgencyLevel[] = ["low", "medium", "high", "critical"];
const VALID_UNIT_CATEGORY: readonly UnitCategoryHint[] = ["armor", "infantry", "air", "naval"];

// ── Parsing ──

/**
 * Try to parse LLM output as JSON. Handles markdown code blocks.
 */
export function safeParse(raw: string): unknown | null {
  let text = raw.trim();
  // Strip markdown code fences
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Intent Sanitization ──

/**
 * Sanitize an intent object from LLM output.
 * Strips invalid fields, ensures type is in whitelist.
 * Returns null if intent type is invalid.
 */
export function sanitizeIntent(raw: unknown): Intent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (!VALID_INTENT_TYPES.includes(obj.type as IntentType)) return null;

  const intent: Intent = { type: obj.type as IntentType };

  // Squad-level dispatch (Day 10.5) — sanitize with trim + sentinel filter
  if (typeof obj.fromSquad === "string" && obj.fromSquad.trim().length > 0) {
    const sq = obj.fromSquad.trim();
    // Day 11: filter sentinel values LLM sometimes emits
    const SQUAD_SENTINELS = ["none", "unassigned", "null", "n/a", "undefined", ""];
    if (!SQUAD_SENTINELS.includes(sq.toLowerCase())) {
      intent.fromSquad = sq;
    }
  }

  // retreat-scope 刀C — fromDispatch（任务号）。
  // ★ 这一步最容易漏：白名单以外的字段在这里被**静默剥掉**，连报错都没有
  //   ——引擎端写得再对，模型填的号也到不了。同 fromSquad 一样过 sentinel 滤网。
  if (typeof obj.fromDispatch === "string" && obj.fromDispatch.trim().length > 0) {
    const fd = obj.fromDispatch.trim();
    const DISPATCH_SENTINELS = ["none", "null", "n/a", "undefined", ""];
    if (!DISPATCH_SENTINELS.includes(fd.toLowerCase())) {
      intent.fromDispatch = fd;
    }
  }

  // 刀寅：目的地模式「回到出发地」。严格只认一个值；别的写法一律当没写（不猜）。
  // ★第六轮：模型懂了「回原处」、却把字段名写成 retreatTo（真模型回包：本轮 recall 失败的 3/3、
  //   第五轮归档 2 例）。白名单重建把它静默剥掉 ⇒ 成了裸撤退 ⇒ 往安全区撤，而不是回出发地——
  //   丢掉的恰好是限定去处的那一样，执行范围就被放大了。只认 **"origin" 这一个值**（与 returnTo 同一条
  //   严格规矩）；retreatTo 写成别的东西照旧当没写，不猜它指哪儿。
  if (obj.returnTo === "origin" || obj.retreatTo === "origin") intent.returnTo = "origin";
  // 刀寅：去处原话（只收不长的一段字；空串当没写）。
  if (typeof obj.destinationQuote === "string") {
    const q = obj.destinationQuote.trim();
    if (q.length > 0 && q.length <= 40) intent.destinationQuote = q;
  }
  if (typeof obj.quantityQuote === "string") {
    const q = obj.quantityQuote.trim();
    if (q.length > 0 && q.length <= 20) intent.quantityQuote = q;
  }

  // Optional string fields — strip empty strings to avoid downstream mis-matches
  if (typeof obj.fromFront === "string" && obj.fromFront.trim().length > 0) intent.fromFront = obj.fromFront.trim();
  if (typeof obj.toFront === "string" && obj.toFront.trim().length > 0) intent.toFront = obj.toFront.trim();
  if (typeof obj.targetFacility === "string" && obj.targetFacility.trim().length > 0) intent.targetFacility = obj.targetFacility.trim();
  if (typeof obj.targetRegion === "string" && obj.targetRegion.trim().length > 0) intent.targetRegion = obj.targetRegion.trim();

  // unitType
  if (VALID_UNIT_CATEGORY.includes(obj.unitType as UnitCategoryHint)) {
    intent.unitType = obj.unitType as UnitCategoryHint;
  }

  // quantity
  if (typeof obj.quantity === "number" && obj.quantity > 0) {
    intent.quantity = obj.quantity;
  } else if (typeof obj.quantity === "string" && ["all", "most", "some", "few"].includes(obj.quantity)) {
    intent.quantity = obj.quantity as "all" | "most" | "some" | "few";
  }

  // urgency
  if (VALID_URGENCY.includes(obj.urgency as UrgencyLevel)) {
    intent.urgency = obj.urgency as UrgencyLevel;
  }

  // Booleans
  if (typeof obj.minimizeLosses === "boolean") intent.minimizeLosses = obj.minimizeLosses;
  if (typeof obj.airCover === "boolean") intent.airCover = obj.airCover;
  if (typeof obj.holdAfter === "boolean") intent.holdAfter = obj.holdAfter;
  if (typeof obj.stealth === "boolean") intent.stealth = obj.stealth;

  // Production / trade
  if (typeof obj.produceType === "string") intent.produceType = obj.produceType;
  if (typeof obj.tradeAction === "string") intent.tradeAction = obj.tradeAction;

  // 7b.1: budget-scaled trade. Defensive — anything malformed is omitted, which
  // the engine treats as a normal one-shot buy (so a bad parse can never silently
  // drain all the player's money). The engine, never the LLM, does the arithmetic.
  if (obj.tradeBudget && typeof obj.tradeBudget === "object" && !Array.isArray(obj.tradeBudget)) {
    const tb = obj.tradeBudget as Record<string, unknown>;
    if (tb.mode === "single") {
      intent.tradeBudget = { mode: "single" };
    } else if (tb.mode === "fraction_of_money"
        && typeof tb.fraction === "number" && Number.isFinite(tb.fraction)) {
      // Safety: only honor a budget buy when fraction is a real, finite number,
      // clamped to [0,1]. A missing / NaN / Infinity fraction is a malformed parse →
      // leave tradeBudget UNSET so the engine runs the normal single buy. A dropped
      // field must NEVER silently spend all the money. "全部钱买X" still works because
      // the LLM emits fraction:1 explicitly.
      intent.tradeBudget = { mode: "fraction_of_money", fraction: Math.max(0, Math.min(1, tb.fraction)) };
    }
    // single, fraction_of_money w/ missing|bad fraction, or any other mode
    //   → leave tradeBudget undefined → single (old one-shot buy) behavior
  }

  // emily-production-v1: budget-scaled produce — byte-for-byte the tradeBudget
  // sanitize pattern above. Anything malformed is omitted, which the engine
  // treats as the old numeric-quantity path (a bad parse can never silently
  // spend all the money). The engine, never the LLM, does the arithmetic.
  if (obj.produceBudget && typeof obj.produceBudget === "object" && !Array.isArray(obj.produceBudget)) {
    const pb = obj.produceBudget as Record<string, unknown>;
    if (pb.mode === "single") {
      intent.produceBudget = { mode: "single" };
    } else if (pb.mode === "fraction_of_money"
        && typeof pb.fraction === "number" && Number.isFinite(pb.fraction)) {
      intent.produceBudget = { mode: "fraction_of_money", fraction: Math.max(0, Math.min(1, pb.fraction)) };
    }
    // single, fraction_of_money w/ missing|bad fraction, or any other mode
    //   → leave produceBudget undefined → old numeric-quantity behavior
  }

  // Patrol radius (Day 9.5): clamp [3, 30], integer
  if (typeof obj.patrolRadius === "number") {
    intent.patrolRadius = Math.round(Math.max(3, Math.min(30, obj.patrolRadius)));
  }

  // Source filtering (internal): exclude units inside a specific front
  if (typeof obj.excludeFront === "string" && obj.excludeFront.trim().length > 0) {
    intent.excludeFront = obj.excludeFront.trim();
  }

  // P1.F: formation override — whitelist enforcement
  if (typeof obj.formationStyle === "string"
      && (["line", "wedge", "column", "encircle"] as const).includes(obj.formationStyle as "line" | "wedge" | "column" | "encircle")) {
    intent.formationStyle = obj.formationStyle as "line" | "wedge" | "column" | "encircle";
  }

  // Step 2: Route fields — preserved for tacticalPlanner consumption
  // (16+ refs in tacticalPlanner.ts; sanitizer must pass them through, otherwise
  // routeId/routeIds get silently dropped and route-aware pathfinding never fires)
  if (typeof obj.routeId === "string" && obj.routeId.trim().length > 0) {
    intent.routeId = obj.routeId.trim();
  }
  if (Array.isArray(obj.routeIds)) {
    const validIds = (obj.routeIds as unknown[])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
    if (validIds.length > 0) intent.routeIds = validIds;
  }

  return intent;
}

// ── Response Validation ──

/**
 * Validate an AdvisorResponse from LLM.
 * Returns sanitized response or null if invalid.
 */
// ── Command-Preflight 地基二: pending decision parsing + consumption judge ──

/** STRICT literal parse — exactly "authorize"|"cancel"|"amend"|null. Anything
 *  else (missing, wrong case, synonyms) → undefined = protocol failure when a
 *  contract was pending. NEVER EXPAND — semantic judgment lives in the model,
 *  not in string normalization here. */
export function parsePendingDecision(v: unknown): PendingDecision | undefined {
  if (v === null) return null;
  if (v === "authorize" || v === "cancel" || v === "amend") return v;
  return undefined;
}

/**
 * Pure consumption judge (Codex 地基二 hard constraints): a response may only
 * consume a pending contract when the REQUEST was tagged and the tag still
 * matches the live contract on id + channel + session, the contract is in
 * awaiting_reply (voicing must never authorize — no informed consent before
 * the concern is visible), and it has not expired. Everything else degrades
 * safely: stale tags reject the contract; a missing/invalid decision while
 * tagged executes NOTHING on either side.
 */
export function judgePendingConsumption(args: {
  requestTag: PendingRequestTag | null;
  current: PendingContractView | null;
  now: number;
  decision: PendingDecision | undefined;
}): PendingVerdict {
  const { requestTag, current, now, decision } = args;
  if (!requestTag) return "no_pending";
  if (
    !current ||
    current.id !== requestTag.pendingId ||
    current.channel !== requestTag.channel ||
    current.sessionId !== requestTag.sessionId ||
    current.phase !== "awaiting_reply" ||
    now > current.expiresAt
  ) {
    return "stale";
  }
  if (decision === undefined) return "protocol_failure";
  if (decision === null) return "unrelated";
  return decision;
}

// 刀寅的 `authorizeContradicts`（只比动作种类）已由 core 的 `contractReplyConflict` 取代（第六/七轮）：
// 批准与同一份回复里的单子是否一致，要比人数 / 兵种 / 来源 / 去处 / 动作 / 条数，
// 而去处比较要看地图（设施在不在那条战线里），所以判定挪进了 core。

/**
 * Consumption-layer routing table (Codex step2-fix): what each verdict is
 * allowed to execute. The UI layer must obey this table verbatim — it is the
 * single bench-testable truth for "stale executes NOTHING" (no old contract,
 * no new options, no doctrine; a stale duplicate delivery — e.g. a stream
 * that already processed options, errored, and re-entered via the fallback
 * path — must be inert the second time).
 */
export function pendingVerdictRoute(v: PendingVerdict): {
  /** Execute the CAPTURED old contract (authorize only). */
  executeOldContract: boolean;
  /** Process THIS response normally (options / NOOP / doctrine). */
  processResponse: boolean;
} {
  switch (v) {
    case "authorize":        return { executeOldContract: true,  processResponse: false };
    case "amend":            return { executeOldContract: false, processResponse: true };
    case "cancel":           return { executeOldContract: false, processResponse: false };
    case "protocol_failure": return { executeOldContract: false, processResponse: false };
    case "stale":            return { executeOldContract: false, processResponse: false };
    case "unrelated":        return { executeOldContract: false, processResponse: true };
    case "no_pending":       return { executeOldContract: false, processResponse: true };
  }
}

export function validateAdvisorResponse(data: unknown): AdvisorResponse | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  if (typeof obj.brief !== "string") return null;
  if (!Array.isArray(obj.options)) return null;

  // Parse responseType if present (case-insensitive — LLM may return "noop"/"Noop")
  const rawRT = typeof obj.responseType === "string" ? obj.responseType.toUpperCase() : undefined;
  const responseType = (rawRT && VALID_RESPONSE_TYPES.includes(rawRT as ResponseType))
    ? rawRT as ResponseType
    : undefined;

  // Doctrine fields — extract early so NOOP/empty-options paths also get them
  let standingOrder: AdvisorResponse["standingOrder"] | undefined;
  if (obj.standingOrder && typeof obj.standingOrder === "object") {
    const so = obj.standingOrder as Record<string, unknown>;
    if (typeof so.type === "string" && typeof so.locationTag === "string") {
      standingOrder = {
        type: so.type,
        locationTag: so.locationTag,
        priority: typeof so.priority === "string" ? so.priority : "normal",
        allowAutoReinforce: typeof so.allowAutoReinforce === "boolean" ? so.allowAutoReinforce : false,
      };
    }
  }
  const cancelDoctrineId = typeof obj.cancelDoctrine === "string" && obj.cancelDoctrine.length > 0
    ? obj.cancelDoctrine
    : undefined;

  // 地基二: parsed ONCE, carried through BOTH return paths below (empty and
  // non-empty options) — the decision must never be dropped by either path.
  const pendingDecision = parsePendingDecision(obj.pendingDecision);

  // 刀己：对「您说的是哪一批？」的答复。与 pendingDecision 同族的白名单登记
  // ——不登记在这儿，模型填了也到不了客户端（本函数是白名单重建，没登记的
  // 根级字段一律静默消失）。**两条 return 路径都要带。**
  const dispatchSelection = parseSelectionDecision(obj.dispatchSelection);

  // 语音输入 V1: heard = 模型转写的长官原话。同 pendingDecision 一样，这里是
  // 全仓**唯一**能给 AdvisorResponse 装上 heard 的地方——本函数是白名单重建，
  // 没登记的根级字段一律静默消失。所以下面两条 return 都要带上它。
  // （反过来说：createFallbackResponse 是手写字面量、根本不经过这儿，
  //   所以任何兜底回执一定没有 heard——语音回合的 fail-closed 判定因此同时
  //   罩住了"模型漏字段"和"通讯故障走兜底"两种情况。）
  // 只做一件规范化：去掉首尾空白；空串按缺席算，不制造一个"听到了但没内容"的假在场。
  const heardRaw = typeof obj.heard === "string" ? obj.heard.trim() : "";
  const heard = heardRaw.length > 0 ? heardRaw : undefined;

  // spoken 层：只给耳朵的那一两句。与 heard 同族、同规范化、同两条 return 路径
  // ——理由一模一样（白名单重建之外没有第二个入口），所以病也会一模一样：
  // 只补一条路径的话，NOOP/空 options 那一轮的 spoken 会静静消失，客户端退回
  // 念正文，谁都不会红。空串按缺席算，让"缺席即念正文"这条兜底只有一种形状。
  const spokenRaw = typeof obj.spoken === "string" ? obj.spoken.trim() : "";
  const spoken = spokenRaw.length > 0 ? spokenRaw : undefined;

  // Day 13 Layer B: LLM may return empty options[] to reject invalid commands.
  // Phase 2: NOOP responseType with options:[] is a valid conversational response.
  if (obj.options.length === 0) {
    const urgency = typeof obj.urgency === "number"
      ? Math.max(0, Math.min(1, obj.urgency))
      : 0;
    return {
      brief: obj.brief as string,
      options: [],
      recommended: "A" as const,
      urgency,
      responseType,
      standingOrder,
      cancelDoctrine: cancelDoctrineId,
      pendingDecision,
      dispatchSelection,
      heard,
      spoken,
    };
  }

  const validOptions = (obj.options as unknown[])
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => {
      if (typeof o.label !== "string") return null;
      if (typeof o.description !== "string") return null;
      const risk = typeof o.risk === "number" ? Math.max(0, Math.min(1, o.risk)) : 0.5;
      const reward = typeof o.reward === "number" ? Math.max(0, Math.min(1, o.reward)) : 0.5;

      // Multi-intent: accept "intents" (array) or "intent" (single, wrap to array)
      let intents: Intent[] = [];
      if (Array.isArray(o.intents)) {
        for (const raw of o.intents) {
          const i = sanitizeIntent(raw);
          if (i) intents.push(i);
        }
      }
      if (intents.length === 0 && o.intent) {
        const single = sanitizeIntent(o.intent);
        if (single) intents = [single];
      }
      if (intents.length === 0) return null;

      // Prompt6: cap intents per option at 5 to match schema safety limit
      if (intents.length > 5) {
        console.warn(`[schema] Option "${o.label}" had ${intents.length} intents — truncated to 5`);
        intents = intents.slice(0, 5);
      }

      return {
        label: o.label,
        description: o.description,
        risk,
        reward,
        intent: intents[0],     // backward compat: first intent
        intents,                 // full array
      } as AdvisorOption;
    })
    .filter((o): o is AdvisorOption => o !== null)
    .slice(0, 3);

  if (validOptions.length === 0) return null;

  const recommended = typeof obj.recommended === "string" ? obj.recommended : "A";
  const urgency = typeof obj.urgency === "number"
    ? Math.max(0, Math.min(1, obj.urgency))
    : 0.5;

  // Enforce: NOOP must have empty options. If LLM returned NOOP with options, drop responseType.
  const effectiveRT = (responseType === "NOOP" && validOptions.length > 0)
    ? undefined
    : responseType;

  return {
    brief: obj.brief as string,
    options: validOptions,
    recommended: recommended as "A" | "B" | "C",
    urgency,
    responseType: effectiveRT,
    suggestProduction: obj.suggest_production
      ? (obj.suggest_production as AdvisorResponse["suggestProduction"])
      : undefined,
    standingOrder,
    cancelDoctrine: cancelDoctrineId,
    pendingDecision,
    dispatchSelection,
    heard,
    spoken,
  };
}

/**
 * Validate a LightAdvisorResponse (brief only, no orders).
 */
export function validateLightResponse(data: unknown): LightAdvisorResponse | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.brief !== "string") return null;
  const urgency = typeof obj.urgency === "number"
    ? Math.max(0, Math.min(1, obj.urgency))
    : 0.5;
  return { brief: obj.brief as string, urgency };
}

/**
 * Check if an action string is in the allowed set.
 */
export function isValidAction(action: string): action is OrderAction {
  return VALID_ACTIONS.includes(action as OrderAction);
}

/**
 * Check if an intent type is in the allowed set.
 */
export function isValidIntentType(type: string): type is IntentType {
  return VALID_INTENT_TYPES.includes(type as IntentType);
}

export function isDay7SupportedIntentType(type: IntentType): boolean {
  return DAY7_SUPPORTED_INTENT_TYPES.includes(type);
}

// ── Fallback Response ──

/**
 * 失败轮屏上／耳朵里／context 里那一句：**引擎的事实**（没收到可用答复、什么都没执行），
 * 不是人物台词。服务端兜底的 brief 与客户端的失败分支共用这一处。
 */
export function advisorFailureLine(kind: AdvisorFailure): string {
  return kind === "parse"
    ? "通讯干扰，参谋的答复没能解析——这句命令没有执行，请再说一遍。"
    : "通讯中断，参谋没能答复——这句命令没有执行，请再说一遍。";
}

/**
 * 这一份回复是不是**失败轮**。只认服务端兜底写入的 `failure` 字段——**不看 warning**
 * （正常答复也会带提示）。字段在场但不是已知值 ⇒ 仍按失败算（fail-closed），按通讯中断说。
 */
export function advisorFailureOf(data: unknown): AdvisorFailure | null {
  if (!data || typeof data !== "object") return null;
  const f = (data as Record<string, unknown>).failure;
  if (f === undefined || f === null || f === false) return null;
  return f === "parse" ? "parse" : "comms";
}

/**
 * 模型没交回可用答复（非 JSON / 校验不过 / 通讯中断 / 限流）时服务端交给浏览器的那一份。
 *
 * ★第六轮：**不带任何可执行的东西**，并明确标出失败（`failure`）。
 *   旧版带着三份可执行默认方案（稳守 / 有限进攻 / 侦察），客户端又没把它排除在执行链之外：
 *   真实初始局里长官说「刚才那两个快撤」、模型那一轮解析失败 ⇒ 闸判 no_anchor、桶 A ⇒
 *   实际给 3 个单位下了设防令，屏上「已下令 3 个单位设防」（Codex 复现，台架 F1-F5）。
 *   现在服务端这一层不产生 options / 持续命令，客户端那一层见 `failure` 就零执行——两道网。
 *
 * brief 就是引擎那句事实（`advisorFailureLine`），不再有「以下为默认方案」之类指向屏上不存在之物的话。
 */
export function createFallbackResponse(kind: AdvisorFailure = "parse"): AdvisorResponse {
  return {
    brief: advisorFailureLine(kind),
    options: [],
    recommended: "A",
    urgency: 0.3,
    responseType: "NOOP",
    failure: kind,
  };
}
