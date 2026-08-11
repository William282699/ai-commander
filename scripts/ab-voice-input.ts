// ============================================================
// AI Commander — 语音输入 V1 台架
//
// Modes:
//   --synthetic   确定性断言（不调模型、不起服务器）。默认。
//   --live [N]    真模型：把入库的 wav 直接喂 callAdvisorStream，量 heard 合规
//                 与地名命中。N 默认 20（收口口径）；免费档 ~8 RPM 自带配速。
//                 **要花配额，不进全家扫描**，只在收口与改 prompt 后手动跑。
//
// Run（worktree 根）：
//   npx tsx scripts/ab-voice-input.ts --synthetic
//
// 这支台架的成长线（写在这儿免得后来的人重写）：
//   步 1  通道与入场校验（本文件起点，28 条）
//   步 2  heard 合同：schema 两条 return 路径 + 打字回合零多余（本次 +14）
//   步 2.5 decideBucket：★点名不符负对照 + heard 缺席禁入 bucket A（RED 先行）
//   步 5  --live：真模型 heard 合规 + 地名命中（本次落地）
//
// 家法：判据要测效果不测措辞。会动兵的断言数 assignedUnitIds（步 2.5 起）。
//
// 没有 --negctl 模式是有意的：本刀的负对照**成对写在断言里**（接线臂与摘刀臂
// 并排跑——V1/V2、V4/V5、V8/V9、V10/V11），一次跑完两边的差直接可见。
// 另有几次一次性摘刀（schema 两条 return 路径 / SPEECH_RULE_SITES 登记 /
// decideBucket 的 fail-closed / CONFIRM_WORD_SITES 登记）要改源码才摘得掉，
// 留痕在各步 commit message 里，不做成常驻模式。
// ============================================================

import { readFileSync } from "node:fs";
import { validateAdvisorResponse, createFallbackResponse } from "@ai-commander/shared";
import type { GameState, AdvisorOption, Unit } from "@ai-commander/shared";
import { createInitialGameState, resolveIntent } from "@ai-commander/core";
import type { CommanderRef } from "@ai-commander/core";
import { buildContent, channelAcceptsAudio, voiceEnabledChannels } from "../apps/server/src/providers";
import { rejectCommandBody, MAX_AUDIO_B64 } from "../apps/server/src/voiceInput";
import { withVoiceReinforcement } from "../apps/server/src/ai";
import { canAutoExecute, decideBucket } from "../apps/web/src/autoExecuteGate";
import { planVoiceSpeech } from "../apps/web/src/voiceSpeech";
import { encodeWavBase64 } from "../apps/web/src/voiceRecorder";
import {
  IDLE_CAPTURE, onArmed, onDisarmed, onPress, onRelease, onCancel, onFrame, shouldMute,
} from "../apps/web/src/voiceCaptureState";

const MODE = process.argv[2] ?? "--synthetic";

let bad = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) bad++;
};

// 台架自己不许伪造 .env：能力闸读的是 process.env，跑前钉死一份已知配置，
// 否则"combat 收音频"这条断言会跟着开发机的 .env 漂。
process.env.LLM_PROFILE = "gemini-2.5-flash";
process.env.LLM_PROFILE_OPS = "deepseek";

const ENVELOPE = `⚠️ ENFORCEMENT RULES…

当前战场摘要（DigestV1格式）：
---FRONTS---
1. 北部战线: EnemyEngaged=无

指挥官命令：让北线的部队都撤退`;

// ── ① 拼装：打字回合走到 buildContent 等于没走 ──
// 判据是 identity 不是等值——等值可以靠巧合，同一性不行。
{
  const out = buildContent(ENVELOPE);
  check("N1 无 audio → 返回的就是传进去的那个字符串（identity）", out === ENVELOPE);
  check("N2 无 audio → 不是数组（没被包装成 parts）", typeof out === "string");
  check("N3 显式 undefined 同样走原路", buildContent(ENVELOPE, undefined) === ENVELOPE);

  const parts = buildContent(ENVELOPE, { data: "AAAA", format: "wav" });
  check("N4 有 audio → 两段 parts", Array.isArray(parts) && parts.length === 2);
  if (Array.isArray(parts)) {
    const [t, a] = parts;
    check(
      "N5 ★text part 逐字节等于原信封（信封一字不动是本刀红线）★",
      t.type === "text" && t.text === ENVELOPE,
    );
    check(
      "N6 音频片段形状",
      a.type === "input_audio" && a.input_audio.format === "wav" && a.input_audio.data === "AAAA",
    );
  }
}

// ── ② 能力闸：白名单 ∩ provider==="gemini" ──
{
  check("N7 combat 收音频", channelAcceptsAudio("combat") === true);
  check("N8 logistics 收音频", channelAcceptsAudio("logistics") === true);
  check("N9 ★ops 不收（deepseek 的脑子；换耳朵归 V1.5 转写中继）★", channelAcceptsAudio("ops") === false);
  check(
    "N10 ★group 不收（它的 provider 同样是 gemini，靠白名单挡住——只看 provider 会漏）★",
    channelAcceptsAudio("group") === false,
  );
  check("N11 未知/缺席频道不收", channelAcceptsAudio("nonsense") === false && channelAcceptsAudio(undefined) === false);
  check(
    "N12 health 名单 = [combat, logistics]",
    JSON.stringify(voiceEnabledChannels()) === '["combat","logistics"]',
    JSON.stringify(voiceEnabledChannels()),
  );

  // 配置闸：profile 一换，能力自动收回（防 .env 漂移留下一个假名单）
  process.env.LLM_PROFILE = "deepseek";
  check(
    "N13 ★配置闸★ 默认 profile 换 deepseek → combat/logistics 立刻不收音频",
    channelAcceptsAudio("combat") === false && channelAcceptsAudio("logistics") === false,
  );
  check("N14 ★配置闸★ 同上，health 名单变空", JSON.stringify(voiceEnabledChannels()) === "[]");
  process.env.LLM_PROFILE = "gemini-2.5-flash";
}

// ── ③ 入场校验 400 矩阵 ──
{
  const wav = (n = 100) => ({ data: "A".repeat(n), format: "wav" });
  const R = (audio: unknown, msg: unknown, ch: unknown) => rejectCommandBody(audio, msg, ch);

  check("N15 打字回合（有 message 无 audio）放行", R(undefined, "让北线撤退", "combat") === null);
  check(
    "N16 ★语音回合（message 空串 + 合法 audio）放行——旧的「message 必填」正是挡在这儿★",
    R(wav(), "", "combat") === null,
  );
  check("N17 message 缺席 + 合法 audio 放行", R(wav(), undefined, "combat") === null);
  check("N18 ★两个都没有 → 400（互斥判定，不是「都可空」）★", R(undefined, "", "combat") !== null);
  check("N19 message 只有空白 + 无 audio → 400", R(undefined, "   ", "combat") !== null);
  check("N20 audio 形状不对 → 400", R("not-an-object", "", "combat") !== null);
  check("N21 audio.data 空 → 400", R({ data: "", format: "wav" }, "", "combat") !== null);
  check("N22 非 wav → 400（webm/opus 未测，不许默默放行）", R({ data: "AAAA", format: "webm" }, "", "combat") !== null);
  check("N23 超长 → 400", R(wav(MAX_AUDIO_B64 + 1), "", "combat") !== null);
  check("N24 恰好上限 → 放行（边界不误伤）", R(wav(MAX_AUDIO_B64), "", "combat") === null);
  check("N25 ★audio 送进 ops → 400（不让它走到 fallback 自动执行那一格）★", R(wav(), "", "ops") !== null);
  check("N26 ★audio 送进 group → 400★", R(wav(), "", "group") !== null);
  check("N27 audio 无频道 → 400", R(wav(), "", undefined) !== null);
  check("N28 ★带 message 也带 audio 送进 ops 仍 400（有文本不豁免形状闸）★", R(wav(), "撤退", "ops") !== null);
}

// ── ④ heard 合同：schema 的两条 return 路径 ──
// 这一节就是它自己的负对照：两条路径分开断言，任何一条被人漏掉都会红。
// （地基二的 pendingDecision 当年正是死在"只补了一条路径"上。）
{
  const OPT = { label: "A: 撤", description: "撤", intent: { type: "retreat", urgency: "medium" } };
  const withOptions = (extra: Record<string, unknown>) =>
    validateAdvisorResponse({ brief: "b", options: [OPT], recommended: "A", urgency: 0.5, ...extra });
  const emptyOptions = (extra: Record<string, unknown>) =>
    validateAdvisorResponse({ brief: "b", options: [], responseType: "NOOP", urgency: 0, ...extra });

  check("N29 ★路径一（options 非空）heard 透传★", withOptions({ heard: "让北线的部队都撤退" })?.heard === "让北线的部队都撤退");
  check("N30 ★路径二（options 为空 / NOOP）heard 透传★", emptyOptions({ heard: "北线怎么样" })?.heard === "北线怎么样");
  check("N31 两条路径 heard 缺席 → undefined",
    withOptions({})?.heard === undefined && emptyOptions({})?.heard === undefined);
  check("N32 空串/纯空白按缺席算（不造一个「听到了但没内容」的假在场）",
    withOptions({ heard: "   " })?.heard === undefined && emptyOptions({ heard: "" })?.heard === undefined);
  check("N33 非字符串 heard 被丢弃（白名单重建，不是照抄）",
    withOptions({ heard: 42 })?.heard === undefined && emptyOptions({ heard: { a: 1 } })?.heard === undefined);
  check("N34 heard 去首尾空白但不动中间", withOptions({ heard: "  让 北线 撤  " })?.heard === "让 北线 撤");
  check("N35 heard 不影响别的字段（brief/options/pendingDecision 照旧）", (() => {
    const r = withOptions({ heard: "x", pendingDecision: "authorize" });
    return r?.brief === "b" && r?.options.length === 1 && r?.pendingDecision === "authorize";
  })());

  // P0-1 第三层的地基：兜底回执一定没有 heard，所以语音回合的 fail-closed
  // 判定（步 3）同时罩住"模型漏字段"与"通讯故障走兜底"两种情况。
  check(
    "N36 ★createFallbackResponse() 没有 heard（它是手写字面量、根本不过白名单）★",
    createFallbackResponse().heard === undefined,
  );
  check(
    "N37 ★而它带着可执行 intent——这正是「兜底不能自动执行」的理由，不是空壳★",
    createFallbackResponse().options.length > 0 && !!createFallbackResponse().options[0].intent,
  );

  // ── ④b spoken 合同：同一张白名单上的第二个新字段（spoken 层 步1）──
  // 与 heard 并排写，因为病同源：白名单重建是唯一入口，只补一条 return 路径
  // 的话，NOOP 那一轮的 spoken 会静静消失、客户端悄悄退回念正文——**没有任何
  // 现象**。地基二的 pendingDecision 当年就是这么丢的。
  check("N53 ★路径一（options 非空）spoken 透传★", withOptions({ spoken: "G13那队这就过去。" })?.spoken === "G13那队这就过去。");
  check("N54 ★路径二（options 为空 / NOOP）spoken 透传★", emptyOptions({ spoken: "北线还稳，先不动。" })?.spoken === "北线还稳，先不动。");
  check("N55 两条路径 spoken 缺席 → undefined（缺席即退回念正文的地基）",
    withOptions({})?.spoken === undefined && emptyOptions({})?.spoken === undefined);
  check("N56 空串/纯空白按缺席算（不造一个「有 spoken 但没内容」的假在场——那会念出一片安静）",
    withOptions({ spoken: "   " })?.spoken === undefined && emptyOptions({ spoken: "" })?.spoken === undefined);
  check("N57 非字符串 spoken 被丢弃（白名单重建，不是照抄）",
    withOptions({ spoken: 42 })?.spoken === undefined && emptyOptions({ spoken: ["x"] })?.spoken === undefined);
  check("N58 spoken 与 heard 互不干扰（同一轮两个新字段一起在）", (() => {
    const r = withOptions({ heard: "让G13去中央", spoken: "这就让他们过去。" });
    return r?.heard === "让G13去中央" && r?.spoken === "这就让他们过去。" && r?.brief === "b" && r?.options.length === 1;
  })());
  check(
    "N59 ★createFallbackResponse() 也没有 spoken——「通讯中断」那一格自动落进「缺席→念正文」，不需要单独分支★",
    createFallbackResponse().spoken === undefined,
  );
  // 刀 C 顺手一刀：兜底句不许再指着一个屏上不存在的东西。
  // 判的是**那半句在不在**（结构），不是措辞好不好（那归手感）。
  check(
    "N64 ★兜底句不再说「以下为默认方案」——砍卡法之后这条路一个方案都不展示，那半句是假话★",
    !createFallbackResponse().brief.includes("默认方案"),
    createFallbackResponse().brief,
  );
  check(
    "N65 兜底句仍带可执行 options（它们是 decideBucket 负对照的料，不是给人看的，一个没删）",
    createFallbackResponse().options.length === 3,
  );
}

// ── ⑤ 打字回合零多余：两段语音 prompt 只在带音频那一轮出现 ──
{
  const P = "SYSTEM PROMPT 正文";
  check("N38 ★withVoiceReinforcement(p,false) 返回的就是 p 本身（identity）★", withVoiceReinforcement(P, false) === P);
  const withVoice = withVoiceReinforcement(P, true);
  check("N39 带音频时才追加，且原文在前", withVoice.startsWith(P) && withVoice.length > P.length);
  check("N40 【本次强制】里钉的是 heard 的义务", /【本次强制】/.test(withVoice) && /根级 "heard"/.test(withVoice));
  check("N41 转写不许进正文（理由已改：正文写的是要对长官说的话——分层后正文不再被念，旧理由为假）", /正文里不要复述/.test(withVoice));
  check("N60 ★同一段里还钉了 spoken 的义务（只给耳朵的那一两句）★", /根级 "spoken"/.test(withVoice) && /耳朵听的那一两句/.test(withVoice));
  check("N61 ★spoken 从属正文那条原则在（不许带正文和单子没有的事实）★", /从属于正文/.test(withVoice));
  check(
    "N62 ★旧理由「正文会被念出来给他听」已从合同里撤掉（分层后它是假的，共享面上不许挂假话）★",
    !/正文会被念出来给他听/.test(withVoice),
  );

  // 源码级：VOICE_COMMAND_NOTE 的每一处使用都必须挂在 audio 三元上。
  // 有人哪天把它无条件拼进 userContent，打字回合的信封就变了——那是本刀的红线。
  const aiSrc = readFileSync("apps/server/src/ai.ts", "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  const uses = aiSrc.split("VOICE_COMMAND_NOTE").length - 1;
  const guarded = aiSrc.split('(audio ? VOICE_COMMAND_NOTE : "")').length - 1;
  check(
    "N42 ★VOICE_COMMAND_NOTE 只有声明 + 两处受 audio 保护的使用（callAdvisor / callAdvisorStream）★",
    uses === 3 && guarded === 2,
    `uses=${uses} guarded=${guarded}`,
  );
  check(
    "N43 ★两条命令路都调了 withVoiceReinforcement（一条漏掉＝那条路的 heard 义务没钉）★",
    aiSrc.split("withVoiceReinforcement(").length - 1 === 3, // 1 声明 + 2 调用
  );
  // spoken 的义务只许活在这一个开关后面。有人哪天把它抄进 SYSTEM_PROMPT 或
  // 人格块，打字回合就会开始产 spoken——而打字回合的 TTS 念的是正文，
  // 那一份 spoken 谁也不会听见，只是白烧 token 并把打字信封改了（本刀红线）。
  check(
    "N63 ★spoken 的义务全仓只有一处（在 withVoiceReinforcement 里），没漏进打字回合的信封★",
    aiSrc.split('根级 "spoken"').length - 1 === 1,
    `出现 ${aiSrc.split('根级 "spoken"').length - 1} 次`,
  );
}

// ── ⑥ 自动执行闸：④点名不符 + P0-1 heard 缺席 ──
//
// 判据全部效果级（家法①）：判到 "A" 的那一臂**跑 resolveIntent 数 assignedUnitIds**，
// 看实际动的是谁——不看回执台词，也不只看闸返回的字符串。
// 每条正断言都配一条摘刀：把接线拿掉（不传 heard / 不说这是语音回合），
// 结论必须翻面，否则这条断言测的是同义反复。
{
  const refs: readonly CommanderRef[] = [
    { key: "chen", label: "陈军士" },
    { key: "marcus", label: "马克斯上尉" },
    { key: "emily", label: "艾米莉中尉" },
  ];

  // 两支队：I1「Aiden」4 人在沿海，I2「Blake」3 人在山脊。
  const state = createInitialGameState("el_alamein");
  state.units.clear();
  state.squads = [];
  state.missions = [];
  let tmpl: Unit | null = null;
  createInitialGameState("el_alamein").units.forEach((u) => {
    if (!tmpl && u.team === "player" && u.type === "infantry") tmpl = u;
  });
  if (!tmpl) throw new Error("no player infantry in el_alamein opening");
  let nextId = 9000;
  const spawn = (x: number, y: number): number => {
    const u: Unit = { ...structuredClone(tmpl as Unit), id: nextId++, position: { x, y }, state: "idle", orders: [], waypoints: [] };
    state.units.set(u.id, u);
    return u.id;
  };
  const mkSquad = (id: string, leaderName: string, unitIds: number[]) => {
    state.squads.push({
      id, name: `${leaderName} squad`, unitIds,
      leader: { name: leaderName, rank: "sergeant", personality: "balanced" },
      currentMission: null, missionTarget: null, morale: 1, formationStyle: "line",
      ownerCommander: "chen", leaderName, role: "leader",
    } as unknown as GameState["squads"][number]);
  };
  const aidenIds = [spawn(300, 30), spawn(302, 30), spawn(304, 30), spawn(306, 30)];
  const blakeIds = [spawn(220, 65), spawn(222, 65), spawn(224, 65)];
  mkSquad("I1", "Aiden", aidenIds);
  mkSquad("I2", "Blake", blakeIds);

  const optFrom = (fromSquad: string): AdvisorOption => ({
    label: "A: 增援", description: "增援",
    intent: { type: "defend", fromSquad, toFront: "front_center", urgency: "medium" },
    intents: [{ type: "defend", fromSquad, toFront: "front_center", urgency: "medium" }],
  } as AdvisorOption);

  const bucketOf = (opt: AdvisorOption, text: string, voiceTurn: boolean, heardPresent: boolean) => {
    const gate = canAutoExecute(opt, text, state, [], false, refs);
    return {
      gate,
      bucket: decideBucket({ gate, hasOption: true, staleRefCount: 0, voiceTurn, heardPresent }),
    };
  };
  const movedIds = (opt: AdvisorOption): number[] =>
    resolveIntent(opt.intent, state, state.style).assignedUnitIds;

  // ── ④ 点名不符：长官说 Aiden，模型返回 Blake ──
  const SAID_AIDEN = "Aiden 去中央战线";
  {
    const wired = bucketOf(optFrom("I2"), SAID_AIDEN, true, true);
    check(
      "V1 ★点名不符 + heard 在场 → 问一句（bucket B）★",
      wired.bucket === "B" && wired.gate.reason === "anchor_mismatch" && wired.gate.playerNamedSquad === true,
      `bucket=${wired.bucket} reason=${wired.gate.reason} named=${wired.gate.playerNamedSquad}`,
    );

    // 摘刀：ChatPanel 没把 heard 传进来（= 步 3 的接线缺席 / 被人删掉）
    const cut = bucketOf(optFrom("I2"), "", true, true);
    const spilled = movedIds(optFrom("I2"));
    check(
      "V2 ★摘刀（不传 heard 文本）→ 静默进 A，且实际开动的是长官没点的那支★",
      cut.bucket === "A" && cut.gate.playerNamedSquad === false &&
        spilled.length > 0 && spilled.every((id) => blakeIds.includes(id)),
      `bucket=${cut.bucket} 动了 ${spilled.length} 人，全在 Blake 队=${spilled.every((id) => blakeIds.includes(id))}`,
    );

    // 正对照：点名相符不许被闸拧死（本刀不许把好命令也变成问句）
    const match = bucketOf(optFrom("I1"), SAID_AIDEN, true, true);
    check(
      "V3 ★点名相符 → auto（闸没被拧死）★",
      match.bucket === "auto" && match.gate.auto === true,
      `bucket=${match.bucket}`,
    );
  }

  // ── P0-1：语音回合 heard 缺席 ⇒ 禁入 bucket A ──
  {
    const noAnchor = optFrom("");  // 无 fromSquad ⇒ no_anchor
    noAnchor.intent = { type: "defend", toFront: "front_center", urgency: "medium" };
    noAnchor.intents = [noAnchor.intent];

    const voiceNoHeard = bucketOf(noAnchor, "", true, false);
    check(
      "V4 ★语音回合 + heard 缺席 → 禁入 A，落 B 问一句★",
      voiceNoHeard.bucket === "B" && voiceNoHeard.gate.reason === "no_anchor",
      `bucket=${voiceNoHeard.bucket} reason=${voiceNoHeard.gate.reason}`,
    );

    // 摘刀：把「这是语音回合」这个事实拿掉 = 步 3 的接线没接上
    const cut = bucketOf(noAnchor, "", false, false);
    const moved = movedIds(noAnchor);
    check(
      "V5 ★摘刀（voiceTurn 没接上）→ 掉回 A 自动执行，且真的会动兵★",
      cut.bucket === "A" && moved.length > 0,
      `bucket=${cut.bucket} 会动 ${moved.length} 人`,
    );

    // 零行为变化守卫：打字回合永远没有 heard，绝不能被这条新判定误伤
    check(
      "V6 ★打字回合 no_anchor 仍进 A（新判定不许误伤砍卡法）★",
      bucketOf(noAnchor, "把部队调到中央战线", false, false).bucket === "A",
    );
    check(
      "V7 语音回合 heard 在场时，桶判定与打字回合逐字相同（新判定只在缺席时生效）",
      bucketOf(noAnchor, "把部队调到中央战线", true, true).bucket ===
        bucketOf(noAnchor, "把部队调到中央战线", false, false).bucket,
    );
  }

  // ── 通讯故障那一格：兜底方案带着可执行 intent，且天生没有 heard ──
  {
    const fb = createFallbackResponse().options[0];
    const voice = bucketOf(fb, "", true, false);
    const cut = bucketOf(fb, "", false, false);
    const moved = resolveIntent(fb.intent, state, state.style).assignedUnitIds;
    check(
      "V8 ★语音回合的通讯兜底被同一条判定拦住（不需要单独分支）★",
      voice.bucket === "B",
      `bucket=${voice.bucket}`,
    );
    check(
      "V9 ★摘刀后它会自动执行「A: 稳守阵地」，且真的动兵——这就是 N1 那笔账★",
      cut.bucket === "A" && moved.length > 0,
      `bucket=${cut.bucket} 会动 ${moved.length} 人`,
    );
  }

  // ── 经济单没有豁免（Fable 步2.5 审出的格子）──
  //
  // canAutoExecute 对 produce/trade **直接 continue**（:175）——经济动作没有部队锚，
  // 一条清楚的生产命令不该被锚闸卡住。后果：纯生产/交易单会走到 `auto:true`，
  // 而 decideBucket 的 `gate.auto` 捷径排在 fail-closed 之前 ⇒ 语音回合听不清时
  // **照样自动花钱**。兜底到不了这格（fallback 三条都是 defend/attack/recon，
  // 会被锚闸拦），但真模型语音回合返回纯生产单又漏 heard 时会中。
  // §V-6 对长官的承诺是"没听清就反问"，没有写"经济单除外"。
  {
    const econOpt = (type: "produce" | "trade"): AdvisorOption => ({
      label: "A: 生产", description: "生产",
      intent: { type, urgency: "medium" },
      intents: [{ type, urgency: "medium" }],
    } as unknown as AdvisorOption);

    for (const t of ["produce", "trade"] as const) {
      const gate = canAutoExecute(econOpt(t), "", state, [], false, refs);
      const voice = decideBucket({ gate, hasOption: true, staleRefCount: 0, voiceTurn: true, heardPresent: false });
      const typed = decideBucket({ gate, hasOption: true, staleRefCount: 0, voiceTurn: false, heardPresent: false });
      const heardOk = decideBucket({ gate, hasOption: true, staleRefCount: 0, voiceTurn: true, heardPresent: true });
      check(
        `V10${t === "trade" ? "b" : "a"} ★语音回合 heard 缺席 + 纯 ${t} 单 → 仍是 B（没听清就没有自动出口，经济单不豁免）★`,
        voice === "B",
        `gate.auto=${gate.auto} bucket=${voice}`,
      );
      check(
        `V11${t === "trade" ? "b" : "a"} 零影响守卫：打字回合与「语音+heard 在场」下的 ${t} 单仍走 auto`,
        typed === "auto" && heardOk === "auto",
        `typed=${typed} heardOk=${heardOk}`,
      );
    }
  }
}

// ── ⑥b 听觉序列：一个回合里耳朵到底听见什么（spoken 层 步3）──
//
// 判据是**效果级**的：不看"改没改道"，看三件可听见的事——念的是哪一段文字、
// 流式期间出不出声、回执出不出声。摘刀负对照就在同一组里：把 spoken 拿掉，
// 断言念的当场变回正文（§8-4）。
{
  const PROSE = "东北方向第一未编组群[临时编队G13]17秒可达，建议增援中央战线。";
  const SPOKEN = "让G13那队顶上去，十七秒到。";

  const typed = planVoiceSpeech({ voiceTurn: false, spoken: SPOKEN, prose: PROSE });
  check(
    "S1 ★打字回合逐字等价于分层之前：边流边念正文、回执照旧出声★",
    typed.route === "typed" && typed.speakProseWhileStreaming === true &&
      typed.finalUtterance === "" && typed.speakExecReceipt === true,
    JSON.stringify(typed),
  );
  check(
    "S2 ★打字回合连模型交回了 spoken 都不改道（用户钉死的边界：打字路径零改动）★",
    JSON.stringify(planVoiceSpeech({ voiceTurn: false, spoken: SPOKEN, prose: PROSE })) ===
      JSON.stringify(planVoiceSpeech({ voiceTurn: false, prose: PROSE })),
  );

  const voice = planVoiceSpeech({ voiceTurn: true, spoken: SPOKEN, prose: PROSE });
  check(
    "S3 ★语音回合念的是 spoken，不是正文（正文里的番号/精确秒数留给眼睛）★",
    voice.route === "spoken" && voice.finalUtterance === SPOKEN,
    voice.finalUtterance,
  );
  check(
    "S4 ★语音回合流式期间不出声（正文不进耳朵）★",
    voice.speakProseWhileStreaming === false,
  );
  check(
    "S5 ★R2 定案：spoken 在场 ⇒ 执行回执并进 spoken，不再单独出声（耳朵里只剩 spoken 一声）★",
    voice.speakExecReceipt === false,
    JSON.stringify(voice),
  );

  // ★摘刀负对照（§8-4）：把 spoken 拿掉，别的一个字不动 —— 念的必须当场变回正文。
  const cut = planVoiceSpeech({ voiceTurn: true, prose: PROSE });
  check(
    "S6 ★摘刀：spoken 缺席 → 念的当场变回正文（不是静默哑掉）★",
    cut.route === "prose_fallback" && cut.finalUtterance === PROSE,
    `${cut.route} / ${cut.finalUtterance.slice(0, 12)}…`,
  );
  check(
    "S7 ★而且缺席路整条退回现状：回执照旧出声（这不是第三种堆叠，这是「退回现状」的定义）★",
    cut.speakExecReceipt === true,
  );
  check(
    "S8 空 spoken / 纯空白 spoken 与缺席同路（schema 之外再兜一层，防裸数据调用方）",
    planVoiceSpeech({ voiceTurn: true, spoken: "", prose: PROSE }).route === "prose_fallback" &&
      planVoiceSpeech({ voiceTurn: true, spoken: "   ", prose: PROSE }).route === "prose_fallback",
  );
  check(
    "S9 ★兜底路正文也空 → 一声不出，但回执仍在（与今天「brief 为空」那格逐字同）★",
    (() => {
      const p = planVoiceSpeech({ voiceTurn: true, prose: "   " });
      return p.finalUtterance === "" && p.speakExecReceipt === true;
    })(),
  );
  check(
    "S10 流式期间念不念只取决于「是不是语音回合」——spoken 在不在场都一样（send 时就判得出，不必等 JSON）",
    planVoiceSpeech({ voiceTurn: true, spoken: SPOKEN, prose: PROSE }).speakProseWhileStreaming ===
      planVoiceSpeech({ voiceTurn: true, prose: "" }).speakProseWhileStreaming,
  );

  // 源码级：ChatPanel 那四处出声点必须全部挂在计划上，没有一处裸 speak。
  // （这一条防的是"函数写好了但某一处忘了接"——纯函数全绿而真机照旧念正文。）
  const panelSrc = readFileSync("apps/web/src/ChatPanel.tsx", "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  const streamGuarded = panelSrc.split("ttsEnabled && sendPlan.speakProseWhileStreaming").length - 1;
  check(
    "S11 ★流式两处 speak(正文) 都挂在计划上（一处漏接＝语音回合照旧念正文）★",
    streamGuarded === 2,
    `挂上的有 ${streamGuarded} 处`,
  );
  check(
    "S12 ★执行回执那一处挂在 speakReceipt 上★",
    panelSrc.includes("ttsEnabled && speakReceipt"),
  );
  // ★本地应答音已砍（用户手测判退 2026-08-10）：墨迹 + 承诺早于理解
  //   （长官问「有没有空闲部队」，池子里抽中的是「动手。」——模型还没听懂，
  //   嘴已经答应要动手了）。这条断言守的是"砍掉了就别悄悄回来"。
  check(
    "S13 ★松手瞬间不再有本地应答音——pickVoiceConfirm 全仓只剩 1 声明 + 1 处（执行回执）★",
    panelSrc.split("pickVoiceConfirm(").length - 1 === 2, // 照 N42/N43 先例：声明也计数
    `${panelSrc.split("pickVoiceConfirm(").length - 1} 处（应为 2＝声明+回执）`,
  );
}

// ── ⑥c 采集状态机：常开之后，"不按就不留"这条不变量（刀 C）──
//
// 刀 C 的本体是**时序**（按下那一刻设备已经在收音），时序在浏览器里，node 够不到。
// 够得到的是它背后那条不变量：**没按下 ⇒ 一个样本都不许留**。
// 这条正是"麦克风一直开着"这个决定的全部安全边界——它要是被人改反了，游戏就变成
// 一台常开的录音机。所以它必须被机器咬着。
//
// ★分账（提案 §6，Fable 审定）：这些是**结构断言，不冒充效果断言**。
//   "首词有没有被吃掉"只有真麦判得了；合成假麦连设备开启那一段都没有。
{
  const FRAME = 4096;
  const MAX = 30 * 48000;

  const armed = onArmed(IDLE_CAPTURE);
  check("C1 ★到手即握住，但不自动开录（握住 ≠ 在录，分开这两件事就是本刀全部的意思）★",
    armed.armed === true && armed.collecting === false && armed.frames === 0);

  // ★最要紧的一条：没按下的时候，热图每秒响 21 次，一帧都不许留。
  const idleFrame = onFrame(armed, FRAME, MAX);
  check("C2 ★★没按下 → 帧一律丢弃，且 frames 不涨（常开的全部安全边界就在这一条）★★",
    idleFrame.keep === false && idleFrame.next.frames === 0);
  let drifting = armed;
  for (let i = 0; i < 200; i++) drifting = onFrame(drifting, FRAME, MAX).next;
  check("C3 ★空转 200 帧（约 17 秒）后仍然一个样本没留——不是「第一帧没留」而是「一直没留」★",
    drifting.frames === 0 && drifting.collecting === false);

  const pressed = onPress(armed);
  check("C4 按下 → 进入收集，计数从零起", pressed.collecting === true && pressed.frames === 0);
  const collected = onFrame(pressed, FRAME, MAX);
  check("C5 收集中 → 帧留下且计数累加", collected.keep === true && collected.next.frames === FRAME);

  // ★指示灯不许撒谎的机器落点：没 armed 就按下，状态不许变成 collecting。
  const pressedCold = onPress(IDLE_CAPTURE);
  check("C6 ★没握住设备就按下 → 不进入收集（🔴 因此亮不起来；旧代码正是在这儿先亮灯后开设备）★",
    pressedCold.collecting === false && pressedCold === IDLE_CAPTURE);

  // ★本刀的本体：松手停的是收集，不是设备。
  const released = onRelease(collected.next);
  check("C7 ★★松手 → 停止收集，但 armed 仍为 true（不拆设备 = 下一次按下没有盲区）★★",
    released.collecting === false && released.armed === true);
  const afterRelease = onFrame(released, FRAME, MAX);
  check("C8 松手之后回到「一帧不留」", afterRelease.keep === false && afterRelease.next.frames === released.frames);

  const cancelled = onCancel(collected.next);
  check("C9 放弃这次 → 已收的清零，设备照旧握着",
    cancelled.frames === 0 && cancelled.collecting === false && cancelled.armed === true);

  const disposed = onDisarmed(collected.next);
  check("C10 ★真撒手（卸载/切频道）才 armed=false，且顺带停止收集★",
    disposed.armed === false && disposed.collecting === false && disposed.frames === 0);

  // 封顶语义沿用旧的 MAX_SECONDS，不许因为常开就无限收
  const nearCap = { armed: true, collecting: true, frames: MAX };
  check("C11 到达 30 秒封顶后不再留帧（常开不等于无限录）", onFrame(nearCap, FRAME, MAX).keep === false);

  // 静音闸：不在收集就静音——"根本没东西可留"强过"收到了再扔"
  check("C12 ★不在收集 ⇒ 音轨静音；收集中 ⇒ 放行（隐私保证从「代码有良心」升级成「物理上没有」）★",
    shouldMute(armed) === true && shouldMute(released) === true &&
    shouldMute(cancelled) === true && shouldMute(pressed) === false);

  // 源码级：负对照开关与耗时日志（Fable 附加条件①②）必须真的在
  const recSrc = readFileSync("apps/web/src/voiceRecorder.ts", "utf8");
  check("C13 ★负对照开关在（novoicewarm）——摘刀臂靠它，没有它 §6-5 那条负对照就跑不了★",
    recSrc.includes("novoicewarm") && recSrc.includes("isVoiceWarmEnabled"));
  check("C14 ★设备开启耗时自己记（提案 §4 缺的那个数，长官正常玩就采到）★",
    recSrc.includes("[voice] device open:") && recSrc.includes("cold") && recSrc.includes("gum"));
  const panelSrc2 = readFileSync("apps/web/src/ChatPanel.tsx", "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  check("C15 ★🔴 只跟着真的开始收音走（press() 返回真才亮，不再无条件亮）★",
    panelSrc2.includes('if (arm.press()) setPttStatus("listening")'));
  check("C16 ★松手不 dispose：只有预热关掉的负对照臂才撒手，正路留着设备★",
    panelSrc2.includes("isVoiceWarmEnabled()) { voiceArmRef.current?.dispose()"));
}

// ── ⑥d L6b 新口径：英文 token 的白名单＝本轮信封本身（数据驱动，非词表）──
//
// 判据本体是纯函数 ⇒ 负对照不必花 --live 的配额，在这儿就能摘刀。
{
  const ENV = `---SQUADS---
  I1(Aiden) parent:chen 5units @(258,120) loc=战狼点附近
---FACILITIES---
南线前哨@(280,130) 烽火台@(230,70)
---TAGS---
战狼点=(260,125)`;

  check("F1 纯中文 spoken → 无违规", foreignTokensNotInEnvelope("战狼点那队顶上去，十七秒到。", ENV).length === 0);
  check(
    "F2 ★信封里有的专名（Aiden / I1）念出来不算错——信封没给中文代称，这一格归引擎侧另一刀★",
    foreignTokensNotInEnvelope("Aiden 那队去南线前哨，I1 留守。", ENV).length === 0,
  );
  check(
    "F3 ★★摘刀负对照：信封查无的英文（El Alamein）出现在 spoken 里 → 判红★★",
    JSON.stringify(foreignTokensNotInEnvelope("两个步兵去 El Alamein，剩下的守烽火台。", ENV)) === '["El","Alamein"]',
    JSON.stringify(foreignTokensNotInEnvelope("两个步兵去 El Alamein，剩下的守烽火台。", ENV)),
  );
  check(
    "F4 大小写不影响归属判定（信封里写 Aiden，spoken 写 AIDEN 仍算信封内）",
    foreignTokensNotInEnvelope("AIDEN 那队顶上去。", ENV).length === 0,
  );
  check(
    "F5 ★新旧口径确实不同：旧口径「一个字母都不许有」会把 F2 判红，新口径不会★",
    /[A-Za-z]/.test("Aiden 那队去南线前哨，I1 留守。") &&
      foreignTokensNotInEnvelope("Aiden 那队去南线前哨，I1 留守。", ENV).length === 0,
  );
}

// ── ⑦ WAV 封装：采集链上唯一一段纯计算，也是最难在真机上看出错的一段 ──
// 头写错了服务端不会报错、模型也不会抱怨，只会"听不清"——这种错必须由台架抓。
{
  const n = 400;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.sin((i / 16000) * 2 * Math.PI * 440);
  pcm[0] = 0; pcm[1] = 1; pcm[2] = -1; pcm[3] = 2; pcm[4] = -2; // 含越界值，测钳制

  const b64 = encodeWavBase64(pcm, 16000);
  const buf = Buffer.from(b64, "base64");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number, len: number) => buf.subarray(o, o + len).toString("latin1");

  check("N44 长度 = 44 字节头 + 每样本 2 字节", buf.length === 44 + n * 2, `${buf.length}`);
  check("N45 RIFF/WAVE/fmt /data 四个块标", tag(0, 4) === "RIFF" && tag(8, 8) === "WAVEfmt " && tag(36, 4) === "data");
  check("N46 PCM 单声道 16bit", dv.getUint16(20, true) === 1 && dv.getUint16(22, true) === 1 && dv.getUint16(34, true) === 16);
  check("N47 ★采样率写的是 16000（服务端 4mb 上限就押在这个数上）★", dv.getUint32(24, true) === 16000);
  check("N48 byteRate/blockAlign 与格式自洽", dv.getUint32(28, true) === 16000 * 2 && dv.getUint16(32, true) === 2);
  check("N49 RIFF size = 36 + 数据字节数；data size = 数据字节数",
    dv.getUint32(4, true) === 36 + n * 2 && dv.getUint32(40, true) === n * 2);
  check("N50 ★越界样本被钳到端点，不是回绕成反号★",
    dv.getInt16(44 + 1 * 2, true) === 0x7fff && dv.getInt16(44 + 2 * 2, true) === -0x8000 &&
    dv.getInt16(44 + 3 * 2, true) === 0x7fff && dv.getInt16(44 + 4 * 2, true) === -0x8000,
    `[${dv.getInt16(46, true)}, ${dv.getInt16(48, true)}, ${dv.getInt16(50, true)}, ${dv.getInt16(52, true)}]`);
  check("N51 静音样本写 0", dv.getInt16(44, true) === 0);
  // 分块 base64（1MB 一次性展开会爆栈）：拿一段够长的样本走一遍那条分支
  const big = encodeWavBase64(new Float32Array(0x8000 * 2 + 123), 16000);
  check("N52 大缓冲走分块 base64 分支，长度仍自洽",
    Buffer.from(big, "base64").length === 44 + (0x8000 * 2 + 123) * 2);
}

if (MODE === "--live") {
  void runLive(Number(process.argv[3] ?? 20));
} else {
  console.log(bad === 0 ? "\nALL SYNTHETIC PASS" : `\n${bad} 条不过`);
  process.exit(bad === 0 ? 0 : 1);
}

// ============================================================
// --live：真模型。把**入库的那两段 wav** 直接喂进生产的 callAdvisorStream，
// 量三件事——heard 在不在、有没有被复读进正文、地名有没有听对。
//
// ★夹具先自证（Fable 2026-08-09 立规，起因是步 3 冒烟那组作废的假对照）：
//   开跑之前先证明夹具自己没问题——sha256 钉死 + WAV 头断言（16kHz/单声道/16bit）。
//   任何人在中间悄悄重编码过，这一步就红，后面的 heard 数字一个字都不许用。
// ============================================================

// ── 净臂 / 脏臂（分臂重组 2026-08-09）──
//
// 为什么分臂：Fable 的实验已经证伪了"复读跟信封走"（真信封 N=8 复读 0/8），
// 剩下的假设是**复读与归一化都跟输入质量走**。一个混着好样本和坏样本的
// 平均数说不清任何事——20 条里 3 条复读，是"偶发"还是"坏输入必中"？分臂之后
// 这个问句才有答案。
//
//   净臂：cmd1.wav —— 完整、清楚、每个地名都真的在音频里
//   脏臂：cmd2.wav（中文里夹一个英文地名）
//         cmd1_cut600.wav（机器切尾 600ms 语音——用户手测那个病的复制品）
//
// 脏臂的价值在**基准真值由构造保证**：cmd1_cut600 的音频里物理上不存在「前哨」
// 那两个音，而信封的 ---FACILITIES--- 里明明白白写着「南线前哨」。heard 里出现
// 「前哨」＝模型拿信封里现成的名字补了它没听见的音——这正是 A-1 要治的那笔账
// （手测「骂人→中央战线」是同一个机制的另一个方向）。
/**
 * spoken 里出现的英文 token，哪些在本轮信封文本里查无此名。
 *
 * ★白名单是**信封本身**，不是我写的词表——这是红线二那条"数据驱动可以、
 * 同义词表不行"的同一形状（保守案的实体名清单先例）。
 * 判的是**编造**不是**语种**：信封里有 `I1(Aiden)` ⇒ 念 Aiden 是没办法
 * （信封没给中文代称，那一格归引擎侧另一刀）；信封里没有 El Alamein
 * ⇒ 它出现在 spoken 里就是模型自己塞进耳朵的洋文。
 *
 * 函数声明而非 const：上面的 --synthetic 段先执行，要靠提升拿到它。
 */
function foreignTokensNotInEnvelope(spoken: string, envelope: string): string[] {
  const tokens = spoken.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? [];
  const hay = envelope.toLowerCase();
  return [...new Set(tokens)].filter((t) => !hay.includes(t.toLowerCase()));
}

interface LiveFixture {
  file: string;
  sha256: string;
  /** 净臂＝clean，脏臂＝dirty */
  arm: "clean" | "dirty";
  /** 原句（人念的那一句），只作记录 */
  spoken: string;
  /** 判据：这些词必须出现在 heard 里 */
  mustHear: string[];
  /** 归一化标记：这些词出现在 heard 里＝模型补了音频里没有的东西。
   *  只有基准真值靠构造保证的夹具才配有这一栏。 */
  inventedIf?: string[];
  /** 由 cmd1.wav 截断而来 ⇒ --live 现场重算、断言它是原始样本的逐字节前缀 */
  cutFrom?: { file: string; cutMs: number };
}

const LIVE_FIXTURES: LiveFixture[] = [
  {
    file: "scripts/fixtures/voice/cmd1.wav",
    sha256: "0d69ae3688c68c22a6a1f0bd412f0c992a0446b17b6a461a43f7d5a8b16f7b90",
    arm: "clean",
    spoken: "战狼点附近的闲置部队，去增援南线前哨",
    // 战狼点＝玩家自造标记名，只活在信封的 ---TAGS--- 里：本刀红利的最短证明
    mustHear: ["战狼点", "南线前哨"],
  },
  {
    file: "scripts/fixtures/voice/cmd2.wav",
    sha256: "7adc8a240b7633ac2146782fd0f1ba699d31c9bfd3a002eb1f8fd5d2fc3ca906",
    arm: "dirty",
    spoken: "派两个步兵班去 El Alamein，剩下的守住烽火台",
    // 只钉「烽火台」：El Alamein 这一段是已登记的脏样本（I2 账根），不设硬线
    mustHear: ["烽火台"],
    // 原句里没有"前哨"两个字。heard 里冒出来 ⇒ 英文地名被换成了信封里的名字
    // （首跑实测：10 条 cmd2 里 4 条把 El Alamein 说成「北线前哨」）。
    inventedIf: ["前哨"],
  },
  {
    file: "scripts/fixtures/voice/cmd1_cut600.wav",
    sha256: "e90956061103d7abb26e0df7abf52443922b537ba53687086b8b54d24932f7d8",
    arm: "dirty",
    spoken: "战狼点附近的闲置部队，去增援南…（尾部 600ms 语音被机器切掉）",
    // 「战狼点」在保留的那一段里，仍是硬要求；"前哨"已被切掉，不能要求听到
    mustHear: ["战狼点"],
    inventedIf: ["前哨"],
    cutFrom: { file: "scripts/fixtures/voice/cmd1.wav", cutMs: 600 },
  },
];

const LIVE_DIGEST = `---FRONTS---
1. 北部战线: EnemyEngaged=无 EnemyMassing=3辆重甲+8步兵 power=1200
4. 南部战线: EnemyEngaged=4辆重甲+1步兵 EnemyMassing=无 power=400
---SQUADS--- (loc= 是唯一已证位置，缺席=未证；目的地≠位置)
  I1(Aiden) parent:chen 5units(4×infantry,1×light_tank) @(258,120) morale=0.9 mission=idle task=无任务 hp=100% loc=战狼点附近
---FACILITIES---
南线前哨@(280,130) 北线前哨@(250,40) 烽火台@(230,70) 我军总部@(420,80)
---TAGS---
战狼点=(260,125)`;

async function runLive(n: number): Promise<void> {
  const { createHash } = await import("node:crypto");
  const { config } = await import("dotenv");
  config({ path: "apps/server/.env" });
  const { callAdvisorStream } = await import("../apps/server/src/ai");

  console.log(`\n== --live N=${n}（免费档 ~8 RPM，自带配速）==\n`);

  // ── 夹具自证：字节没被人动过，格式就是我们以为的那个 ──
  // 切法与自证共用同一份代码：台架现场重算切点，与生成脚本用的是同一个函数，
  // 所以"生成时这么切、验收时那么算"这种漂移在结构上不可能发生。
  const { readWav, rmsWindows, speechEndSample, cutPointSample } = await import("./make-voice-cut-fixture");
  for (const f of LIVE_FIXTURES) {
    const bytes = readFileSync(f.file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const w = readWav(f.file);
    check(`L0 夹具自证 ${f.file} sha256 与入库一致`, sha === f.sha256, sha.slice(0, 16));
    check(`L0 夹具自证 ${f.file} 是 16kHz / 单声道 / 16bit`,
      w.rate === 16000 && w.channels === 1 && w.bits === 16,
      `${w.rate}Hz ch=${w.channels} bits=${w.bits}`);

    // ★截断夹具的自证比 sha 更重一层：sha 只证"没人动过这个文件"，
    //   证不了"这个文件确实是那段原始音频的纯截断"。所以现场拿原件重算：
    //   ① 保留的每一个样本与原件逐字节相同（纯截断，没重编码、没重采样）
    //   ② 切点就是脚本算出来的那个（切法可复现，不是某次会话里手切的）
    //   ③ 被切掉的那 600ms 是**语音**不是尾部静音——否则这个夹具什么都证明不了
    //      （cmd1 尾部有 0.513s 数字静音，直接砍 600ms 只砍掉 87ms 语音）
    if (f.cutFrom) {
      const src = readWav(f.cutFrom.file);
      const keep = cutPointSample(src.samples, src.rate);
      let identical = w.samples.length === keep;
      if (identical) {
        for (let i = 0; i < keep; i++) {
          if (w.samples[i] !== src.samples[i]) { identical = false; break; }
        }
      }
      check(`L0 ★截断自证 ${f.file} 是 ${f.cutFrom.file} 的逐样本前缀（纯截断，没重编码）★`,
        identical, `保留 ${w.samples.length} / 应为 ${keep}`);
      const end = speechEndSample(src.samples, src.rate);
      const removed = src.samples.subarray(keep, end);
      const removedPeak = removed.length > 0 ? Math.max(...rmsWindows(removed, src.rate)) : 0;
      const wholePeak = Math.max(...rmsWindows(src.samples, src.rate));
      check(`L0 ★截断自证 被切掉的 ${(removed.length / src.rate).toFixed(2)}s 是语音不是静音（峰值 RMS ${removedPeak.toFixed(0)} vs 全曲 ${wholePeak.toFixed(0)}）★`,
        removed.length > 0 && removedPeak > wholePeak * 0.2,
        `切掉 ${(removed.length / src.rate).toFixed(3)}s`);
    }
  }
  if (bad > 0) {
    console.log("\n★夹具没过自证——后面的 heard 数字一个字都不许用。停。");
    process.exit(1);
  }

  const rows: { fx: string; arm: "clean" | "dirty"; invented: string[]; heard: string; spoken: string; prose: string; ok: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const fx = LIVE_FIXTURES[i % LIVE_FIXTURES.length];
    const audio = { data: readFileSync(fx.file).toString("base64"), format: "wav" as const };
    let prose = "";
    let heard = "";
    let spoken = "";
    try {
      for await (const ev of callAdvisorStream(LIVE_DIGEST, "", "risk=0.50 focus=0.50 obj=0.50 cas=0.50", "combat", audio)) {
        if (ev.type === "text") prose += ev.content;
        else if (ev.type === "options") {
          heard = typeof ev.content?.heard === "string" ? ev.content.heard : "";
          spoken = typeof ev.content?.spoken === "string" ? ev.content.spoken : "";
        }
      }
    } catch (e) {
      console.log(`  #${i} 调用失败: ${String(e).slice(0, 80)}`);
    }
    const hit = fx.mustHear.filter((w) => heard.includes(w));
    // 归一化命中：音频里物理上没有的词出现在 heard 里（基准真值靠构造保证）
    const invented = (fx.inventedIf ?? []).filter((w) => heard.includes(w));
    rows.push({
      fx: fx.file.split("/").pop() ?? fx.file, arm: fx.arm, invented,
      heard, spoken, prose, ok: hit.length === fx.mustHear.length,
    });
    console.log(`  #${String(i).padStart(2)} ${(fx.file.split("/").pop() ?? "").padEnd(16)} [${fx.arm === "clean" ? "净" : "脏"}] 地名 ${hit.length}/${fx.mustHear.length}${invented.length ? `  ★归一化「${invented.join("/")}」` : ""}`);
    console.log(`      heard =${heard || "(缺席)"}`);
    console.log(`      spoken=${spoken || "(缺席)"}`);
    // 正文也印出来：L2 记录行、R1「从属正文」这两笔都得拿正文对着看才判得了，
    // 而这数据每跑一次要花一次配额——不留下来等于白跑。
    console.log(`      prose =${prose.trim().replace(/\n/g, "⏎").slice(0, 90) || "(空)"}`);
    if (i < n - 1) await new Promise((r) => setTimeout(r, 8000)); // 免费档配速
  }

  // ── 判据 ──
  //
  // ★R5 义务稀释防线：spoken 上线后【本次强制】从一个义务变两个，老义务可能
  //   被新义务挤掉。所以 L1（heard 在场）与 L4（spoken 在场）**必须同跑同看**，
  //   且 L1 跌破即停——不许为了新字段牺牲老字段。
  const present = rows.filter((r) => r.heard.length > 0).length;
  const l1Ok = present >= Math.ceil(n * 0.95);
  check(`L1 ★heard 在场 ${present}/${n}（收口线 ≥19/20，即 ≥95%）★`, l1Ok, `${present}/${n}`);
  if (!l1Ok) {
    console.log("   ↳ ★R5 停线：新义务把老义务挤掉了。spoken 层不许在 L1 跌破的状态下往下走。");
  }

  // ★R3 判据归宿（T1j 式登记，2026-08-09）：
  //   L2「正文含 heard」从**硬线降级为记录行**——分层之后语音回合的 TTS 不再念
  //   正文，复读即使发生也**听不见**，只剩"屏上难看"。降级不是放弃：它照旧每跑
  //   必算、红了打印全文，只是不再 FAIL。
  //   接任的新硬线是 L7（spoken 不含 heard 整句）——那一格才真的会被念出来。
  //   ⚠ 这是一条**有意的判据松动**，不是漏网：写在这里而不是只写在 commit 里，
  //     因为下一个看见 L2 印红却全绿的人，得在同一屏上读到理由。
  const polluted = rows.filter((r) => r.heard.length > 4 && r.prose.includes(r.heard));
  const clean = rows.filter((r) => r.arm === "clean");
  const dirty = rows.filter((r) => r.arm === "dirty");
  const pollutedIn = (rs: typeof rows) => rs.filter((r) => r.heard.length > 4 && r.prose.includes(r.heard)).length;
  console.log(`记录行 L2（不 FAIL）转写复读进正文 ${polluted.length}/${n}——分层后耳朵听不见它，只剩屏上难看`);
  console.log(`   ↳ 分臂：净臂 ${pollutedIn(clean)}/${clean.length}   脏臂 ${pollutedIn(dirty)}/${dirty.length}` +
    `   ← 假设「复读跟输入质量走、不跟信封走」在这两个数上见分晓`);
  for (const p of polluted) {
    console.log(`   ↳ [${p.fx}] heard: ${p.heard}`);
    console.log(`   ↳ [${p.fx}] prose: ${p.prose.replace(/\n/g, "⏎")}`);
  }

  // ── 记录行：归一化（A-1 的量尺；本轮是**修前基线**）──
  // 判的是"音频里物理上没有的词，heard 里有没有"——基准真值由夹具构造保证，
  // 不靠我判断模型听得对不对。先记不设线：A-1 只有一轮止损，得先有基线。
  const invRows = rows.filter((r) => r.invented.length > 0);
  const byFixture = new Map<string, { n: number; hit: number }>();
  for (const r of rows) {
    if (!LIVE_FIXTURES.find((f) => f.file.endsWith(r.fx))?.inventedIf) continue;
    const e = byFixture.get(r.fx) ?? { n: 0, hit: 0 };
    e.n++; if (r.invented.length > 0) e.hit++;
    byFixture.set(r.fx, e);
  }
  console.log(`记录行 归一化（拿信封里的名字补没听见的音）${invRows.length}/${dirty.length} 条脏样本`);
  for (const [fx, e] of byFixture) console.log(`   ↳ ${fx}: ${e.hit}/${e.n}`);
  for (const r of invRows.slice(0, 4)) console.log(`   ↳ 「${r.invented.join("/")}」← ${r.heard}`);

  // 地名命中：本刀存在的理由。不设百分比硬线以外的花样，逐条可读。
  const nameOk = rows.filter((r) => r.ok).length;
  check(`L3 ★地名命中 ${nameOk}/${n}——「战狼点」这种只活在信封里的名字听不出来，这一刀就白做★`,
    nameOk >= Math.ceil(n * 0.9), `${nameOk}/${n}`);

  // ── spoken 层四条判据（§8）──
  // 判据 4「缺席退回念正文」不在这儿：它是**客户端**行为，落在 --synthetic 的
  // S6/S7（planVoiceSpeech 摘刀）+ 步3 浏览器冒烟臂2。这里只判模型这一侧。
  const SPOKEN_MAX_CHARS = 60;
  const spokenRows = rows.filter((r) => r.spoken.length > 0);
  check(`L4 ★spoken 在场 ${spokenRows.length}/${n}（收口线 ≥19/20）——缺席就退回念正文，能跑但这一层等于没上★`,
    spokenRows.length >= Math.ceil(n * 0.95), `${spokenRows.length}/${n}`);

  // 长度：防它长成"正文的复制"。判的是字数这个结构量，不是措辞。
  const tooLong = spokenRows.filter((r) => r.spoken.length > SPOKEN_MAX_CHARS);
  check(`L5 ★spoken 都在 ${SPOKEN_MAX_CHARS} 字以内（一两句；超了就是把正文抄了一遍）★`,
    tooLong.length === 0, tooLong.length ? `${tooLong.length} 条超长` : "");
  for (const t of tooLong) console.log(`   ↳ ${t.spoken.length}字: ${t.spoken}`);

  // 三条结构硬线（§8-3，审定核准：正则可判的**结构**特征，不是措辞词表）。
  //   · G\d+     番号是给眼睛的地址，念出来是噪音
  //   · ASCII 字母 中文 TTS 念 Aiden/Blake 本就别扭（用户手测原话）
  //   · heard 整句 ★R3 的新硬线：L2 降级后，"把长官的话念回给他"这件事
  //                 只可能从这一格发生——它是唯一会被念出来的那段文字
  const withHandle = spokenRows.filter((r) => /G\d+/.test(r.spoken));
  check(`L6a ★spoken 不含番号 G\\d+（番号留给眼睛）★`, withHandle.length === 0,
    withHandle.length ? withHandle[0].spoken : "");
  // ★T1j 判据变更登记（2026-08-10，Fable 裁定）：L6b 从「spoken 一个英文字母都不许有」
  //   改为「spoken 里的英文 token **必须出现在本轮信封文本里**」。
  //
  //   为什么改：旧口径实测 18/20 → 17/21 红着不动，而**根因不在措辞**——信封里那支
  //   部队的唯一身份就是 `I1(Aiden)`，中文名不存在，模型要提它没有第二条路。
  //   对照证据：同一批里 El Alamein 被译成了「阿拉曼」⇒ **能译的它译了，译不了的
  //   它照念**。拿一条模型无法满足的硬线红着，只会训练人忽略红色。
  //
  //   新口径判的是**编造**而不是**语种**：信封里有的专名（Aiden/I1）念出来是没办法，
  //   engine 给中文代称是另一级的活（已进 LEDGER）；信封里没有的英文（El Alamein
  //   在本轮信封里查无此名）出现在 spoken 里，那就是模型自己塞进耳朵的洋文，照旧红。
  //   白名单是**本轮信封文本本身**——数据驱动，不是我写的词表（红线二）。
  const foreignBad = spokenRows
    .map((r) => ({ r, bad: foreignTokensNotInEnvelope(r.spoken, LIVE_DIGEST) }))
    .filter((x) => x.bad.length > 0);
  check(`L6b ★spoken 里的英文 token 必须来自本轮信封（编造的洋文才算错，信封里有的专名不算）★`,
    foreignBad.length === 0, foreignBad.length ? `${foreignBad.length} 条` : "");
  for (const x of foreignBad) console.log(`   ↳ 信封查无「${x.bad.join("/")}」← ${x.r.spoken}`);
  // 记录行：信封里有的英文专名念了多少次——engine 给中文代称那一级的账，量着不判
  const envForeign = spokenRows.filter((r) => /[A-Za-z]/.test(r.spoken)).length;
  console.log(`记录行 spoken 含英文（含信封内专名如 Aiden/I1）${envForeign}/${spokenRows.length}——` +
    `信封里没有中文代称，这一格归引擎侧另一刀，不由 prompt 背`);
  const echoed = spokenRows.filter((r) => r.heard.length > 4 && r.spoken.includes(r.heard));
  check(`L7 ★spoken 不含 heard 整句（接任 L2 的新硬线：这一格是唯一还会被念出来的文字）★`,
    echoed.length === 0, echoed.length ? `${echoed.length} 条` : "");
  for (const e of echoed) {
    console.log(`   ↳ heard : ${e.heard}`);
    console.log(`   ↳ spoken: ${e.spoken}`);
  }

  // 记录行（不 FAIL）：合同里"不念小数位"那条与 spoken/正文的长度比。
  // 不设硬线是有意的——§8 核准的硬线就三条，判据不许自己长胖。
  const withDecimal = spokenRows.filter((r) => /\d+\.\d+/.test(r.spoken)).length;
  const ratio = spokenRows.length
    ? (spokenRows.reduce((a, r) => a + r.spoken.length / Math.max(1, r.prose.trim().length), 0) / spokenRows.length)
    : 0;
  console.log(`记录行 spoken 含小数 ${withDecimal}/${spokenRows.length}；spoken/正文 平均长度比 ${ratio.toFixed(2)}`);

  // ── 记录行：R1「从属正文」的可判子集 ──
  // R1 整条（不得携带正文与单子没有的事实）机器判不了；但它的**数量声明**那一
  // 半判得了：spoken 里说"五分钟内到位"而正文里没有这个数，就是嘴替账本发明了
  // 一个数。抽的是"数词+单位"这个结构，不是同义词表（同 /G\d+/、问号校验一族）。
  // 首跑（2026-08-09 N=20）没有这一行，那一跑里 5/20 条 spoken 出现"预计五分钟
  // 内到位"而无从对账——正是这条记录行被加出来的原因。**先记不设线**：n 小，
  // 且要先分清"正文也这么说"与"spoken 自己发明的"。
  const QTY = /(?:\d+|[零一二三四五六七八九十两百千半]+)\s*(?:分钟|秒|小时|个|支|辆|人|名|公里|米|%)/g;
  let inventedRows = 0;
  const inventedSamples: string[] = [];
  for (const r of spokenRows) {
    const inSpoken = r.spoken.match(QTY) ?? [];
    const proseText = r.prose;
    const missing = inSpoken.filter((q) => !proseText.includes(q));
    if (missing.length > 0) {
      inventedRows++;
      if (inventedSamples.length < 3) inventedSamples.push(`${missing.join("/")} ← ${r.spoken}`);
    }
  }
  console.log(`记录行 R1 数量声明：${inventedRows}/${spokenRows.length} 条 spoken 说了正文里没有的数`);
  for (const s of inventedSamples) console.log(`   ↳ ${s}`);

  console.log(bad === 0 ? "\nALL LIVE PASS" : `\n${bad} 条不过`);
  process.exit(bad === 0 ? 0 : 1);
}
