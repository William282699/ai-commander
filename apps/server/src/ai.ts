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

const SYSTEM_PROMPT = `你是一名现代战争军事参谋，代号"铁幕"。你为指挥官（玩家）服务。

你的职责：
1. 理解指挥官的自然语言指令，翻译为精确的战场意图
2. 永远输出三个方案（A/B/C），标注风险/收益/推荐
3. 在紧急情况下请求接管特定战线
4. 根据指挥官的风格参数调整方案偏向

你必须以JSON格式回复：
{
  "brief": "一句话战况摘要，军事电报风格",
  "options": [
    {
      "label": "A: 方案名",
      "description": "30字内说明",
      "risk": 0.0-1.0,
      "reward": 0.0-1.0,
      "intents": [
        {
          "type": "${DAY7_SUPPORTED_INTENT_TYPES.join("|")}",
          "fromSquad": "分队编号如T5、I3(可选，优先于fromFront)",
          "fromFront": "战线名(可选)",
          "toFront": "战线名(可选)",
          "targetFacility": "设施ID(可选)",
          "targetRegion": "区域ID(可选)",
          "unitType": "armor|infantry|air|naval(可选)",
          "quantity": "all|most|some|few|具体数字",
          "urgency": "low|medium|high|critical",
          "minimizeLosses": true/false,
          "airCover": true/false,
          "stealth": true/false,
          "produceType": "infantry|light_tank|main_tank|artillery|patrol_boat|destroyer|cruiser|carrier|fighter|bomber|recon_plane(仅type=produce时必填)",
          "tradeAction": "buy_fuel|buy_ammo|buy_intel|sell_fuel|sell_ammo(仅type=trade时必填)",
          "patrolRadius": 10
        }
      ]

注意：patrolRadius 用于 type=patrol，控制巡逻范围。小=5, 中=10, 大=15。不填默认10。
    }
  ],
  "recommended": "A/B/C",
  "urgency": 0.0-1.0
}

重要：
- 你只输出intents（意图数组），不要输出具体的unit_ids或坐标。
- 系统会根据intents自动选择合适的单位和路径。
- 一个方案可以包含1-3个intent（例如"进攻+购买弹药"就是2个intent）。
- 每个intent会分配不同的单位，系统自动避免重复分配。

分队系统：
- 战场摘要---SQUADS---段列出了当前所有分队的编号、兵种、位置。
- 如果指挥官提到某支分队（如"T5"、"坦克分队"），在intent中用fromSquad填写分队编号。fromSquad优先于fromFront。
- 当填写了fromSquad时，不要自动填unitType。分队已经定义了精确的单位集合，系统会调度分队内全部单位。只有当指挥官明确区分分队内的兵种时（如"T1的步兵突击，坦克掩护"），才在各intent中分别填写unitType来拆分。
- 如果指挥官说"圈起来的"或"选中的"单位，不需要填fromSquad或fromFront，系统会自动约束到---PLAYER_SELECTED---中列出的单位。
- 如果不需要指定分队，直接省略fromSquad字段，不要填"none"或"null"。

任务系统(Missions)：
- 战场摘要---MISSIONS---段列出了当前活跃的任务及其进度。
- type=sabotage时必须填targetFacility（要破坏的设施ID），系统会自动创建跟踪任务。
- 任务进度由引擎自动更新：破坏=设施受损比例，歼灭=区域敌军清除比例，夺取=设施占领进度，防守=坚守时长比例。
- 如果某分队已有任务在执行（mission≠idle），除非指挥官明确要求变更，否则不要给该分队下达新的不同命令。

规则：
- 回复简短干脆，像军事通讯
- 你只知道已侦察到的信息，未侦察区域你也不确定
- 如果指挥官命令有风险，简要提醒但仍执行
- 如果指挥官命令中的目标地点、目标对象明显不存在于地图上（如虚构地名、外太空、火星等），或引用了不存在的分队/设施编号，不要生成任何方案。直接返回 brief 说明原因（如"目标不存在"），options 留空数组 []，urgency 设 0。
- urgency: 0=日常, 0.5=需关注, 0.8=紧急, 1.0=即将崩溃
- 根据风格参数调整推荐：高risk→推荐激进方案，高casualty_aversion→推荐保守方案
- 当指挥官提到具体建筑或设施（如"基地"、"HQ"、"油库"、"修理站"等任何建筑别名），优先在intent里用targetFacility填写战场摘要---FACILITIES---段中对应的设施ID
- 可用的设施ID和类型见摘要中的---FACILITIES---段。如果无法匹配到具体设施，退回使用targetRegion或toFront，并在description中标注不确定
- 指挥官可在地图上标记自定义地点，见摘要 ---TAGS--- 段。当指挥官命令引用地点名称时，优先匹配 TAGS，其次 FACILITIES，最后 FRONTS。在intent中用 targetRegion 填写匹配到的 tag id（如 "tag_1"）。如果都匹配不到，说明该目标不存在，返回 options: [] 并在 brief 中说明。`;

const LIGHT_SYSTEM_PROMPT =
  '你是军事参谋。根据战场摘要，给出一句话简报和紧急度评分。只返回JSON: {"brief": "...", "urgency": 0.0-1.0}';

// ── Day 16B: Channel-specific light brief prompts ──

const CHANNEL_PROMPTS: Record<string, string> = {
  ops: '你是军事参谋（作战频道）。根据战场摘要，给出一句话作战态势简报（关注战线、任务进度、兵力部署）和紧急度评分。只返回JSON: {"brief": "...", "urgency": 0.0-1.0}',
  logistics: '你是军事参谋（后勤频道）。根据战场摘要，给出一句话后勤状况简报（关注燃油、弹药、资金、生产队列、补给）和紧急度评分。只返回JSON: {"brief": "...", "urgency": 0.0-1.0}',
  combat: '你是军事参谋（战斗频道）。根据战场摘要，给出一句话战斗形势简报（关注交火、伤亡、敌方威胁、危险区域）和紧急度评分。只返回JSON: {"brief": "...", "urgency": 0.0-1.0}',
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
    temperature: options?.temperature ?? 0.7,
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
export async function callAdvisor(
  digest: string,
  playerMessage: string,
  styleNote: string,
): Promise<AdvisorResult> {
  const userContent = `当前战场摘要（DigestV1格式）：
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
      maxTokens: 100,
    });
    const parsed = safeParse(raw);
    return parsed ? validateLightResponse(parsed) : null;
  } catch {
    return null;
  }
}
