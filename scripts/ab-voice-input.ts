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
import { encodeWavBase64 } from "../apps/web/src/voiceRecorder";

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

interface LiveFixture {
  file: string;
  sha256: string;
  /** 原句（人念的那一句），只作记录 */
  spoken: string;
  /** 判据：这些词必须出现在 heard 里 */
  mustHear: string[];
}

const LIVE_FIXTURES: LiveFixture[] = [
  {
    file: "scripts/fixtures/voice/cmd1.wav",
    sha256: "0d69ae3688c68c22a6a1f0bd412f0c992a0446b17b6a461a43f7d5a8b16f7b90",
    spoken: "战狼点附近的闲置部队，去增援南线前哨",
    // 战狼点＝玩家自造标记名，只活在信封的 ---TAGS--- 里：本刀红利的最短证明
    mustHear: ["战狼点", "南线前哨"],
  },
  {
    file: "scripts/fixtures/voice/cmd2.wav",
    sha256: "7adc8a240b7633ac2146782fd0f1ba699d31c9bfd3a002eb1f8fd5d2fc3ca906",
    spoken: "派两个步兵班去 El Alamein，剩下的守住烽火台",
    // 只钉「烽火台」：El Alamein 这一段是已登记的脏样本（I2 账根），不设硬线
    mustHear: ["烽火台"],
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
  for (const f of LIVE_FIXTURES) {
    const bytes = readFileSync(f.file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    check(`L0 夹具自证 ${f.file} sha256 与入库一致`, sha === f.sha256, sha.slice(0, 16));
    check(`L0 夹具自证 ${f.file} 是 16kHz / 单声道 / 16bit`,
      dv.getUint32(24, true) === 16000 && dv.getUint16(22, true) === 1 && dv.getUint16(34, true) === 16,
      `${dv.getUint32(24, true)}Hz ch=${dv.getUint16(22, true)} bits=${dv.getUint16(34, true)}`);
  }
  if (bad > 0) {
    console.log("\n★夹具没过自证——后面的 heard 数字一个字都不许用。停。");
    process.exit(1);
  }

  const rows: { fx: string; heard: string; prose: string; ok: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const fx = LIVE_FIXTURES[i % LIVE_FIXTURES.length];
    const audio = { data: readFileSync(fx.file).toString("base64"), format: "wav" as const };
    let prose = "";
    let heard = "";
    try {
      for await (const ev of callAdvisorStream(LIVE_DIGEST, "", "risk=0.50 focus=0.50 obj=0.50 cas=0.50", "combat", audio)) {
        if (ev.type === "text") prose += ev.content;
        else if (ev.type === "options") heard = typeof ev.content?.heard === "string" ? ev.content.heard : "";
      }
    } catch (e) {
      console.log(`  #${i} 调用失败: ${String(e).slice(0, 80)}`);
    }
    const hit = fx.mustHear.filter((w) => heard.includes(w));
    rows.push({ fx: fx.file.slice(-8), heard, prose, ok: hit.length === fx.mustHear.length });
    console.log(`  #${String(i).padStart(2)} ${fx.file.slice(-8)} 地名 ${hit.length}/${fx.mustHear.length}  heard=${heard || "(缺席)"}`);
    if (i < n - 1) await new Promise((r) => setTimeout(r, 8000)); // 免费档配速
  }

  // ── 三条判据 ──
  const present = rows.filter((r) => r.heard.length > 0).length;
  check(`L1 ★heard 在场 ${present}/${n}（收口线 ≥19/20，即 ≥95%）★`,
    present >= Math.ceil(n * 0.95), `${present}/${n}`);

  // 转写复读进正文＝TTS 会把长官自己的话念回给他
  const polluted = rows.filter((r) => r.heard.length > 4 && r.prose.includes(r.heard));
  check(`L2 ★转写没有被复读进正文（TTS 污染）${n - polluted.length}/${n}★`, polluted.length === 0,
    polluted.length ? `${polluted.length} 条` : "");
  // 红了要看得见现场：把整段正文打出来，好分辨"真复读"与"brief 恰好跟命令重合"。
  for (const p of polluted) {
    console.log(`   ↳ heard: ${p.heard}`);
    console.log(`   ↳ prose: ${p.prose.replace(/\n/g, "⏎")}`);
  }

  // 地名命中：本刀存在的理由。不设百分比硬线以外的花样，逐条可读。
  const nameOk = rows.filter((r) => r.ok).length;
  check(`L3 ★地名命中 ${nameOk}/${n}——「战狼点」这种只活在信封里的名字听不出来，这一刀就白做★`,
    nameOk >= Math.ceil(n * 0.9), `${nameOk}/${n}`);

  console.log(bad === 0 ? "\nALL LIVE PASS" : `\n${bad} 条不过`);
  process.exit(bad === 0 ? 0 : 1);
}
