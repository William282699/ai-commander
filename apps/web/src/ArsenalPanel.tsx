// ============================================================
// AI Commander — 军械页（艾米莉频道的第二页签）
// 侧栏刀 步2。侧栏＝当前参谋的领域参考：这一页是「我现在能造什么」。
// ★只看不点：本文件不许出现任何 <button>。玩家看完回通讯页跟艾米莉说一声，
//   下单永远走对话（对话是唯一界面）。
// ============================================================
import type { ProductionCategoryOptions, UnitType } from "@ai-commander/shared";
import { UNIT_STATS, UNIT_DISPLAY_NAME } from "@ai-commander/shared";

/**
 * 一句人话。★红线：每个从句都必须能指回引擎里的一个数或一条真机制
 * （开工令〔文案事实单〕逐条核到 file:line）。
 *
 * ★★禁止拿 `special` 标签当机制：UNIT_STATS.special 的 19 个值里只有
 * `projectile3` 真接了引擎，其余 18 个是装饰标签——`capture` 从没被读过
 * （真判据是 countCaptureContenders：阿拉曼分支 category==="ground"，
 * ⇒ 四种陆军都能占点）、`no_move_attack` 的实现是 combat 里对 artillery 的
 * 硬判、`frontal_armor` 的效果在 combat 的 ×0.75 与 COUNTER_MATRIX 里。
 * 核过的三句假话，一个字都不许出现：「只有步兵能占点」／「火炮有最小射程」
 * （无 minRange）／「火炮瞎、要侦察机开眼」（火炮视野 16 > 射程 12）。
 *
 * ★句子里的数字是手写的（火炮那句的「12」）：改 UNIT_STATS 的 range/speed
 * 要回来重核这几句——绊索一只盯花费列，盯不住散文。
 */
const UNIT_BLURB: Partial<Record<UnitType, string>> = {
  infantry: "便宜耐造、不吃油；唯一能进森林沼泽的陆军，蹲住防守还会掘壕减伤。",
  light_tank: "全场最快的陆军，欺负步兵和火炮一把好手，别拿去硬碰主战坦克。",
  main_tank: "陆战主力：血最厚、持续输出最高，正面装甲再吃掉两成五伤害。",
  artillery: "射程 12 是坦克的两倍，一炮很疼；但走路时开不了火，皮薄腿慢，最怕飞机。",
};

/** 每秒伤害。引擎同源守则：attackDamage<=0 || attackInterval<=0 的单位
 *  根本不选目标（侦察机/航母就是这样），那种写「不开火」而不是算出 NaN。
 *  本表四行虽然都开火，守则要在代码里备着——将来放开空军就用得上。 */
function dpsText(t: UnitType): string {
  const s = UNIT_STATS[t];
  if (!(s.attack > 0) || !(s.attackInterval > 0)) return "不开火";
  return (s.attack / s.attackInterval).toFixed(1);
}

interface ArsenalPanelProps {
  /** buildProductionOptions(state, "player").categories —— 引擎算好的那份。
   *  轮询在 ChatPanel 里，只有内容真变了才换新对象（见那处签名注释）。
   *  null＝游戏状态还没上来。 */
  categories: ProductionCategoryOptions[] | null;
}

export function ArsenalPanel({ categories }: ArsenalPanelProps) {
  if (!categories) {
    return <div style={emptyStyle}>加载中...</div>;
  }

  // ★本轮有意只列陆军。空军三种（战斗机/轰炸机/侦察机）在阿拉曼**确实可造**
  //   （玩家有 ea_player_airfield），这条过滤把它们挡在面板外——面板漏报空军
  //   已入 LEDGER。想放开＝删下面这一行。
  //   ★★这是叠在 buildProductionOptions 输出上的类别过滤，不是自己筛 UNIT_STATS：
  //   commander/elite_guard 也是 category "ground" 且 cost=0，只有函数里的
  //   `cost>0 && buildTime>0` 谓词挡得住它们。UI 一旦自己 filter UNIT_STATS，
  //   指挥官就会出现在生产清单里。
  const ground = categories.find((c) => c.cat === "ground");

  if (!ground) {
    return <div style={emptyStyle}>加载中...</div>;
  }

  // ★地雷 D1：alive===false 时 options[] 依然是满的（提函数带来的形状差——
  //   基线那份是短路不算的）。所以必须先判 alive，绝不许直接 map(options)：
  //   兵营被打掉却照旧列出四行，就是面板说谎。措辞取引擎原话（economy.ts
  //   enqueueProduction 的拒绝理由），不自造。
  if (!ground.alive) {
    return <div style={emptyStyle}>无可用生产设施</div>;
  }

  return (
    <div style={containerStyle} data-arsenal-panel>
      <div style={headerStyle}>可生产 · 陆军</div>
      {ground.options.map((o) => {
        const t = o.unitType as UnitType;
        const s = UNIT_STATS[t];
        // C1：灰行判据不写 `now === 0`——「恒有限非负」是注释的承诺不是类型的
        // 保证（钱为负会得 -1，NaN 会一路传下来）。判据自己扛住。
        const affordable = Number.isFinite(o.now) && o.now > 0;
        return (
          <div key={o.unitType} style={{ ...rowStyle, opacity: affordable ? 1 : 0.4 }} data-arsenal-row={o.unitType} data-affordable={affordable ? "yes" : "no"}>
            <div style={rowHeadStyle}>
              <span style={nameStyle}>{UNIT_DISPLAY_NAME[t]}</span>
              <span style={costStyle} data-arsenal-cost={String(o.cost)}>${o.cost}</span>
            </div>
            <div style={blurbStyle}>{UNIT_BLURB[t]}</div>
            <div style={statsRowStyle}>
              <span style={statStyle}>血 <b style={statNumStyle}>{s.hp}</b></span>
              <span style={statStyle}>输出 <b style={statNumStyle}>{dpsText(t)}</b></span>
              <span style={statStyle}>射程 <b style={statNumStyle}>{s.range}</b></span>
              <span style={statStyle}>速度 <b style={statNumStyle}>{s.speed.toFixed(1)}</b></span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Styles (HUD theme) ──

/** 外面两层包裹都是 overflow:hidden，这一层不自带滚动就会顶爆或被裁。 */
const containerStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "8px 10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const emptyStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  color: "var(--hud-text-dim)",
  fontSize: 12,
  textAlign: "center",
};

const headerStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "var(--hud-text-dim)",
  fontFamily: "var(--hud-font-display)",
  borderBottom: "1px solid rgba(0, 212, 255, 0.12)",
  paddingBottom: 4,
  flexShrink: 0,
};

const rowStyle: React.CSSProperties = {
  border: "1px solid rgba(0, 212, 255, 0.14)",
  borderLeft: "2px solid rgba(0, 212, 255, 0.35)",
  background: "rgba(10, 18, 32, 0.6)",
  padding: "6px 8px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  flexShrink: 0,
};

const rowHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
};

const nameStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "var(--hud-text-primary)",
  fontFamily: "var(--hud-font-display)",
  letterSpacing: 0.5,
};

const costStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "var(--hud-accent-cyan)",
  fontFamily: "var(--hud-font-mono)",
};

const blurbStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: "var(--hud-text-secondary)",
};

const statsRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "2px 12px",
  fontSize: 10,
  color: "var(--hud-text-dim)",
  fontFamily: "var(--hud-font-mono)",
};

const statStyle: React.CSSProperties = { whiteSpace: "nowrap" };

const statNumStyle: React.CSSProperties = { color: "var(--hud-text-primary)", fontWeight: 600 };
