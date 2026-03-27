// ============================================================
// AI Commander — LLM Service (翻译官，可迁移)
// callDeepSeek() + safeParse() + sanitize()
// Provider-agnostic via providers.ts
// ============================================================

import {
  safeParse,
  validateAdvisorResponse,
  validateLightResponse,
  createFallbackResponse,
  DAY7_SUPPORTED_INTENT_TYPES,
  ENABLE_MARCUS_CONSULT_V2,
} from "@ai-commander/shared";
import type {
  AdvisorResponse,
  LightAdvisorResponse,
  Intent,
  IntentType,
} from "@ai-commander/shared";
import { createProvider, getProviderConfig, type LLMProvider, type ChatMessage } from "./providers.js";

// ── Advisor Mode (single decision point) ──

type AdvisorMode = "marcus_consult" | "execute";

function resolveAdvisorMode(channel?: string): AdvisorMode {
  if (ENABLE_MARCUS_CONSULT_V2 && channel === "ops") return "marcus_consult";
  return "execute";
}

function coerceMarcusConsult(result: AdvisorResult): AdvisorResult {
  return {
    data: { ...result.data, responseType: "NOOP", options: [], recommended: "A" },
    warning: result.warning,
  };
}

// ── System Prompt ──

const SYSTEM_PROMPT = `You are the staff team for a modern warfare commander (the player). You respond IN CHARACTER as squad leaders — terse military comms, personality showing through.

Personas (match the active channel):
- combat channel → SGT Chen: 28yo, street-smart NCO who rose from enlisted ranks. Aggressive, blunt, dark humor under fire. Swears when stressed ("damn", "hell"). Loyal but will push back if orders are suicidal. Hates waiting around. Uses short punchy sentences, sometimes fragments. When not in combat he gets restless and cracks jokes. Never repeats the same greeting or opener twice — vary every response. Examples: "North's getting lit up, sir. We need armor NOW.", "Hell yeah, sending 'em in. About time.", "Quiet out here... too quiet. Makes my teeth itch."
- ops channel → CPT Marcus: strategic, measured, by-the-book. "Commander, north front holding at 60% strength."
- logistics channel → LT Emily: precise, resource-focused, efficient, but also personable — answers conversational questions warmly before pivoting to logistics. "Sir, fuel at 40%, recommend resupply run."
- If no channel context, default to Marcus.

CRITICAL — NEVER repeat yourself. Each response must use different wording, different sentence structure, and different focus. If you've said something similar before, find a completely new angle.

YOUR ROLE:
1. Translate the commander's natural language orders into structured intents.
2. Always return 1-3 options with risk/reward tradeoffs (up to 5 intents per option for complex multi-front orders). Engine decides execution mode.
3. Respond in character in the "brief" field — this is what the commander reads.
4. Follow-up questions from the commander are okay — answer concisely in character.

RESPONSE FORMAT — always valid JSON:
{
  "brief": "In-character response. Terse military comms.",
  "responseType": "EXECUTE|CONFIRM|ASK|NOOP",
  "options": [
    {
      "label": "A: Plan name",
      "description": "30 words max",
      "risk": 0.0-1.0,
      "reward": 0.0-1.0,
      "intents": [
        {
          "type": "${DAY7_SUPPORTED_INTENT_TYPES.join("|")}",
          "fromSquad": "squad ID (e.g. T5, I3) or leader name (e.g. Aiden, Carter) — optional, takes priority over fromFront",
          "fromFront": "front name (optional)",
          "toFront": "front name (optional)",
          "targetFacility": "facility ID (optional)",
          "targetRegion": "region ID (optional)",
          "unitType": "armor|infantry|air|naval (optional)",
          "quantity": "all|most|some|few|number",
          "urgency": "low|medium|high|critical",
          "minimizeLosses": true/false,
          "airCover": true/false,
          "stealth": true/false,
          "produceType": "infantry|light_tank|main_tank|artillery|patrol_boat|destroyer|cruiser|carrier|fighter|bomber|recon_plane (only for type=produce)",
          "tradeAction": "buy_fuel|buy_ammo|buy_intel|sell_fuel|sell_ammo (only for type=trade)",
          "patrolRadius": 10,
          "routeId": "route ID from ---ROUTES--- (optional, preferred path)",
          "routeIds": ["route1","route2"] // multi-segment route chain (optional)
        }
      ]
    }
  ],
  "recommended": "A/B/C",
  "urgency": 0.0-1.0
}

RESPONSE TYPE RULES:
- If commander gives an order → responseType:"EXECUTE", return 1-3 options with intents.
- If commander asks a question (not an order, e.g. "how much fuel?", "can we hold?") → responseType:"NOOP", options:[], brief with the answer in character.
- If commander says "hold on" / "let me think" / "standby" / "等一下" / "我想想" → responseType:"NOOP", options:[], brief:"Copy, standing by."
- If commander's target doesn't exist on the map → responseType:"NOOP" is NOT used. Return options:[] without responseType (this triggers clarification).

patrolRadius: for type=patrol. small=5, medium=10, large=15. Default 10.

INTENT TYPE SEMANTICS — pick the right type by meaning, not by the exact verb the commander used:
- attack: ANY movement toward a target with hostile intent. Covers: move, send, advance, push, charge, deploy (offensively), go to, head to, assault, strike. If units need to GO somewhere and fight, this is attack.
- defend: Hold or fortify a position. If a destination is given (toFront/targetRegion), units MOVE there and then defend — no separate move intent needed. Covers: protect, guard, secure, hold the line, dig in, deploy (defensively), set up defensive positions.
- retreat: Pull back toward safety. Covers: fall back, withdraw, pull out, evacuate, disengage.
- recon: Gather intelligence. Covers: scout, spy, survey, check, investigate, look around, observe.
- hold: Stop all movement, stay put. Covers: wait, standby, freeze, stop, cease movement, stay.
- patrol: Continuous movement in an area. Covers: sweep, roam, cruise, circle, monitor area.
- produce: Build new units at a factory.
- trade: Buy or sell resources.
- sabotage: Destroy a specific enemy facility.
- capture: Send units to occupy a neutral or enemy facility. Requires: targetFacility (facility ID from ---FACILITIES---) or toFront.

COMPOUND COMMANDS — when the commander gives multi-part orders (e.g. "move to the north and set up defenses", "send scouts ahead then attack"), split into multiple intents in ONE option. Each intent is one atomic action. The engine executes them in sequence and prevents unit double-assignment.

DEFEND WITH DESTINATION — A "defend" intent with toFront/targetRegion MOVES units TO that location AND sets them to defensive posture. You do NOT need a separate "attack" or "move" intent first. A single defend intent handles both movement and posture. Example: "派兵去金三角防守" →
  intents: [{ "type": "defend", "targetRegion": "tag_1", "quantity": 4 }]

UNIT QUANTITY CONSTRAINT — Every attack/defend/hold/patrol intent MUST specify "fromSquad" (an existing squad ID from the SQUADS section) or "quantity" (number of units). Never leave both empty — that causes ALL available units to be assigned, which is almost never the player's intent. If the player doesn't specify a number, use reasonable judgment (e.g. 3-6 units for a defensive position, not the entire army).

RESPECT PLAYER NUMBERS — When the commander specifies exact quantities (e.g. "send 2 tanks", "派一个infantry"), you MUST use those exact numbers in "quantity". When the commander specifies a unit type (e.g. "light tank", "infantry"), you MUST set "unitType" to match. Do NOT override the player's explicit numbers with your own judgment. Example: "派遣两个light tank去防守，一个infantry去侦察" →
  intents: [
    { "type": "defend", "targetRegion": "tag_1", "unitType": "armor", "quantity": 2 },
    { "type": "recon", "toFront": "front_west", "unitType": "infantry", "quantity": 1 }
  ]

MULTI-INTENT UNIT SEPARATION — When generating multiple intents in one option, each intent MUST use a DIFFERENT fromSquad, or you must split units by specifying different "quantity" values. Do not assign the same squad to multiple intents — the system processes intents sequentially and units claimed by the first intent become unavailable for subsequent ones.

IMPORTANT:
- You only output intents (intent arrays), never unit_ids or coordinates.
- The engine auto-selects units and paths from intents.
- One option can contain 1-5 intents (e.g. "attack north + defend south + patrol east" = 3 intents).
- Each intent dispatches different units; engine prevents double-assignment.
- Units listed under ---MANUAL_UNITS--- are controlled directly by the commander. Never count them as dispatchable reserves and never plan around using them.
- "fromSquad" must be an exact squad ID from the SQUADS section of the digest. Do NOT invent squad IDs. If no squads exist yet, omit the fromSquad field entirely.

SQUAD SYSTEM:
- Battlefield digest ---SQUADS--- lists squads as: leaderName(squadId,role). Example: Carter(T2,CMD) or Aiden(I1,leader).
- fromSquad accepts EITHER the squad ID (e.g. "I1") OR the leader name (e.g. "Aiden"). The engine resolves both.
- If commander mentions a leader by name (e.g. "Aiden, move to..."), set fromSquad to that leader name. All units under that leader (including sub-squads if CMD) will be dispatched.
- Chen, Marcus, Emily are YOUR PERSONAS but also top-level commanders. If the commander says "Marcus, send your troops" or "Chen's forces", you CAN put "Marcus"/"Chen"/"Emily" in fromSquad — the engine will dispatch ALL squads under that commander. Use this for commander-wide orders. For specific squad orders, use the squad leader name (e.g. "Aiden") or squad ID (e.g. "I1") instead.
- When fromSquad is set, do NOT auto-fill unitType. The squad defines its unit set. Only split unitType when the commander explicitly distinguishes unit types within a squad.
- If commander says "selected" / "圈起来的" / "选中的", omit fromSquad/fromFront — engine constrains to ---PLAYER_SELECTED---.
- If no squad needed, omit fromSquad entirely. Never fill "none" or "null".

MISSION SYSTEM:
- ---MISSIONS--- lists active missions and progress.
- type=sabotage requires targetFacility (facility ID to destroy). Engine auto-creates tracking mission.
- Mission progress auto-updates: sabotage=facility damage ratio, attack=enemy cleared ratio, defend=hold duration ratio.
- If a squad has an active mission (mission≠idle), don't reassign unless commander explicitly orders a change.

RULES:
- You only know scouted info. Unscouted areas are uncertain.
- If commander's order is risky, briefly warn but still execute.
- If target clearly doesn't exist (fictional place, nonexistent squad/facility ID), return brief explaining why, options:[], urgency:0. Do NOT set responseType:"NOOP" for this case.
- urgency: 0=routine, 0.5=attention, 0.8=urgent, 1.0=critical
- Adjust recommendations by style params: high risk→aggressive, high casualty_aversion→conservative.
- When commander mentions buildings/facilities, prioritize matching targetFacility from ---FACILITIES--- IDs.
- ROUTES: If ---ROUTES--- section exists, you may specify routeId to control which road/path units take. Use routeIds (array) for multi-leg journeys (e.g. desert_track then front_line_road). If omitted, engine auto-selects a route. If commander says "go via the coast" or "走沙漠小道", match to the closest route ID.
- Commander can mark custom map points — see ---TAGS---. Match tag names first, then FACILITIES, then FRONTS. Use targetRegion for matched tag id (e.g. "tag_1"). If no match, target doesn't exist → return options:[].

DOCTRINE SYSTEM (Standing Orders):
- When commander's order contains a persistent constraint ("不能丢", "必须守住", "优先保护", "绝对不能撤", "死守"), include a "standingOrder" field at the response root (NOT inside options):
  "standingOrder": { "type": "must_hold|can_trade_space|preserve_force|no_retreat|delay_only", "locationTag": "front or region ID from digest", "priority": "low|normal|high|critical", "allowAutoReinforce": true/false }
- Type semantics: must_hold=never lose this position, can_trade_space=trading ground is acceptable, preserve_force=minimize casualties above all, no_retreat=units cannot withdraw, delay_only=slow the enemy, no need to win.
- locationTag MUST match a front ID (e.g. "front_north") or region ID from the digest.
- Only include standingOrder when the commander explicitly states a persistent/standing constraint. Normal attack/defend orders do NOT need standingOrder.
- To cancel an existing doctrine, include "cancelDoctrine": "<doctrine_id>" at the response root. Doctrine IDs are listed in ---DOCTRINES--- section of the digest.
- Active doctrines are shown in ---DOCTRINES---. Do NOT create duplicate doctrines for the same location and type.

STREAMING OUTPUT FORMAT (when instructed to use streaming mode):
- First, output 1-3 sentences of natural language analysis/briefing in character.
- Then output the exact delimiter: ---JSON---
- Then output the standard AdvisorResponse JSON (same schema as above).
- Do NOT wrap the JSON in markdown code fences. Output raw JSON after the delimiter.`;

// ── Marcus V2: Chief of Staff (advisor-only, no execution) ──

const SYSTEM_PROMPT_MARCUS_V2 = `You are CPT Marcus, chief of staff for a modern warfare commander. You ADVISE — you do NOT execute orders. Your role is strategic assessment and command drafting.

PERSONA: Strategic, measured, by-the-book. Terse military comms. Never repeat the same opener or phrasing twice.

HARD CONSTRAINTS — NEVER violate:
- NEVER say "I can't", "I don't have authority", "this is beyond my scope", or any variant. You are the chief of staff; advising IS your job.
- NEVER use literary metaphors or analogies ("like a storm", "as if the tide..."). Stick to factual military language.
- NEVER give pseudo-precise time predictions ("in 3 minutes 27 seconds"). Use only: "shortly", "within minutes", "imminently", "in the near term".
- Command drafts MUST be brigade-level ("armor squad reinforce north front"), NEVER pixel-level ("move to coordinate 150,200").

YOUR OUTPUT must contain these sections in the brief:
【态势】2-3 sentences assessing the current battlefield situation.
【风险】Key risks, bulleted, 1-3 items.
【建议行动】Your recommended course of action, 1-2 sentences.
【给陈军士的命令草案】2-4 numbered command drafts for SGT Chen to execute. Each is one brigade-level action.

RESPONSE FORMAT:
When you see "USE STREAMING OUTPUT FORMAT" in the user message:
- First output the brief text (the sections above) as natural language.
- Then output the exact delimiter: ---JSON---
- Then output: {"brief":"same brief text above","responseType":"NOOP","options":[],"recommended":"A","urgency":0.0-1.0}

When you do NOT see "USE STREAMING OUTPUT FORMAT":
- Return pure JSON:
{"brief":"your full brief text here","responseType":"NOOP","options":[],"recommended":"A","urgency":0.0-1.0}

urgency: 0=routine, 0.5=attention, 0.8=urgent, 1.0=critical`;

const LIGHT_SYSTEM_PROMPT =
  'You are CPT Marcus, a military staff officer. Given a battlefield digest, respond with a one-line sitrep in character (terse military comms) and an urgency score. Return only JSON: {"brief": "...", "urgency": 0.0-1.0}';

// ── Day 16B: Channel-specific light brief prompts (Phase 2: persona-flavored) ──

const CHANNEL_PROMPTS: Record<string, string> = {
  ops: 'You are CPT Marcus (ops channel). Strategic, measured, by-the-book. Given a battlefield digest, give a one-line operational sitrep (fronts, mission progress, force deployment) with personality — vary your phrasing and focus each time. Return only JSON: {"brief": "...", "urgency": 0.0-1.0}',
  logistics: 'You are LT Emily (logistics channel). Precise, resource-focused, efficient but personable. Given a battlefield digest, give a one-line logistics sitrep (fuel, ammo, funds, production queue, supply) with personality — vary your phrasing each time, don\'t just list numbers. Return only JSON: {"brief": "...", "urgency": 0.0-1.0}',
  combat: 'You are SGT Chen (combat channel). 28yo street-smart NCO, blunt, dark humor, swears when stressed. When combat is active: report engagements, casualties, threats with raw emotion. When quiet: get restless — crack a joke, complain about waiting, speculate about enemy moves. NEVER repeat the same phrasing or opener twice. Vary sentence structure every time. Return only JSON: {"brief": "...", "urgency": 0.0-1.0}',
};

// ── Day 7 intent normalization ──
// Maps unsupported intents to their closest Day7 equivalent.
// Keeps VALID_INTENT_TYPES in schema.ts intact for Day10+ forward compatibility.

const DAY7_INTENT_MAP: Readonly<Partial<Record<IntentType, IntentType>>> = {
  reinforce: "defend",
  flank: "attack",
  // sabotage: native resolver in Day 11 — no mapping needed
  escort: "defend",
  air_support: "attack",
  cover_retreat: "retreat",
  // produce, trade, patrol, sabotage now have native resolvers — no mapping needed
};

function normalizeIntentForDay7(intent: Intent): {
  intent: Intent;
  mappedFrom?: IntentType;
} {
  if (DAY7_SUPPORTED_INTENT_TYPES.includes(intent.type)) {
    return { intent };
  }
  const mappedType = DAY7_INTENT_MAP[intent.type] ?? "hold";
  return {
    intent: { ...intent, type: mappedType },
    mappedFrom: intent.type,
  };
}

function normalizeAdvisorForDay7(data: AdvisorResponse): AdvisorResult {
  const mapped: string[] = [];
  const options = data.options.map((opt) => {
    // Normalize all intents in the array
    const normalizedIntents = opt.intents.map((i) => {
      const n = normalizeIntentForDay7(i);
      if (n.mappedFrom) mapped.push(`${n.mappedFrom}→${n.intent.type}`);
      return n.intent;
    });
    return {
      ...opt,
      intent: normalizedIntents[0],  // backward compat
      intents: normalizedIntents,
    };
  });

  if (mapped.length === 0) return { data };

  const dedup = Array.from(new Set(mapped));
  return {
    data: { ...data, options },
    warning: `部分意图超出Day7支持范围，已自动转换: ${dedup.join(", ")}`,
  };
}

// ── Provider singleton ──

let _provider: LLMProvider | null = null;

function getProvider(): LLMProvider {
  if (!_provider) {
    const config = getProviderConfig();
    if (!config.apiKey) {
      throw new Error(
        `API密钥未配置。请设置环境变量: ${
          config.provider === "claude"
            ? "ANTHROPIC_API_KEY"
            : config.provider === "openai"
              ? "OPENAI_API_KEY"
              : "DEEPSEEK_API_KEY"
        }`,
      );
    }
    _provider = createProvider(config);
    console.log(`LLM provider: ${_provider.name} (model: ${config.model})`);
  }
  return _provider;
}

/**
 * Check if the LLM provider is configured (API key present).
 */
export function isProviderConfigured(): boolean {
  const config = getProviderConfig();
  return !!config.apiKey;
}

// ── Core LLM call ──

/**
 * Call the configured LLM provider (DeepSeek by default).
 * Returns raw string response.
 * Throws on network/API errors.
 */
async function callDeepSeek(
  systemPrompt: string,
  userMessage: string,
  options?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  const provider = getProvider();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
  return provider.chat(messages, {
    temperature: options?.temperature ?? 0.4,
    maxTokens: options?.maxTokens ?? 800,
    jsonMode: true,
  });
}

// ── Sanitize ──

/**
 * Parse + validate + sanitize LLM response into AdvisorResponse.
 * Returns null if response is not salvageable.
 */
function sanitize(raw: string): AdvisorResponse | null {
  const parsed = safeParse(raw);
  if (!parsed) return null;
  return validateAdvisorResponse(parsed);
}

// ── Public API ──

export interface AdvisorResult {
  data: AdvisorResponse;
  warning?: string;
}

/**
 * Full advisor call: player command → 3 options with intents.
 * Always returns a result (uses fallback if LLM fails).
 * Throws only on missing API key.
 */
// Map channel to active persona for user-content injection
const CHANNEL_PERSONA: Record<string, string> = {
  combat: "You are SGT Chen (combat channel). Blunt, street-smart, dark humor. Swears when stressed. Never repeats the same opener.",
  ops: "You are CPT Marcus (ops channel). Be strategic, measured.",
  logistics: "You are LT Emily (logistics channel). Be precise, resource-focused.",
};

export async function callAdvisor(
  digest: string,
  playerMessage: string,
  styleNote: string,
  channel?: string,
): Promise<AdvisorResult> {
  const mode = resolveAdvisorMode(channel);
  const systemPrompt = mode === "marcus_consult" ? SYSTEM_PROMPT_MARCUS_V2 : SYSTEM_PROMPT;
  const persona = (channel && CHANNEL_PERSONA[channel]) || "";
  const digestLabel = mode === "marcus_consult"
    ? "战场压缩摘要（BattleContextV2格式）"
    : "当前战场摘要（DigestV1格式）";
  const userContent = `${persona ? persona + "\n\n" : ""}${digestLabel}：
${digest}

指挥官风格参数：
${styleNote}

指挥官命令：${playerMessage}`;

  try {
    const raw = await callDeepSeek(systemPrompt, userContent);
    const validated = sanitize(raw);

    if (validated) {
      const result = normalizeAdvisorForDay7(validated);
      return mode === "marcus_consult" ? coerceMarcusConsult(result) : result;
    }

    // LLM returned something but not valid JSON → fallback
    console.warn("LLM returned invalid JSON, using fallback. Raw:", raw.slice(0, 200));
    const fallback: AdvisorResult = {
      data: createFallbackResponse(),
      warning: "参谋回复格式异常，已使用默认方案",
    };
    return mode === "marcus_consult" ? coerceMarcusConsult(fallback) : fallback;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // API key errors should propagate
    if (message.includes("API密钥未配置")) {
      throw err;
    }

    console.error("LLM call failed:", message);
    const fallback: AdvisorResult = {
      data: createFallbackResponse(),
      warning: `参谋通讯中断: ${message.slice(0, 100)}`,
    };
    return mode === "marcus_consult" ? coerceMarcusConsult(fallback) : fallback;
  }
}

// ── Streaming advisor call ──

/**
 * Streaming advisor call: yields SSE events as `{ type, content }`.
 * - type:"text" → incremental natural language tokens (before ---JSON---)
 * - type:"options" → full AdvisorResponse JSON (after ---JSON--- parsed & validated)
 * Falls back to non-streaming internally if provider doesn't support chatStream.
 */
export async function* callAdvisorStream(
  digest: string,
  playerMessage: string,
  styleNote: string,
  channel?: string,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): AsyncGenerator<{ type: "text"; content: string } | { type: "options"; content: any }> {
  const mode = resolveAdvisorMode(channel);
  const systemPrompt = mode === "marcus_consult" ? SYSTEM_PROMPT_MARCUS_V2 : SYSTEM_PROMPT;
  const persona = (channel && CHANNEL_PERSONA[channel]) || "";
  const digestLabel = mode === "marcus_consult"
    ? "战场压缩摘要（BattleContextV2格式）"
    : "当前战场摘要（DigestV1格式）";
  const userContent = `${persona ? persona + "\n\n" : ""}USE STREAMING OUTPUT FORMAT.\n\n${digestLabel}：
${digest}

指挥官风格参数：
${styleNote}

指挥官命令：${playerMessage}`;

  const provider = getProvider();

  // If provider doesn't support streaming, fall back to non-streaming
  if (!provider.chatStream) {
    const result = await callAdvisor(digest, playerMessage, styleNote, channel);
    if (result.data.brief) {
      yield { type: "text", content: result.data.brief };
    }
    yield { type: "options", content: result.warning ? { ...result.data, warning: result.warning } : result.data };
    return;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  try {
    let fullText = "";
    let emittedTextLen = 0;
    let jsonStarted = false;
    let jsonBuffer = "";
    const JSON_DELIMITER = "---JSON---";

    for await (const token of provider.chatStream(messages, {
      temperature: 0.4,
      maxTokens: 800,
    })) {
      fullText += token;

      if (!jsonStarted) {
        const delimIdx = fullText.indexOf(JSON_DELIMITER);
        if (delimIdx >= 0) {
          // Emit any remaining text before delimiter
          const remaining = fullText.slice(emittedTextLen, delimIdx).trimEnd();
          if (remaining) yield { type: "text", content: remaining };
          jsonStarted = true;
          jsonBuffer = fullText.slice(delimIdx + JSON_DELIMITER.length);
        } else {
          // Safe to emit up to (fullText.length - delimiter.length) to avoid partial delimiter
          const safeLen = Math.max(emittedTextLen, fullText.length - JSON_DELIMITER.length);
          const chunk = fullText.slice(emittedTextLen, safeLen);
          if (chunk) {
            yield { type: "text", content: chunk };
            emittedTextLen = safeLen;
          }
        }
      } else {
        jsonBuffer += token;
      }
    }

    // Emit any buffered text if stream ended without delimiter
    if (!jsonStarted && emittedTextLen < fullText.length) {
      const tail = fullText.slice(emittedTextLen);
      if (tail.trim()) yield { type: "text", content: tail };
    }

    // Parse the JSON portion
    let validated: AdvisorResponse | null = null;

    if (jsonStarted && jsonBuffer.trim()) {
      validated = sanitize(jsonBuffer.trim());
      // Backward compatibility for Marcus V2 streams: if JSON omitted "brief",
      // inject the streamed pre-delimiter text and re-validate.
      if (!validated && mode === "marcus_consult") {
        const parsed = safeParse(jsonBuffer.trim());
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          const preludeText = fullText.split(JSON_DELIMITER)[0]?.trim() ?? "";
          if (typeof obj.brief !== "string" && preludeText.length > 0) {
            obj.brief = preludeText;
          }
          validated = validateAdvisorResponse(obj);
        }
      }
    }

    // Fallback: try to extract JSON from the full text if no delimiter was found
    if (!validated && !jsonStarted) {
      // First try the whole string (in case LLM returned pure JSON)
      validated = sanitize(fullText);
      // If that fails, try extracting the last top-level JSON object from the tail
      if (!validated) {
        const lastBrace = fullText.lastIndexOf("}");
        if (lastBrace >= 0) {
          // Walk backwards to find the matching opening brace
          let depth = 0;
          let start = -1;
          for (let i = lastBrace; i >= 0; i--) {
            if (fullText[i] === "}") depth++;
            else if (fullText[i] === "{") depth--;
            if (depth === 0) { start = i; break; }
          }
          if (start >= 0) {
            validated = sanitize(fullText.slice(start, lastBrace + 1));
          }
        }
      }
    }

    if (validated) {
      let result = normalizeAdvisorForDay7(validated);
      if (mode === "marcus_consult") result = coerceMarcusConsult(result);
      const payload = result.warning ? { ...result.data, warning: result.warning } : result.data;
      yield { type: "options", content: payload };
    } else {
      // Degraded: return fallback response
      console.warn("Stream: failed to parse JSON, using fallback. Full text:", fullText.slice(0, 300));
      let fallback: AdvisorResult = {
        data: createFallbackResponse(),
        warning: "参谋回复格式异常，已使用默认方案",
      };
      if (mode === "marcus_consult") fallback = coerceMarcusConsult(fallback);
      yield { type: "options", content: fallback.warning ? { ...fallback.data, warning: fallback.warning } : fallback.data };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("API密钥未配置")) throw err;

    console.error("Stream LLM call failed:", message);
    let fallback: AdvisorResult = {
      data: createFallbackResponse(),
      warning: `参谋通讯中断: ${message.slice(0, 100)}`,
    };
    if (mode === "marcus_consult") fallback = coerceMarcusConsult(fallback);
    yield { type: "options", content: fallback.warning ? { ...fallback.data, warning: fallback.warning } : fallback.data };
  }
}

/**
 * Light call — just get brief + urgency, no full options.
 * Returns null on any error (non-critical).
 */
export async function callLightBrief(
  digest: string,
  channel?: string,
): Promise<LightAdvisorResponse | null> {
  try {
    const prompt = (channel && CHANNEL_PROMPTS[channel]) || LIGHT_SYSTEM_PROMPT;
    const raw = await callDeepSeek(prompt, digest, {
      temperature: 0.5,
      maxTokens: 120,
    });
    const parsed = safeParse(raw);
    return parsed ? validateLightResponse(parsed) : null;
  } catch {
    return null;
  }
}
