export { applyOrders, applyEnemyOrders, replaceProvisionalOrders, applyPlayerCommands, releaseManualOverride } from "./applyOrders";
export { tick, canUnitEnterTile } from "./sim";
export { calculateDamage, processCombat } from "./combat";
export { processRegen } from "./regen";
export { createFogState, updateFog } from "./fog";
export { processEconomy, enqueueProduction, canUnitMove, isMechanized, countCaptureContenders, isCapturableFacilityType, usesGroundCaptureRules } from "./economy";
export { processEnemyAI, resetEnemyAITimer, resetEnemyProdToggle, resetAttackWaveState } from "./enemyAI";
export { processAutoBehavior, resetAutoBehaviorTimer, chaseAnchorHomeOf } from "./autoBehavior";
export { processMissions, createMission, resetMissionCounter } from "./missions";
export type { CreateMissionOpts } from "./missions";
export { createDefaultStyle, updateStyleParam } from "./styleEngine";
export { updateGamePhase, checkGameOver, applyEndgamePressure, resetWarPhaseTimers } from "./warPhase";
export { resolveIntent, isIntentSupported, findFront, findFacilityById, resolveRoute, resolveRouteChain } from "./tacticalPlanner";
export { getFormationOffset, computeHeading } from "./formation";
export type { FormationStyle } from "./formation";
export type { ResolveResult } from "./tacticalPlanner";
// 刀戊：目的地分类（按**实际解析结果**，不按字段非空）——判据要直接量它
export { classifyDestination } from "./tacticalPlanner";
// 刀寅：这条命令自己的「去处原话」与目的地字段是否一致
export { checkDestinationQuote, isCompleteConfirmPlan, findSplitQuantity, findQuantityAmbiguity, applyQuantityReading, contractReplyConflict, parseQuantityWord, QUANTITY_TOTAL_KEY, QUANTITY_BY_TYPE_KEY } from "./tacticalPlanner";
export type { QuantityAmbiguity, ContractReplyConflict } from "./tacticalPlanner";
export type { DestinationQuoteVerdict } from "./tacticalPlanner";
export type { DestinationClass, DestinationKind } from "./tacticalPlanner";
export { buildDigest } from "./intelDigest";
export { buildBattleContextV2 } from "./battleContext";
export { buildBattleBoard } from "./battleBoard";
export type { BattleBoard, BoardSquadRow, BoardGroupRow } from "./battleBoard";
export { processReportSignals, drainReportEvents, resetReportSignals } from "./reportSignals";
export { createInitialGameState } from "./scenario";
export { processDefensiveAI, resetDefensiveAITimer } from "./scenario/elAlamein";
export { processPressureDirector, resetPressureDirector, probePressureTargets, OBJECTIVE_PRESSURE_WEIGHT } from "./scenario/elAlamein/pressureDirector";
export { checkDoctrines, cancelDoctrine } from "./doctrine";
export { findBestReinforcements, generateCrisisCard, assessCrisisEscalation } from "./crisisResponse";
export type { ReinforceCandidate, CrisisEscalation, CrisisEscalationKind } from "./crisisResponse";
export { updateTasks, computeTaskPriority } from "./taskTracker";
export { updateBattleMarkers, resetEngagementCache } from "./battleAwareness";
export { processAdvisorTriggers } from "./advisorTrigger";
export type { AdvisorTriggerResult } from "./advisorTrigger";
// Step 7a — director read-board (pure; not yet wired into UI/LLM)
export { selectDirectorBeat, collectDirectorBeats, snapshotForDirector, describeDirectorBeat } from "./director";
// Step 7b — report-event denoise gate (pure; chooses which event escalates)
export { selectEscalationEvent } from "./director";
// Step 7c.1 — escalation grounding facts (pure; for LLM voice, not a template)
export { frontEscalationFacts } from "./director";
export { buildFrontEscalationPayload } from "./frontEscalationPayload";
// retreat-scope 刀C — 任务台账（「哪次任务」这一类指代）
export {
  liveDispatchMembers, findDispatch, activeDispatches,
  recordPlayerDispatch, findDispatchAmbiguity,
  // 刀己 — 候选枚举（事实）与按 key 现查绑定（执行前复查）
  enumerateDispatchCandidates, bindDispatchSelection, selectionKeyOf,
  // 刀寅：逐人记下的出发战线
  liveMembersByOrigin,
} from "./dispatchLedger";
export type { DispatchCandidate, SelectionBindResult, SelectionBindFailure } from "./dispatchLedger";
// 刀己 — 「是哪一批」这一轮该做什么（判定本体在 core，UI 只执行 plan）
export { planSelectionTurn, planDispatchSelectionBatch } from "./dispatchSelectionTurn";
export type {
  SelectionSlotState,
  SelectionTurnPlan,
  SelectionTurnDecision,
  DispatchSelectionKey,
  ResolvedDispatchSelection,
  DispatchSelectionRequirement,
  DispatchSelectionBatchPlan,
} from "./dispatchSelectionTurn";
export { previewHighImpactIntent, isAllFrontHint } from "./tacticalPlanner";
export type { HighImpactPreview } from "./tacticalPlanner";
export { buildPreflightConcernFacts, serializePreflightFacts, buildPreflightFallbackLine } from "./commandPreflight";
export type { PreflightConcernFacts, PreflightFrontDelta, PreflightFrontStatus } from "./commandPreflight";
export type { EscalationFacts } from "./director";
// Step 7c.1 stabilization — facility-contest grounding facts + worthiness gate (pure)
export { facilityEscalationFacts, facilityContestWorthAsking, buildFacilityEscalationPayload } from "./director";
export type { FacilitySituationType } from "./director";
export type { FacilityEscalationFacts } from "./director";
export type { DirectorBeat, DirectorBeatKind, DirectorStake, DirectorTrend, DirectorMetricSnapshot, DirectorSnapshot } from "./director";
// Step 7c.2b — Marcus strategic aggregation (pure; report-driven situations)
export { collectStrategicSituations, STRATEGIC_WINDOW_SEC } from "./director";
export type { StrategicSituation, StrategicSituationKind } from "./director";
// Step 7e — decision review (pure; engine judges outcomes + routes the persona, LLM only voices)
export { captureDecisionReview, enqueueDecisionReview, assessDecisionReview, describeDecisionReview, buildRetrospectMiniFacts, isReviewableIntentType, REVIEW_TUNING } from "./decisionReview";
// Commander Presence V1 — engine judgment material (pure; LLM only voices)
export { buildFrontJudgmentLines, commanderMood, buildCommanderMoodLine, viewportToTileBox, unitsInBox, placeNameAt, buildPlayerViewLines } from "./commanderPresence";
// approval-contract-v4 刀2 — escalation tickets (the machine handle for "那批兵")
export {
  buildFrontEscalationWithTickets, buildFacilityEscalationWithTickets, resolveTicketReference, ticketDispatchReceipt,
  retargetIntentForTicket, ticketDestinationVerdict, mintSpokenForce, spokenNameOf,
  burnEscalationTicket, isTicketRef, isKnownForceRef, resetEscalationTickets,
  TICKET_TTL_SEC, NO_PROPOSAL_GUIDANCE,
  // 刀寅：用过的票 → 真走了的那一批；票据差额的结构化原因
  resolveTicketBatch, ticketGapFacts,
} from "./escalationTicket";
export type { EscalationTicket, TicketResolution, TicketDestinationVerdict, EscalationWithTickets, CommanderRef, TicketBatchResolution, TicketGapFacts } from "./escalationTicket";
// H1 — 抽走带任务的部队必须说出口（披露，不是闸；user ruling 2026-08-05）
export { describeCommittedPull } from "./committedUnits";
export type { CommittedPullDisclosure } from "./committedUnits";
// 手测账③ — command authority (dispatch is per-persona, not per-naming)
export { checkDispatchAuthority, commanderDispatchPool, isDispatchIntent, combatRoleHolder } from "./commandAuthority";
export type { AuthorityVerdict } from "./commandAuthority";
export type { CommanderMood, CommanderMoodLevel, ViewportGeometry, TileBox } from "./commanderPresence";
export type { DecisionCaptureArgs, DecisionReviewFacts, FrontOutcome, FacilityOutcome, CasualtyLevel, CrossFrontFact } from "./decisionReview";

export { findSameTaskInProgress } from "./repeatDispatch";
export { burnedAncestorsOf } from "./escalationTicket";
export { destinationCovers } from "./tacticalPlanner";
export { describePlanForApproval, describeIntentForApproval } from "./planDescription";
