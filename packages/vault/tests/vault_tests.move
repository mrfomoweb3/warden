#[test_only]
module spend_vault::vault_tests;

use spend_vault::vault::{Self, Vault, OwnerCap, WardenCap, SpenderCap};
use sui::clock;
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const OWNER: address = @0xA;
const WARDEN: address = @0xB;
const AGENT: address = @0xC;
const API: address = @0xD;

fun setup(): Scenario {
    let mut sc = ts::begin(OWNER);
    {
        let cap = vault::new<SUI>(sc.ctx());
        transfer::public_transfer(cap, OWNER);
    };
    sc.next_tx(OWNER);
    {
        let owner = sc.take_from_sender<OwnerCap>();
        let mut v = sc.take_shared<Vault<SUI>>();
        let w = vault::appoint_warden(&owner, &mut v, sc.ctx());
        transfer::public_transfer(w, WARDEN);
        let s = vault::add_agent(&owner, &mut v, b"rogue".to_string(), 100, 250, AGENT, sc.ctx());
        transfer::public_transfer(s, AGENT);
        vault::deposit(&mut v, coin::mint_for_testing<SUI>(1_000, sc.ctx()));
        ts::return_shared(v);
        sc.return_to_sender(owner);
    };
    sc
}

fun spend(sc: &mut Scenario, amount: u64, now_ms: u64): bool {
    sc.next_tx(AGENT);
    let cap = sc.take_from_sender<SpenderCap>();
    let mut v = sc.take_shared<Vault<SUI>>();
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(now_ms);
    let ok = vault::spend(&cap, &mut v, amount, API, b"nonce", &clk, sc.ctx());
    clk.destroy_for_testing();
    ts::return_shared(v);
    sc.return_to_sender(cap);
    ok
}

fun agent_id(sc: &mut Scenario): ID {
    sc.next_tx(AGENT);
    let cap = sc.take_from_sender<SpenderCap>();
    let id = object::id(&cap);
    sc.return_to_sender(cap);
    id
}

#[test]
fun spend_pays_recipient_and_tracks_daily() {
    let mut sc = setup();
    assert!(spend(&mut sc, 60, 1_000));
    assert!(spend(&mut sc, 60, 2_000));
    sc.next_tx(API);
    let c = sc.take_from_sender<Coin<SUI>>();
    assert!(c.value() == 60);
    sc.return_to_sender(c);
    let v = sc.take_shared<Vault<SUI>>();
    assert!(vault::balance(&v) == 880);
    ts::return_shared(v);
    sc.end();
}

#[test]
fun per_tx_and_daily_caps_reject_without_paying() {
    let mut sc = setup();
    assert!(!spend(&mut sc, 101, 1_000)); // per-tx
    assert!(spend(&mut sc, 100, 1_000));
    assert!(spend(&mut sc, 100, 1_000));
    assert!(!spend(&mut sc, 100, 1_000)); // daily (300 > 250)
    // next day resets
    assert!(spend(&mut sc, 100, 86_400_000 + 1));
    let v = { sc.next_tx(OWNER); sc.take_shared<Vault<SUI>>() };
    assert!(vault::balance(&v) == 700);
    ts::return_shared(v);
    sc.end();
}

#[test]
fun warden_pause_blocks_and_is_idempotent() {
    let mut sc = setup();
    let id = agent_id(&mut sc);
    sc.next_tx(WARDEN);
    {
        let w = sc.take_from_sender<WardenCap>();
        let mut v = sc.take_shared<Vault<SUI>>();
        vault::pause_agent(&w, &mut v, id, b"loop");
        vault::pause_agent(&w, &mut v, id, b"loop"); // no-op
        assert!(vault::is_paused(&vault::agent_state(&v, id)));
        ts::return_shared(v);
        sc.return_to_sender(w);
    };
    assert!(!spend(&mut sc, 10, 1_000));
    sc.next_tx(WARDEN);
    {
        let w = sc.take_from_sender<WardenCap>();
        let mut v = sc.take_shared<Vault<SUI>>();
        vault::unpause_agent(&w, &mut v, id);
        ts::return_shared(v);
        sc.return_to_sender(w);
    };
    assert!(spend(&mut sc, 10, 1_000));
    sc.end();
}

#[test]
fun warden_can_tighten_within_ceiling() {
    let mut sc = setup();
    let id = agent_id(&mut sc);
    sc.next_tx(WARDEN);
    {
        let w = sc.take_from_sender<WardenCap>();
        let mut v = sc.take_shared<Vault<SUI>>();
        vault::set_caps(&w, &mut v, id, 20, 50);
        let s = vault::agent_state(&v, id);
        assert!(vault::per_tx_cap(&s) == 20 && vault::daily_cap(&s) == 50);
        ts::return_shared(v);
        sc.return_to_sender(w);
    };
    assert!(!spend(&mut sc, 21, 1_000));
    assert!(spend(&mut sc, 20, 1_000));
    sc.end();
}

#[test, expected_failure(abort_code = vault::EAboveCeiling)]
fun warden_cannot_exceed_ceiling() {
    let mut sc = setup();
    let id = agent_id(&mut sc);
    sc.next_tx(WARDEN);
    let w = sc.take_from_sender<WardenCap>();
    let mut v = sc.take_shared<Vault<SUI>>();
    vault::set_caps(&w, &mut v, id, 101, 50);
    abort 99
}

#[test, expected_failure(abort_code = vault::ENotActiveWarden)]
fun rotated_warden_is_revoked() {
    let mut sc = setup();
    let id = agent_id(&mut sc);
    sc.next_tx(OWNER);
    {
        let owner = sc.take_from_sender<OwnerCap>();
        let mut v = sc.take_shared<Vault<SUI>>();
        let w2 = vault::appoint_warden(&owner, &mut v, sc.ctx());
        transfer::public_transfer(w2, OWNER);
        ts::return_shared(v);
        sc.return_to_sender(owner);
    };
    sc.next_tx(WARDEN);
    let old = sc.take_from_sender<WardenCap>();
    let mut v = sc.take_shared<Vault<SUI>>();
    vault::pause_agent(&old, &mut v, id, b"x");
    abort 99
}

#[test]
fun owner_withdraws() {
    let mut sc = setup();
    sc.next_tx(OWNER);
    let owner = sc.take_from_sender<OwnerCap>();
    let mut v = sc.take_shared<Vault<SUI>>();
    let c = vault::withdraw(&owner, &mut v, 400, sc.ctx());
    assert!(c.value() == 400 && vault::balance(&v) == 600);
    transfer::public_transfer(c, OWNER);
    ts::return_shared(v);
    sc.return_to_sender(owner);
    sc.end();
}
