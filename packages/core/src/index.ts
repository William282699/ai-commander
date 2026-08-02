export { applyOrders, applyEnemyOrders, replaceProvisionalOrders, applyPlayerCommands, releaseManualOverride } from "./applyOrders";
export { tick, canUnitEnterTile } from "./sim";
export { calculateDamage, processCombat } from "./combat";
export { processRegen } from "./regen";
export { createFogState, updateFog } from "./fog";
export { processEconomy, enqueueProduction, canUnitMove, isMechanized, countCaptureContenders, isCapturableFacilityType } from "./economy";
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
  buildFrontEscalationWithTickets, resolveTicketReference, ticketDispatchReceipt,
  burnEscalationTicket, isTicketRef, resetEscalationTickets,
  TICKET_TTL_SEC, NO_PROPOSAL_GUIDANCE,
} from "./escalationTicket";
export type { EscalationTicket, TicketResolution, EscalationWithTickets } from "./escalationTicket";
export type { CommanderMood, CommanderMoodLevel, ViewportGeometry, TileBox } from "./commanderPresence";
export type { DecisionCaptureArgs, DecisionReviewFacts, FrontOutcome, FacilityOutcome, CasualtyLevel, CrossFrontFact } from "./decisionReview";
