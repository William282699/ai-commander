/**
 * 侧栏跟频道走 · 浏览器 DOM 取证（步 1 页签＋步 2 军械页）。
 *
 * ⚠ 本档是**取证附件，不是验收臂**（照 probe-naming-frames.ts 家法）：
 * probe- 前缀 ⇒ 不进 run-benches.sh，不受纪律③对账。它要人开着 3025 的现场，
 * 在 DevTools 主窗 console 里整份粘贴执行——node 台架零 DOM，测不到这些格。
 *
 * 用法：起 frame-web(3025) → 关掉新手教程 → 粘贴本文件全文 → 回车。
 * 返回 {total, passed, fails[], selftest}。步 3 直接复用，别每次重写。
 *
 * ★★方法教训（2026-08-18 实测踩到，别再踩）：**不许 sleep 一次就读**。
 * 浏览器把隐藏/后台标签的定时器节流到 ~1s，ChatPanel 那口 200ms 轮询会跟着
 * 变慢；固定 sleep(600) 在可见页够、在隐藏页读得比轮询还早 ⇒ 判据偶发地红，
 * 而产品是好的。所以一切"改了状态等 UI 跟上"一律走 waitFor（等到发生为止，
 * 带上限），既免疫节流又在可见页里跑得快。
 *
 * ⚠ 判据要能响：
 *  - 内建负对照＝同一个探针在不同频道给出不同值（页签栏存在/不存在、
 *    OrgTree 在/不在、data-panel-tab 三个值），恒真的判据混不进来；
 *  - 末尾 SELFTEST 故意断言一条错的期望，它必须 FAIL——不 FAIL 就说明这套
 *    chk 机制自己坏了，全部结果作废；
 *  - 军械页量的是**效果**（行数、屏上花费文字 vs 引擎给的常量、钱没动时表
 *    要不要变），不是量标签文字。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 等到 pred 为真（默认 6s 上限）。返回是否等到——超时不抛，交给 chk 记红。 */
  const waitFor = async (pred, timeoutMs = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (pred()) return true; } catch { /* 元素还没上来，继续等 */ }
      await sleep(100);
    }
    return false;
  };
  const allBtn = () => [...document.querySelectorAll("button")];
  const byPrefix = (p) => allBtn().find((b) => b.textContent.trim().startsWith(p));
  const tabBarEl = () => document.querySelector("[data-tab-bar]");
  const panelTabEl = () => document.querySelector("[data-panel-tab]");
  const panelContentEl = () => document.querySelector("[data-panel-content]");
  const arsenalEl = () => document.querySelector("[data-arsenal-panel]");
  const rows = () => [...document.querySelectorAll("[data-arsenal-row]")];
  const affOf = (t) => (document.querySelector(`[data-arsenal-row="${t}"]`) || { dataset: {} }).dataset.affordable;
  const contentText = () => {
    const b = tabBarEl();
    const wrap = b ? b.nextElementSibling : document.querySelector("[data-ptt-btn]").parentElement.parentElement;
    return wrap ? wrap.innerText : "";
  };
  // OrgTree 的标志串：树里印大写列头 CHEN，对话页印的是「陈军士」
  const orgTreeVisible = () => /\bCHEN\b/.test(contentText());
  const placeholderOf = () => (document.querySelector("input[type=text]") || {}).placeholder || "";

  const R = [];
  const chk = (name, got, want) => R.push({ name, got: String(got), want: String(want), pass: String(got) === String(want) });
  /** 点频道键，等到输入框改口（换频道的可观察后果）再往下走 */
  const go = async (prefix, expectPlaceholderStart) => {
    byPrefix(prefix).click();
    await waitFor(() => placeholderOf().startsWith(expectPlaceholderStart));
  };
  const tab = async (which) => {
    const before = contentText();
    (which === "panel" ? panelTabEl() : allBtn().find((b) => b.textContent.trim() === "通讯 ☎")).click();
    await waitFor(() => contentText() !== before);
  };
  const rightClick = async (prefix, expectPlaceholderStart) => {
    byPrefix(prefix).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await waitFor(() => placeholderOf().startsWith(expectPlaceholderStart));
  };

  // ── 步 1：页签跟频道走 ──
  await go("陈军士", "对陈军士"); await tab("chat");
  chk("A1 陈:页签栏存在", !!tabBarEl(), true);
  chk("A2 陈:第二页签文字", panelTabEl().textContent.trim(), "编制 ☰");
  chk("A3 陈:data-panel-tab", panelTabEl().dataset.panelTab, "chen");
  chk("A4 陈通讯页:无 OrgTree", orgTreeVisible(), false);
  chk("A5 陈通讯页:placeholder 负对照", placeholderOf().startsWith("对陈军士"), true);

  await tab("panel");
  chk("B1 陈编制页:OrgTree 在", orgTreeVisible(), true);

  await go("马克斯", "对马克斯");
  chk("C1 马:页签文字", panelTabEl().textContent.trim(), "计策");
  chk("C2 马:data-panel-tab", panelTabEl().dataset.panelTab, "marcus");
  chk("C3 马:占位话", panelContentEl().innerText.trim(), "参谋部尚未拟定方案。");
  chk("C4 马:不串台(无 OrgTree)", orgTreeVisible(), false);

  await go("艾米莉", "对艾米莉");
  chk("D1 艾:页签文字", panelTabEl().textContent.trim(), "军械");
  chk("D2 艾:data-panel-tab", panelTabEl().dataset.panelTab, "emily");
  chk("D3 艾:不串台(无 OrgTree)", orgTreeVisible(), false);

  await go("ALL", "全体通信");
  chk("E1 群聊:页签栏不存在", !!tabBarEl(), false);
  chk("E2 群聊:第二页签不存在", !!panelTabEl(), false);
  chk("E3 群聊:不串台", orgTreeVisible(), false);
  chk("E4 群聊:内容是对话", placeholderOf().startsWith("全体通信"), true);

  // ★两人组：isGroupChat=length>1 那一格（写 length===3 会漏网）
  await go("陈军士", "对陈军士");
  await rightClick("马克斯", "全体通信");
  chk("G1 两人组:页签栏消失", !!tabBarEl(), false);
  chk("G2 两人组:输入框是群聊", placeholderOf().startsWith("全体通信"), true);
  await rightClick("马克斯", "对陈军士");
  chk("G3 退回单选:页签栏回来", !!tabBarEl(), true);
  chk("G4 退回单选:签名是编制", panelTabEl() ? panelTabEl().textContent.trim() : "-", "编制 ☰");
  chk("G5 回陈:记得停在编制页", orgTreeVisible(), true);

  // ── 步 2：军械页 ──
  await go("艾米莉", "对艾米莉");
  if (!arsenalEl()) await tab("panel");
  await waitFor(() => rows().length === 4);
  chk("H1 军械页:表在", !!arsenalEl(), true);
  chk("H2 军械页:四行陆军", rows().length, 4);
  chk("H3 军械页:行序＝UNIT_STATS 声明序", rows().map((r) => r.dataset.arsenalRow).join(","), "infantry,light_tank,main_tank,artillery");
  chk("H4 只看不点:容器内零按钮", arsenalEl().querySelectorAll("button").length, 0);
  // 屏上花费必须逐字等于引擎给的那个数（防手写常量；绊索一测的就是这条）
  chk("H5 花费与引擎同源", rows().every((r) => {
    const c = r.querySelector("[data-arsenal-cost]");
    return c.textContent === "$" + c.dataset.arsenalCost;
  }), true);
  // 三句核过的假话，一个字都不许出现
  const arsenalText = arsenalEl().innerText;
  chk("H6 无假话:只有步兵能占点", /只有步兵.*占/.test(arsenalText), false);
  chk("H7 无假话:最小射程", /最小射程/.test(arsenalText), false);
  chk("H8 无假话:侦察机开眼", /侦察机.*(开眼|视野)|火炮.*瞎/.test(arsenalText), false);

  const bridge = window.__GAME_BRIDGE__;
  if (bridge) {
    // ★★别缓存 state 对象：开局/重开时 GameState 会**换身份**（ChatPanel 自己就带
    //   一个 object-identity restart guard）。缓存一次再改，改的是**孤儿对象**——
    //   面板读的是新那份，于是所有断言一起红而产品是好的（2026-08-18 栽过一次，
    //   I/J 六条同时红，实为探针病）。一切读写都走 res()/fac() 现取。
    const res = () => bridge.getState().economy.player.resources;
    const fac = () => bridge.getState().facilities.get("ea_player_barracks");
    const saveMoney = res().money;
    const saveFuel = res().fuel;
    // 灰行判据：C1 写 !Number.isFinite(now)||now<=0，不是 now===0。
    // ★等法：等到**整行状态就位**再断言，别等一个代理条件（早先写「等步兵变灰
    //   就断言四行全灰」，在被节流的隐藏标签里偶发地读在半路上——产品是原子
    //   翻转的，红的是判据）。waitFor 超时不抛，断言照样会红并印出真实那一行。
    const affLine = () => rows().map((r) => `${r.dataset.arsenalRow}:${r.dataset.affordable}`).join(",");
    const ALL_NO = "infantry:no,light_tank:no,main_tank:no,artillery:no";
    const ALL_YES = "infantry:yes,light_tank:yes,main_tank:yes,artillery:yes";
    const PARTIAL_250 = "infantry:yes,light_tank:yes,main_tank:no,artillery:no";
    const NO_FUEL = "infantry:yes,light_tank:no,main_tank:no,artillery:no";

    res().money = 250;
    await waitFor(() => affLine() === PARTIAL_250);
    chk("I1 钱=250:买得起步兵/轻坦，买不起主战/火炮", affLine(), PARTIAL_250);

    res().money = -500;
    await waitFor(() => affLine() === ALL_NO);
    chk("I2 钱=-500:全灰(now 是负数，now===0 的写法会当成买得起)", affLine(), ALL_NO);

    res().money = saveMoney;
    await waitFor(() => affLine() === ALL_YES);

    res().fuel = 0;
    await waitFor(() => affLine() === NO_FUEL);
    chk("I3 油=0:步兵不吃油仍可造，机械化三种趴窝", affLine(), NO_FUEL);

    res().fuel = saveFuel;
    await waitFor(() => affLine() === ALL_YES);

    // 设施闸：打掉兵营（钱一分不动）——整表必须换成引擎原话
    const moneyBefore = res().money;
    fac().hp = 0;
    await waitFor(() => rows().length === 0);
    chk("J1 兵营 hp=0:四行消失", rows().length, 0);
    chk("J2 兵营 hp=0:说引擎原话", panelContentEl().innerText.trim(), "无可用生产设施");
    chk("J3 这一变化与钱无关(钱没动)", res().money, moneyBefore);
    fac().hp = fac().maxHp;
    await waitFor(() => rows().length === 4);
    chk("J4 修回兵营:四行回来", rows().length, 4);
    res().money = saveMoney;
    res().fuel = saveFuel;
  } else {
    R.push({ name: "I/J 段跳过：__GAME_BRIDGE__ 不在（不是主窗？）", got: "skipped", want: "skipped", pass: true });
  }

  // ── SELFTEST：这一条必须 FAIL，否则整套判据不可信 ──
  const selftestIdx = R.length;
  chk("SELFTEST 故意写错的期望（必须 FAIL）", panelTabEl() ? panelTabEl().textContent.trim() : "-", "这不是任何一个页签的名字");

  // 收摊：把现场还原成默认（陈 + 通讯页），下一次跑不受上一次残留影响
  await go("陈军士", "对陈军士");
  if (orgTreeVisible()) await tab("chat");

  const real = R.slice(0, selftestIdx);
  const selftest = R[selftestIdx];
  const fails = real.filter((r) => !r.pass);
  return JSON.stringify({
    total: real.length,
    passed: real.length - fails.length,
    fails: fails.map((f) => `${f.name} got=${f.got} want=${f.want}`),
    selftest: selftest.pass ? "★★判据机制坏了：故意写错的那条居然过了，全部结果作废" : "OK（故意写错的那条如期 FAIL）",
    note: document.hidden ? "本次在隐藏标签里跑（定时器被节流）——waitFor 已免疫，仅供留痕" : "可见标签",
  }, null, 1);
})()
