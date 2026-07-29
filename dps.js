/*
 * dps.js — OSRS DPS engine (part of the GPL-3.0 slayer calculator).
 *
 * Reimplemented from the standard, publicly documented OSRS combat formulas
 * (Bitterkoekje / OSRS Wiki "Damage per second" & "Combat formulas"). Formulas
 * are facts, not copied code. Computes max hit, hit chance and DPS for a
 * normalized loadout against a monster's defender stats (the `cb` block baked
 * into data.js by build-data.mjs).
 *
 * Loadout (L) — all fields optional unless noted, sensible defaults applied:
 *   style        'melee' | 'ranged' | 'magic'
 *   attackStyle  'stab'|'slash'|'crush' (melee) — picks the monster's defence bonus
 *   atk, str, ranged, magic   visible combat levels
 *   boost        { atk, str, ranged, magic }   flat potion level boosts
 *   prayer       { atk, str, ranged, magic }   multipliers (1 = none; Piety = 1.20 atk / 1.23 str)
 *   stance       { atk, str, ranged }          invisible +levels (accurate +3 atk, aggressive +3 str, controlled +1/+1, ranged-accurate +3 ranged)
 *   atkBonus     equipment attack bonus for the chosen style (or ranged/magic attack)
 *   strBonus     melee strength bonus, or ranged strength (for ranged)
 *   speed        weapon speed in ticks (default 4)
 *   accMult, dmgMult   multiplicative on-task/salve/bane bonuses (default 1)
 *   spellMax, magicDmg (magic only)  base spell max hit, and gear magic-damage fraction (0.1 = +10%)
 */
'use strict';
(function (root) {

  // effective level = floor((visible + potion) * prayer) + stance + constant
  // constant is 8 for melee/ranged, 9 for magic accuracy.
  function effLevel(visible, boost, prayerMult, stance, plus) {
    return Math.floor((visible + (boost || 0)) * (prayerMult || 1)) + (stance || 0) + (plus == null ? 8 : plus);
  }

  function meleeMaxHit(effStr, strBonus, dmgMult) {
    const base = Math.floor(0.5 + effStr * ((strBonus || 0) + 64) / 640);
    return Math.floor(base * (dmgMult || 1));
  }

  function attackRoll(effAtk, atkBonus, accMult) {
    return Math.floor(effAtk * ((atkBonus || 0) + 64) * (accMult || 1));
  }

  function defenceRoll(defLvl, defBonus) {
    return (defLvl + 9) * ((defBonus || 0) + 64);
  }

  // OSRS hit-chance from attack vs defence rolls
  function hitChance(atkRoll, defRoll) {
    return atkRoll > defRoll
      ? 1 - (defRoll + 2) / (2 * (atkRoll + 1))
      : atkRoll / (2 * (defRoll + 1));
  }

  function meleeDefBonus(cb, attackStyle) {
    return ({ stab: cb.dstab, slash: cb.dslash, crush: cb.dcrush })[attackStyle];
  }

  // Full computation. Returns { maxHit, accuracy, dps, avgDamage, interval }.
  function computeDps(L, cb) {
    const accMult = L.accMult || 1, dmgMult = L.dmgMult || 1;
    const b = L.boost || {}, p = L.prayer || {}, s = L.stance || {};
    let effAtk, atkBonus, maxHit, defLvl, defBonus;

    if (L.style === 'magic') {
      effAtk = effLevel(L.magic || 1, b.magic, p.magic, s.magic, 9);
      atkBonus = L.atkBonus || 0;
      // elemental weakness: matching-element spell adds weakPct% to magic damage
      let weak = 0;
      if (L.spellElement && cb && cb.weakType === L.spellElement && cb.weakPct) weak = cb.weakPct / 100;
      maxHit = Math.floor((L.spellMax || 0) * (1 + (L.magicDmg || 0) + weak) * dmgMult);
      defLvl = cb && cb.mage != null ? cb.mage : (cb ? cb.def : 1);
      defBonus = cb ? cb.dmagic : 0;
    } else if (L.style === 'ranged') {
      // accuracy and damage can carry different prayer/stance bonuses (e.g. Rigour: +20% acc, +23% dmg)
      effAtk = effLevel(L.ranged || 1, b.ranged, p.ranged, s.ranged, 8);
      const effStr = effLevel(L.ranged || 1, b.ranged, p.rangedStr != null ? p.rangedStr : p.ranged, s.rangedStr != null ? s.rangedStr : s.ranged, 8);
      maxHit = meleeMaxHit(effStr, L.strBonus, dmgMult); // ranged uses the same max-hit shape with ranged strength
      atkBonus = L.atkBonus || 0;
      defLvl = cb ? cb.def : 1;
      defBonus = cb ? cb.drange : 0;
    } else { // melee
      const effStr = effLevel(L.str || 1, b.str, p.str, s.str, 8);
      effAtk = effLevel(L.atk || 1, b.atk, p.atk, s.atk, 8);
      maxHit = meleeMaxHit(effStr, L.strBonus, dmgMult);
      atkBonus = L.atkBonus || 0;
      defLvl = cb ? cb.def : 1;
      defBonus = cb ? meleeDefBonus(cb, L.attackStyle) : 0;
    }

    const aRoll = attackRoll(effAtk, atkBonus, accMult);
    const dRoll = defenceRoll(defLvl == null ? 1 : defLvl, defBonus);
    const accuracy = hitChance(aRoll, dRoll);
    const interval = (L.speed || 4) * 0.6;
    const avgDamage = accuracy * (maxHit / 2);
    return { maxHit, accuracy, dps: avgDamage / interval, avgDamage, interval, atkRoll: aRoll, defRoll: dRoll };
  }

  // time (seconds) to kill a monster of `hp` hitpoints at this dps (always-in-combat)
  function timeToKill(hp, dps) { return dps > 0 ? hp / dps : Infinity; }

  const api = { effLevel, meleeMaxHit, attackRoll, defenceRoll, hitChance, meleeDefBonus, computeDps, timeToKill };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DPS = api;
})(typeof self !== 'undefined' ? self : this);
