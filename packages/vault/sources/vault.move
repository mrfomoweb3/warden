/// SpendVault: holds an allowance for a set of AI agents and lets a watchdog
/// (Warden) pause them or tighten their caps without touching the funds.
///
/// Roles
/// - `OwnerCap`  (human): adds agents, sets per-agent ceilings, withdraws, appoints the warden.
/// - `WardenCap` (Warden): pauses/unpauses agents and sets caps *within* the owner's ceilings.
/// - `SpenderCap` (one per agent): spends, subject to per-tx cap, daily cap and pause flag.
///
/// Spends that violate a limit do not abort: they emit `SpendRejected` and move no
/// funds, so the watchdog can see a paused agent still hammering the vault.
module spend_vault::vault;

use std::string::String;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::table::{Self, Table};

// === Errors ===

const EWrongVault: u64 = 0;
const ENotActiveWarden: u64 = 1;
const EUnknownAgent: u64 = 2;
const EAboveCeiling: u64 = 3;
const EInsufficientFunds: u64 = 4;
const EZeroAmount: u64 = 5;

// === Rejection reasons (SpendRejected.reason) ===

const REJECT_PAUSED: u8 = 1;
const REJECT_PER_TX: u8 = 2;
const REJECT_DAILY: u8 = 3;
const REJECT_FUNDS: u8 = 4;

const MS_PER_DAY: u64 = 86_400_000;

// === Objects ===

public struct Vault<phantom T> has key {
    id: UID,
    funds: Balance<T>,
    /// Keyed by the agent's SpenderCap ID.
    agents: Table<ID, AgentState>,
    /// Only this WardenCap may act; the owner can rotate it.
    warden: Option<ID>,
}

public struct AgentState has store, copy, drop {
    label: String,
    per_tx_cap: u64,
    daily_cap: u64,
    /// Owner-set ceilings; the warden can only move caps at or below these.
    max_per_tx: u64,
    max_daily: u64,
    spent_today: u64,
    day: u64,
    paused: bool,
}

public struct OwnerCap has key, store { id: UID, vault_id: ID }

public struct WardenCap has key, store { id: UID, vault_id: ID }

public struct SpenderCap has key, store { id: UID, vault_id: ID }

// === Events ===

public struct VaultCreated has copy, drop { vault_id: ID, owner: address }

public struct AgentAdded has copy, drop {
    vault_id: ID,
    agent: ID,
    label: String,
    spender: address,
    per_tx_cap: u64,
    daily_cap: u64,
}

public struct Deposited has copy, drop { vault_id: ID, amount: u64, balance: u64 }

public struct Withdrawn has copy, drop { vault_id: ID, amount: u64, balance: u64 }

public struct Spent has copy, drop {
    vault_id: ID,
    agent: ID,
    label: String,
    recipient: address,
    amount: u64,
    memo: vector<u8>,
    spent_today: u64,
    timestamp_ms: u64,
}

public struct SpendRejected has copy, drop {
    vault_id: ID,
    agent: ID,
    label: String,
    recipient: address,
    amount: u64,
    reason: u8,
    timestamp_ms: u64,
}

public struct AgentPaused has copy, drop { vault_id: ID, agent: ID, label: String, reason: vector<u8> }

public struct AgentUnpaused has copy, drop { vault_id: ID, agent: ID, label: String }

public struct CapsChanged has copy, drop {
    vault_id: ID,
    agent: ID,
    label: String,
    per_tx_cap: u64,
    daily_cap: u64,
}

public struct WardenSet has copy, drop { vault_id: ID, warden_cap: ID }

// === Owner ===

/// Creates and shares a vault; returns the OwnerCap.
public fun new<T>(ctx: &mut TxContext): OwnerCap {
    let vault = Vault<T> {
        id: object::new(ctx),
        funds: balance::zero(),
        agents: table::new(ctx),
        warden: option::none(),
    };
    let vault_id = object::id(&vault);
    event::emit(VaultCreated { vault_id, owner: ctx.sender() });
    transfer::share_object(vault);
    OwnerCap { id: object::new(ctx), vault_id }
}

entry fun create<T>(ctx: &mut TxContext) {
    let cap = new<T>(ctx);
    transfer::public_transfer(cap, ctx.sender());
}

/// Mints a WardenCap and makes it the only active one (revoking any previous).
public fun appoint_warden<T>(owner: &OwnerCap, vault: &mut Vault<T>, ctx: &mut TxContext): WardenCap {
    assert!(owner.vault_id == object::id(vault), EWrongVault);
    let cap = WardenCap { id: object::new(ctx), vault_id: object::id(vault) };
    vault.warden = option::some(object::id(&cap));
    event::emit(WardenSet { vault_id: object::id(vault), warden_cap: object::id(&cap) });
    cap
}

entry fun appoint_warden_to<T>(owner: &OwnerCap, vault: &mut Vault<T>, recipient: address, ctx: &mut TxContext) {
    let cap = appoint_warden(owner, vault, ctx);
    transfer::public_transfer(cap, recipient);
}

/// Registers an agent and returns its SpenderCap. Caps start at the ceilings.
public fun add_agent<T>(
    owner: &OwnerCap,
    vault: &mut Vault<T>,
    label: String,
    max_per_tx: u64,
    max_daily: u64,
    spender: address,
    ctx: &mut TxContext,
): SpenderCap {
    assert!(owner.vault_id == object::id(vault), EWrongVault);
    let cap = SpenderCap { id: object::new(ctx), vault_id: object::id(vault) };
    let agent = object::id(&cap);
    vault.agents.add(agent, AgentState {
        label,
        per_tx_cap: max_per_tx,
        daily_cap: max_daily,
        max_per_tx,
        max_daily,
        spent_today: 0,
        day: 0,
        paused: false,
    });
    event::emit(AgentAdded {
        vault_id: object::id(vault),
        agent,
        label,
        spender,
        per_tx_cap: max_per_tx,
        daily_cap: max_daily,
    });
    cap
}

entry fun add_agent_to<T>(
    owner: &OwnerCap,
    vault: &mut Vault<T>,
    label: String,
    max_per_tx: u64,
    max_daily: u64,
    spender: address,
    ctx: &mut TxContext,
) {
    let cap = add_agent(owner, vault, label, max_per_tx, max_daily, spender, ctx);
    transfer::public_transfer(cap, spender);
}

/// Raises or lowers an agent's ceilings; current caps are clamped to them.
public fun set_ceilings<T>(owner: &OwnerCap, vault: &mut Vault<T>, agent: ID, max_per_tx: u64, max_daily: u64) {
    assert!(owner.vault_id == object::id(vault), EWrongVault);
    assert!(vault.agents.contains(agent), EUnknownAgent);
    let s = &mut vault.agents[agent];
    s.max_per_tx = max_per_tx;
    s.max_daily = max_daily;
    if (s.per_tx_cap > max_per_tx) s.per_tx_cap = max_per_tx;
    if (s.daily_cap > max_daily) s.daily_cap = max_daily;
}

/// The owner can always unpause, even without a warden.
public fun owner_unpause<T>(owner: &OwnerCap, vault: &mut Vault<T>, agent: ID) {
    assert!(owner.vault_id == object::id(vault), EWrongVault);
    unpause_internal(vault, agent);
}

public fun withdraw<T>(owner: &OwnerCap, vault: &mut Vault<T>, amount: u64, ctx: &mut TxContext): Coin<T> {
    assert!(owner.vault_id == object::id(vault), EWrongVault);
    assert!(vault.funds.value() >= amount, EInsufficientFunds);
    let c = coin::take(&mut vault.funds, amount, ctx);
    event::emit(Withdrawn { vault_id: object::id(vault), amount, balance: vault.funds.value() });
    c
}

// === Anyone ===

public fun deposit<T>(vault: &mut Vault<T>, c: Coin<T>) {
    let amount = c.value();
    assert!(amount > 0, EZeroAmount);
    vault.funds.join(c.into_balance());
    event::emit(Deposited { vault_id: object::id(vault), amount, balance: vault.funds.value() });
}

// === Warden ===

/// Idempotent: pausing a paused agent is a no-op and emits nothing.
public fun pause_agent<T>(warden: &WardenCap, vault: &mut Vault<T>, agent: ID, reason: vector<u8>) {
    assert_warden(warden, vault);
    assert!(vault.agents.contains(agent), EUnknownAgent);
    let vault_id = object::id(vault);
    let s = &mut vault.agents[agent];
    if (s.paused) return;
    s.paused = true;
    event::emit(AgentPaused { vault_id, agent, label: s.label, reason });
}

/// Idempotent: unpausing an active agent is a no-op and emits nothing.
public fun unpause_agent<T>(warden: &WardenCap, vault: &mut Vault<T>, agent: ID) {
    assert_warden(warden, vault);
    unpause_internal(vault, agent);
}

/// Idempotent: setting the same caps again emits nothing.
public fun set_caps<T>(warden: &WardenCap, vault: &mut Vault<T>, agent: ID, per_tx_cap: u64, daily_cap: u64) {
    assert_warden(warden, vault);
    assert!(vault.agents.contains(agent), EUnknownAgent);
    let vault_id = object::id(vault);
    let s = &mut vault.agents[agent];
    assert!(per_tx_cap <= s.max_per_tx && daily_cap <= s.max_daily, EAboveCeiling);
    if (s.per_tx_cap == per_tx_cap && s.daily_cap == daily_cap) return;
    s.per_tx_cap = per_tx_cap;
    s.daily_cap = daily_cap;
    event::emit(CapsChanged { vault_id, agent, label: s.label, per_tx_cap, daily_cap });
}

// === Agent ===

/// Pays `recipient` from the vault. Returns true if paid; on a limit violation
/// emits `SpendRejected`, moves nothing, and returns false.
/// `memo` carries the x402 challenge nonce so the paid API can bind the payment.
public fun spend<T>(
    spender: &SpenderCap,
    vault: &mut Vault<T>,
    amount: u64,
    recipient: address,
    memo: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): bool {
    assert!(spender.vault_id == object::id(vault), EWrongVault);
    assert!(amount > 0, EZeroAmount);
    let agent = object::id(spender);
    assert!(vault.agents.contains(agent), EUnknownAgent);
    let vault_id = object::id(vault);
    let now = clock.timestamp_ms();
    let available = vault.funds.value();
    let s = &mut vault.agents[agent];

    let today = now / MS_PER_DAY;
    if (s.day != today) {
        s.day = today;
        s.spent_today = 0;
    };

    let reason = if (s.paused) REJECT_PAUSED
    else if (amount > s.per_tx_cap) REJECT_PER_TX
    else if (s.spent_today + amount > s.daily_cap) REJECT_DAILY
    else if (amount > available) REJECT_FUNDS
    else 0;

    if (reason != 0) {
        event::emit(SpendRejected { vault_id, agent, label: s.label, recipient, amount, reason, timestamp_ms: now });
        return false
    };

    s.spent_today = s.spent_today + amount;
    let label = s.label;
    let spent_today = s.spent_today;
    transfer::public_transfer(coin::take(&mut vault.funds, amount, ctx), recipient);
    event::emit(Spent { vault_id, agent, label, recipient, amount, memo, spent_today, timestamp_ms: now });
    true
}

// === Views ===

public fun balance<T>(vault: &Vault<T>): u64 { vault.funds.value() }

public fun agent_state<T>(vault: &Vault<T>, agent: ID): AgentState { vault.agents[agent] }

public fun is_paused(s: &AgentState): bool { s.paused }

public fun per_tx_cap(s: &AgentState): u64 { s.per_tx_cap }

public fun daily_cap(s: &AgentState): u64 { s.daily_cap }

public fun spent_today(s: &AgentState): u64 { s.spent_today }

// === Internal ===

fun assert_warden<T>(warden: &WardenCap, vault: &Vault<T>) {
    assert!(warden.vault_id == object::id(vault), EWrongVault);
    assert!(vault.warden == option::some(object::id(warden)), ENotActiveWarden);
}

fun unpause_internal<T>(vault: &mut Vault<T>, agent: ID) {
    assert!(vault.agents.contains(agent), EUnknownAgent);
    let vault_id = object::id(vault);
    let s = &mut vault.agents[agent];
    if (!s.paused) return;
    s.paused = false;
    event::emit(AgentUnpaused { vault_id, agent, label: s.label });
}
