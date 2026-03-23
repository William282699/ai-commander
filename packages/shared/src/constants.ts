// ============================================================
// AI Commander — Balance Constants
// Terrain tables, unit stats, counter matrix
// ============================================================

import type { UnitType, TerrainType, UnitCategory } from "./types";

// --- Map ---

export const MAP_WIDTH = 200;  // tiles
export const MAP_HEIGHT = 150;
export const TILE_SIZE = 32;   // px at 100% zoom

// --- Timing ---

export const SUPPLY_INTERVAL_SEC = 120; // every 2 minutes
export const INCOME_INTERVAL_SEC = 30;
export const ENDGAME_TIME_SEC = 900;    // 15 minutes
export const SUPPLY_CHOICE_SEC = 15;

// --- Starting Resources ---

export const STARTING_RESOURCES = {
  money: 2000,
  fuel: 100,
  ammo: 100,
  intel: 30,
};

export const BASE_INCOME = {
  money: 100,
  fuel: 20,
  ammo: 20,
  intel: 10,
};

// --- Unit Stats ---

export interface UnitStats {
  hp: number;
  attack: number;
  attackInterval: number; // seconds
  range: number;          // tiles
  speed: number;          // tiles/sec
  cost: number;           // money
  fuelCost: number;
  buildTime: number;      // seconds
  vision: number;         // tiles
  category: UnitCategory;
  special: string[];
}

export const UNIT_STATS: Record<UnitType, UnitStats> = {
  // Ground
  infantry:   { hp: 60,  attack: 8,  attackInterval: 1.0, range: 3,  speed: 2.0, cost: 100,  fuelCost: 0,  buildTime: 5,  vision: 5,  category: "ground", special: ["capture", "forest_move", "swamp_move", "urban_cover"] },
  light_tank: { hp: 120, attack: 15, attackInterval: 1.5, range: 5,  speed: 3.0, cost: 250,  fuelCost: 5,  buildTime: 8,  vision: 7,  category: "ground", special: ["fast"] },
  main_tank:  { hp: 250, attack: 30, attackInterval: 2.0, range: 6,  speed: 2.0, cost: 500,  fuelCost: 10, buildTime: 12, vision: 5,  category: "ground", special: ["frontal_armor"] },
  artillery:  { hp: 80,  attack: 45, attackInterval: 4.0, range: 12, speed: 1.0, cost: 400,  fuelCost: 5,  buildTime: 10, vision: 5,  category: "ground", special: ["indirect_fire", "no_move_attack"] },
  commander:  { hp: 400, attack: 18, attackInterval: 1.0, range: 5,  speed: 2.0, cost: 0,    fuelCost: 0,  buildTime: 0,  vision: 7,  category: "ground", special: ["regen", "projectile3"] },
  elite_guard:{ hp: 250, attack: 18, attackInterval: 1.0, range: 5,  speed: 2.0, cost: 0,    fuelCost: 0,  buildTime: 0,  vision: 5,  category: "ground", special: ["projectile3"] },
  // Naval
  patrol_boat:{ hp: 80,  attack: 10, attackInterval: 1.0, range: 4,  speed: 4.0, cost: 150,  fuelCost: 3,  buildTime: 6,  vision: 8,  category: "naval",  special: ["fast", "shallow_water"] },
  destroyer:  { hp: 200, attack: 25, attackInterval: 1.5, range: 7,  speed: 2.5, cost: 450,  fuelCost: 8,  buildTime: 12, vision: 7,  category: "naval",  special: ["anti_air"] },
  cruiser:    { hp: 350, attack: 40, attackInterval: 2.5, range: 9,  speed: 1.8, cost: 700,  fuelCost: 15, buildTime: 18, vision: 7,  category: "naval",  special: ["shore_bombardment"] },
  carrier:    { hp: 500, attack: 0,  attackInterval: 0,   range: 0,  speed: 1.2, cost: 1000, fuelCost: 25, buildTime: 25, vision: 7,  category: "naval",  special: ["launch_planes"] },
  // Air
  fighter:    { hp: 100, attack: 20, attackInterval: 1.2, range: 5,  speed: 8.0, cost: 350,  fuelCost: 5,  buildTime: 8,  vision: 8,  category: "air",    special: ["air_superiority"] },
  bomber:     { hp: 80,  attack: 60, attackInterval: 5.0, range: 3,  speed: 5.0, cost: 600,  fuelCost: 10, buildTime: 15, vision: 5,  category: "air",    special: ["aoe", "anti_building"] },
  recon_plane:{ hp: 50,  attack: 0,  attackInterval: 0,   range: 0,  speed: 10.0,cost: 150,  fuelCost: 3,  buildTime: 5,  vision: 15, category: "air",    special: ["no_attack", "spotter"] },
};

// --- Counter Matrix ---
// Multiplier applied to base damage: attacker → defender
// 0 means cannot attack that type

type CounterKey = UnitType;
export const COUNTER_MATRIX: Record<CounterKey, Partial<Record<CounterKey, number>>> = {
  infantry:    { infantry: 1.0, light_tank: 0.5, main_tank: 0.25, artillery: 1.0, commander: 0.5, elite_guard: 0.8 },
  light_tank:  { infantry: 1.5, light_tank: 1.0, main_tank: 0.5,  artillery: 1.5, commander: 1.0, elite_guard: 1.0 },
  main_tank:   { infantry: 2.0, light_tank: 1.5, main_tank: 1.0,  artillery: 2.0, commander: 1.5, elite_guard: 1.5 },
  commander:   { infantry: 1.5, light_tank: 1.0, main_tank: 1.0,  artillery: 1.5, commander: 1.0, elite_guard: 1.0 },
  elite_guard: { infantry: 1.5, light_tank: 1.0, main_tank: 1.0,  artillery: 1.5, commander: 1.0, elite_guard: 1.0 },
  artillery:   { infantry: 1.5, light_tank: 1.5, main_tank: 1.2,  artillery: 1.0, commander: 1.2, elite_guard: 1.2, destroyer: 1.0, cruiser: 0.8, carrier: 1.0 },
  patrol_boat: { patrol_boat: 1.0, destroyer: 0.5, cruiser: 0.25, carrier: 0.5 },
  destroyer:   { patrol_boat: 2.0, destroyer: 1.0, cruiser: 0.6,  carrier: 1.0, fighter: 1.5, bomber: 1.5, recon_plane: 1.5 },
  cruiser:     { infantry: 1.0, light_tank: 1.0, main_tank: 0.8, artillery: 1.0, commander: 1.0, elite_guard: 1.0, patrol_boat: 1.5, destroyer: 1.2, cruiser: 1.0, carrier: 1.2 },
  carrier:     { infantry: 0.8, light_tank: 0.8, main_tank: 0.6, artillery: 1.2, commander: 0.8, elite_guard: 0.8, patrol_boat: 1.0, destroyer: 0.8, cruiser: 0.6, carrier: 0.5, fighter: 1.0, bomber: 1.0, recon_plane: 1.0 },
  fighter:     { infantry: 0.5, light_tank: 0.3, main_tank: 0.2, artillery: 0.8, commander: 0.5, elite_guard: 0.5, patrol_boat: 0.6, destroyer: 0.4, cruiser: 0.2, carrier: 0.3, fighter: 2.0, bomber: 2.0, recon_plane: 2.0 },
  bomber:      { infantry: 1.0, light_tank: 0.8, main_tank: 0.6, artillery: 1.5, commander: 1.0, elite_guard: 1.0, patrol_boat: 0.8, destroyer: 0.5, cruiser: 0.4, carrier: 0.6, fighter: 0.3, bomber: 0.5, recon_plane: 0.8 },
  recon_plane: {},
};

// --- Terrain Movement Multipliers ---
// 1.0 = normal, 0 = impassable

export const TERRAIN_MOVE_MULT: Record<TerrainType, Record<UnitCategory, number>> = {
  plains:        { ground: 1.0,  naval: 0,   air: 1.0 },
  hills:         { ground: 0.7,  naval: 0,   air: 1.0 },
  forest:        { ground: 0.5,  naval: 0,   air: 1.0 },
  swamp:         { ground: 0.4,  naval: 0,   air: 1.0 },
  road:          { ground: 1.3,  naval: 0,   air: 1.0 },
  shallow_water: { ground: 0,    naval: 0.8, air: 1.0 },
  deep_water:    { ground: 0,    naval: 1.0, air: 1.0 },
  bridge:        { ground: 0.8,  naval: 0,   air: 1.0 },
  urban:         { ground: 0.6,  naval: 0,   air: 1.0 },
  mountain:      { ground: 0,    naval: 0,   air: 1.0 },
};

// Ground-specific: tanks can't go through forest/swamp
export const TANK_BLOCKED_TERRAIN: TerrainType[] = ["forest", "swamp", "shallow_water", "deep_water", "mountain"];
export const INFANTRY_BLOCKED_TERRAIN: TerrainType[] = ["shallow_water", "deep_water", "mountain"];

// --- Terrain Defense Bonus ---

export const TERRAIN_DEFENSE_BONUS: Partial<Record<TerrainType, Partial<Record<UnitCategory, number>>>> = {
  urban:  { ground: 0.5 },  // 50% damage reduction for ground in urban
  forest: { ground: 0.3 },  // 30% for infantry in forest
  hills:  { ground: 0.2 },  // 20% on hills
};

// --- Fuel / Ammo Consumption ---

export const FUEL_PER_TILE_TANK = 0.1;
export const FUEL_PER_TILE_SHIP = 0.2;
export const FUEL_PER_SORTIE_AIR = 2.0;
export const AMMO_PER_ATTACK = 0.05;
export const FUEL_EMPTY_PENALTY = 0;       // speed mult when fuel=0 (stopped)
export const AMMO_EMPTY_FIRE_MULT = 0.2;   // 80% fire reduction

// --- Capture ---

export const CAPTURE_TIME_SEC = 5;

// --- Style Learning ---

export const STYLE_LEARNING_RATE = 0.03;

// --- LLM ---

export const LLM_CACHE_TTL_SEC = 30;
export const LLM_LIGHT_INTERVAL_SEC = 60;

// --- Facility Resource Bonuses (per 30s) ---

export const FACILITY_BONUSES: Record<string, Partial<{ money: number; fuel: number; ammo: number; intel: number }>> = {
  fuel_depot:    { fuel: 30 },
  ammo_depot:    { ammo: 25 },
  comm_tower:    { intel: 20 },
  rail_hub:      { ammo: 25 },
  repair_station:{},
};

// --- Trade Costs ---

export const TRADE_COSTS = {
  buy_fuel:  { cost: 300, gain: 30, cooldown: 60 },
  buy_ammo:  { cost: 300, gain: 25, cooldown: 60 },
  buy_intel: { cost: 200, gain: 15, cooldown: 90 },
  sell_fuel:  { cost: -200, gain: -20, cooldown: 30 }, // negative = gain money
  sell_ammo:  { cost: -200, gain: -20, cooldown: 30 },
};

// --- Production Facility Mapping ---

export const PRODUCTION_FACILITY: Record<UnitCategory, FacilityType> = {
  ground: "barracks",
  naval: "shipyard",
  air: "airfield",
};

import type { FacilityType } from "./types";
