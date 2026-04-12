#!/usr/bin/env bash
# copy-sprites.sh
#
# Idempotent one-shot copier for the TDS Modern Pixel Game Kit sprite assets.
# Reads raw PNGs from the external asset pack (outside any worktree) and
# writes renamed, organized copies into apps/web/public/sprites/tds/ inside
# the current worktree.
#
# See SPRITE_INTEGRATION_PLAN.md §2.1 and §15 step 1.

set -euo pipefail

SRC="/Users/yuqiaohuang/MyProjects/AI Commander/tds-modern-pixel-game-kit"
# Resolve destination relative to this script's location so the script works
# from any worktree without hardcoding a path.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEST="$SCRIPT_DIR/../apps/web/public/sprites/tds"

# Short paths into each sub-pack
PACK1="$SRC/tds-pixel-art-modern-soldiers-and-vehicles-sprites"
PACK2="$SRC/tds-modern-soldiers-and-vehicles-sprites-2"
PACK_HERO="$SRC/tds-modern-hero-weapons-and-props"

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: Asset pack not found at: $SRC" >&2
  echo "Please place the extracted tds-modern-pixel-game-kit/ directory there." >&2
  exit 1
fi

# Create destination tree
mkdir -p "$DEST/tanks" "$DEST/infantry" "$DEST/air" "$DEST/effects"

# -- Helper: copy a single file, fail hard if source missing ------------------
copy_one() {
  local from="$1"
  local to="$2"
  if [[ ! -f "$from" ]]; then
    echo "ERROR: Missing source file: $from" >&2
    exit 2
  fi
  cp "$from" "$to"
  echo "  $(basename "$to")"
}

echo "Copying tanks..."
# --- Panzer (main_tank) ---
copy_one "$PACK1/Panzer/PanzerBase.png"                 "$DEST/tanks/panzer_body.png"
copy_one "$PACK1/Panzer/PanzerTower.png"                "$DEST/tanks/panzer_turret.png"
copy_one "$PACK1/Panzer/Panzer_Move/PanzerMove (1).png" "$DEST/tanks/panzer_move_01.png"
copy_one "$PACK1/Panzer/Panzer_Move/PanzerMove (2).png" "$DEST/tanks/panzer_move_02.png"
copy_one "$PACK1/Panzer/Panzer_Move/PanzerMove (3).png" "$DEST/tanks/panzer_move_03.png"
copy_one "$PACK1/Panzer/Panzer_Move/PanzerMove (4).png" "$DEST/tanks/panzer_move_04.png"

# --- BTR (light_tank) ---
copy_one "$PACK1/BTR/BTR_Base.png"               "$DEST/tanks/btr_body.png"
copy_one "$PACK1/BTR/BTR_Tower.png"              "$DEST/tanks/btr_turret.png"
copy_one "$PACK1/BTR/BTR_Move/BTR_Move01.png"    "$DEST/tanks/btr_move_01.png"
copy_one "$PACK1/BTR/BTR_Move/BTR_Move02.png"    "$DEST/tanks/btr_move_02.png"

# --- ACS (artillery) — from pack 2. 5 move frames in source. ---
copy_one "$PACK2/ACS/Source/ACS_Base.png"         "$DEST/tanks/acs_body.png"
copy_one "$PACK2/ACS/Source/ACS_Tower.png"        "$DEST/tanks/acs_turret.png"
copy_one "$PACK2/ACS/Move/ACS_move._01.png"       "$DEST/tanks/acs_move_01.png"
copy_one "$PACK2/ACS/Move/ACS_move._02.png"       "$DEST/tanks/acs_move_02.png"
copy_one "$PACK2/ACS/Move/ACS_move._03.png"       "$DEST/tanks/acs_move_03.png"
copy_one "$PACK2/ACS/Move/ACS_move._04.png"       "$DEST/tanks/acs_move_04.png"
copy_one "$PACK2/ACS/Move/ACS_move._05.png"       "$DEST/tanks/acs_move_05.png"

echo "Copying infantry..."
# --- Soldier (infantry) ---
copy_one "$PACK1/Soldier/Soldier.png"              "$DEST/infantry/soldier_idle.png"
copy_one "$PACK1/Soldier/Walk/SW_01.png"           "$DEST/infantry/soldier_walk_01.png"
copy_one "$PACK1/Soldier/Walk/SW_02.png"           "$DEST/infantry/soldier_walk_02.png"
copy_one "$PACK1/Soldier/Walk/SW_03.png"           "$DEST/infantry/soldier_walk_03.png"
copy_one "$PACK1/Soldier/Walk/SW_04.png"           "$DEST/infantry/soldier_walk_04.png"
copy_one "$PACK1/Soldier/Walk/SW_05.png"           "$DEST/infantry/soldier_walk_05.png"
copy_one "$PACK1/Soldier/Walk/SW_06.png"           "$DEST/infantry/soldier_walk_06.png"
copy_one "$PACK1/Soldier/Walk/SW_07.png"           "$DEST/infantry/soldier_walk_07.png"
copy_one "$PACK1/Soldier/Shot/Soldier Shot.png"    "$DEST/infantry/soldier_shot.png"

# --- Soldier 02 (elite_guard) ---
copy_one "$PACK1/Soldier 02/Soldier02.png"         "$DEST/infantry/elite_idle.png"
copy_one "$PACK1/Soldier 02/BAZOOKA.png"           "$DEST/infantry/elite_bazooka.png"
copy_one "$PACK1/Soldier 02/Fire/SF_01.png"        "$DEST/infantry/elite_fire_01.png"
copy_one "$PACK1/Soldier 02/Fire/SF_02.png"        "$DEST/infantry/elite_fire_02.png"
copy_one "$PACK1/Soldier 02/Fire/SF_03.png"        "$DEST/infantry/elite_fire_03.png"
copy_one "$PACK1/Soldier 02/Fire/SF_04.png"        "$DEST/infantry/elite_fire_04.png"
copy_one "$PACK1/Soldier 02/Fire/SF_05.png"        "$DEST/infantry/elite_fire_05.png"

# --- Hero (commander). Idle = Hero_Rifle. Walk cycle = Hero_Walk/With Kneepads/1-7. ---
copy_one "$PACK_HERO/Hero_Rifle/Hero_Rifle.png"              "$DEST/infantry/commander_idle.png"
copy_one "$PACK_HERO/Hero_Walk/With Kneepads/1.png"          "$DEST/infantry/commander_walk_01.png"
copy_one "$PACK_HERO/Hero_Walk/With Kneepads/2.png"          "$DEST/infantry/commander_walk_02.png"
copy_one "$PACK_HERO/Hero_Walk/With Kneepads/3.png"          "$DEST/infantry/commander_walk_03.png"
copy_one "$PACK_HERO/Hero_Walk/With Kneepads/4.png"          "$DEST/infantry/commander_walk_04.png"
copy_one "$PACK_HERO/Hero_Walk/With Kneepads/5.png"          "$DEST/infantry/commander_walk_05.png"
copy_one "$PACK_HERO/Hero_Walk/With Kneepads/6.png"          "$DEST/infantry/commander_walk_06.png"
copy_one "$PACK_HERO/Hero_Walk/With Kneepads/7.png"          "$DEST/infantry/commander_walk_07.png"

echo "Copying air (helicopter placeholder)..."
copy_one "$PACK2/Helicopter/Source/Helicopter_Source.png"    "$DEST/air/heli_body.png"
copy_one "$PACK2/Helicopter/Parts/Helicopter_Screw_4x.png"   "$DEST/air/heli_rotor.png"

echo "Copying effects..."
# --- Panzer muzzle flash (big) ---
copy_one "$PACK1/Effects/Panzer Fire/Panzer_fire1.png"   "$DEST/effects/muzzle_big_01.png"
copy_one "$PACK1/Effects/Panzer Fire/Panzer_fire2.png"   "$DEST/effects/muzzle_big_02.png"
copy_one "$PACK1/Effects/Panzer Fire/Panzer_fire3.png"   "$DEST/effects/muzzle_big_03.png"

# --- BTR muzzle flash (small) ---
copy_one "$PACK1/Effects/BTR Fire/BTR_Fire_01.png"       "$DEST/effects/muzzle_small_01.png"
copy_one "$PACK1/Effects/BTR Fire/BTR_Fire_02.png"       "$DEST/effects/muzzle_small_02.png"
copy_one "$PACK1/Effects/BTR Fire/BTR_Fire_03.png"       "$DEST/effects/muzzle_small_03.png"

# --- Smoke (death puff). 7 frames, ordered by the trailing "_N" in the source name. ---
copy_one "$PACK1/Effects/LightSmoke/Light-Smoke_0000s_0006_1.png"  "$DEST/effects/smoke_01.png"
copy_one "$PACK1/Effects/LightSmoke/Light-Smoke_0000s_0005_2.png"  "$DEST/effects/smoke_02.png"
copy_one "$PACK1/Effects/LightSmoke/Light-Smoke_0000s_0004_3.png"  "$DEST/effects/smoke_03.png"
copy_one "$PACK1/Effects/LightSmoke/Light-Smoke_0000s_0003_4.png"  "$DEST/effects/smoke_04.png"
copy_one "$PACK1/Effects/LightSmoke/Light-Smoke_0000s_0002_5.png"  "$DEST/effects/smoke_05.png"
copy_one "$PACK1/Effects/LightSmoke/Light-Smoke_0000s_0001_6.png"  "$DEST/effects/smoke_06.png"
copy_one "$PACK1/Effects/LightSmoke/Light-Smoke_0000s_0000_7.png"  "$DEST/effects/smoke_07.png"

# --- License ---
# CraftPix EULA: https://craftpix.net/file-licenses/
# Attribution stub instead of shipping the (empty) license.txt from the pack.
cat > "$DEST/LICENSE.txt" <<'EOF'
Sprites in this directory are derived from the CraftPix "Top Down Shooter: Modern Pixel Game Kit"
asset pack, purchased under the CraftPix standard commercial license.

Full license: https://craftpix.net/file-licenses/

Source .psd files and the raw unorganized asset pack are NOT redistributed here.
Only the PNG frames actually used at runtime are checked in, under the renaming scheme
documented in SPRITE_INTEGRATION_PLAN.md §2.
EOF
echo "  LICENSE.txt"

echo ""
echo "Done. Files under $DEST:"
find "$DEST" -type f | wc -l
