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
} from "@ai-commander/shared";
import type {
  AdvisorResponse,
  LightAdvisorResponse,
  Intent,
  IntentType,
} from "@ai-commander/shared";
import { createProvider, getProviderConfig, type LLMProvider, type ChatMessage } from "./providers.js";

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
2. Always return 1-3 options with risk/reward tradeoffs. Engine decides execution mode.
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
          "patrolRadius": 10
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

IMPORTANT:
- You only output intents (intent arrays), never unit_ids or coordinates.
- The engine auto-selects units and paths from intents.
- One option can contain 1-3 intents (e.g. "attack + buy ammo" = 2 intents).
- Each intent dispatches different units; engine prevents double-assignment.

SQUAD SYSTEM:
- Battlefield digest ---SQUADS--- lists squads as: leaderName(squadId,role). Example: Carter(T2,CMD) or Aiden(I1,leader).
- fromSquad accepts EITHER the squad ID (e.g. "I1") OR the leader name (e.g. "Aiden"). The engine resolves both.
- If commander mentions a leader by name (e.g. "Aiden, move to..."), set fromSquad to that leader name. All units under that leader (including sub-squads if CMD) will be dispatched.
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
- Commander can mark custom map points — see ---TAGS---. Match tag names first, then FACILITIES, then FRONTS. Use targetRegion for matched tag id (e.g. "tag_1"). If no match, target doesn't exist → return options:[].`;

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
  const persona = (channel && CHANNEL_PERSONA[channel]) || "";
  const userContent = `${persona ? persona + "\n\n" : ""}当前战场摘要（DigestV1格式）：
${digest}

指挥官风格参数：
${styleNote}

指挥官命令：${playerMessage}`;

  try {
    const raw = await callDeepSeek(SYSTEM_PROMPT, userContent);
    const validated = sanitize(raw);

    if (validated) {
      return normalizeAdvisorForDay7(validated);
    }

    // LLM returned something but not valid JSON → fallback
    console.warn("LLM returned invalid JSON, using fallback. Raw:", raw.slice(0, 200));
    return {
      data: createFallbackResponse(),
      warning: "参谋回复格式异常，已使用默认方案",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // API key errors should propagate
    if (message.includes("API密钥未配置")) {
      throw err;
    }

    console.error("LLM call failed:", message);
    return {
      data: createFallbackResponse(),
      warning: `参谋通讯中断: ${message.slice(0, 100)}`,
    };
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
