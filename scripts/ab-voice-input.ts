// ============================================================
// AI Commander — 语音输入 V1 台架
//
// Modes:
//   --synthetic  确定性断言（不调模型、不起服务器）。默认。
//   --negctl     PRE-FIX 期望：★ 断言在摘刀后必须真 FAIL（家法⑤）。
//                步 2 尚无可摘的刀，本模式在步 2.5 随 decideBucket 一起长出来。
//
// Run（worktree 根）：
//   npx tsx scripts/ab-voice-input.ts --synthetic
//
// 这支台架的成长线（写在这儿免得后来的人重写）：
//   步 1  通道与入场校验（本文件起点，28 条）
//   步 2  heard 合同：schema 两条 return 路径 + 打字回合零多余（本次 +14）
//   步 2.5 decideBucket：★点名不符负对照 + heard 缺席禁入 bucket A（RED 先行）
//   步 5  --live：真模型 heard 合规 + 地名命中
//
// 家法：判据要测效果不测措辞。会动兵的断言数 assignedUnitIds（步 2.5 起）。
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
}

// ── ⑤ 打字回合零多余：两段语音 prompt 只在带音频那一轮出现 ──
{
  const P = "SYSTEM PROMPT 正文";
  check("N38 ★withVoiceReinforcement(p,false) 返回的就是 p 本身（identity）★", withVoiceReinforcement(P, false) === P);
  const withVoice = withVoiceReinforcement(P, true);
  check("N39 带音频时才追加，且原文在前", withVoice.startsWith(P) && withVoice.length > P.length);
  check("N40 【本次强制】里钉的是 heard 的义务", /【本次强制】/.test(withVoice) && /根级 "heard"/.test(withVoice));
  check("N41 转写不许进正文（正文会被 TTS 念出来）", /正文里不要复述/.test(withVoice));

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

console.log(bad === 0 ? "\nALL SYNTHETIC PASS" : `\n${bad} 条不过`);
process.exit(bad === 0 ? 0 : 1);
