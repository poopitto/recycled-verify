import json


CONTRACT = "backend/recycled-verify.py"
MIN_BOND = 5_000_000_000_000_000
CERT_A = "https://certifier.example.org/lots/pet-a"
LAB_B = "https://lab.example.net/reports/pet-a"


def _deploy(direct_vm, direct_deploy, owner):
    direct_vm.sender = owner
    direct_vm.value = 0
    return direct_deploy(CONTRACT)


def _register(contract, direct_vm, claimant, label="PCR-PET-A", mass=1000, claimed=850, parents="", bond=MIN_BOND):
    direct_vm.sender = claimant
    direct_vm.value = bond
    lot_id = contract.register_lot(label, "PET", "EU", mass, claimed, parents)
    direct_vm.value = 0
    return int(lot_id)


def _trace():
    return (
        "Chain-of-custody trace for PCR-PET-A: certificate COC-2026-001, "
        "audit date 2026-07-01, lot mass and recycled mass figures listed."
    )


def _evidence_urls():
    return CERT_A + "\n" + LAB_B


def _submit(contract, direct_vm, claimant, lot_id):
    direct_vm.sender = claimant
    contract.submit_trace(lot_id, _trace(), _evidence_urls())


def _mock_external_evidence(direct_vm):
    cert_body = (
        "Certifier registry record COC-2026-001 for PCR-PET-A. Material PET, "
        "audit date 2026-07-01, lot mass 1000 kg, post-consumer recycled mass 850 kg."
    )
    lab_body = (
        "Independent lab report for PCR-PET-A confirms PET recycled-content "
        "claim, no virgin substitution, 85 percent recycled content for the same period."
    )
    direct_vm.mock_web(CERT_A.replace(".", r"\."), {"status": 200, "body": cert_body})
    direct_vm.mock_web(LAB_B.replace(".", r"\."), {"status": 200, "body": lab_body})


def _mock_t1(direct_vm, pct=85, evidence_verified=True):
    direct_vm.mock_llm(
        r"[\s\S]*POST-CONSUMER recycled-content claim[\s\S]*",
        json.dumps(
            {
                "evidence_verified": evidence_verified,
                "sources_confirmed": 2 if evidence_verified else 1,
                "recycled_pct": pct,
                "verification_summary": "Certifier and lab records match the same lot, material, date, and mass.",
                "rationale": "External records confirm 850/1000 kg post-consumer recycled content.",
            }
        ),
    )


def _mock_t2(direct_vm, pct=82, evidence_verified=True):
    direct_vm.mock_llm(
        r"[\s\S]*DEEP audit \(T2\)[\s\S]*",
        json.dumps(
            {
                "evidence_verified": evidence_verified,
                "sources_confirmed": 2 if evidence_verified else 1,
                "recycled_pct": pct,
                "verification_summary": "Deep review confirms both external records remain concordant.",
                "rationale": "T2 confirms certificates, lab report, and parent capacity.",
            }
        ),
    )


def _capture_transfers(direct_vm):
    calls = []

    def hook(_vm, request):
        calls.append(request)
        return None

    direct_vm._gl_call_hook = hook
    return calls


def test_trace_requires_independent_public_evidence(direct_vm, direct_deploy, direct_owner, direct_alice):
    contract = _deploy(direct_vm, direct_deploy, direct_owner)
    lot_id = _register(contract, direct_vm, direct_alice)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("evidence sources must use https://"):
        contract.submit_trace(lot_id, _trace(), "http://certifier.example.org/a\nhttps://lab.example.net/b")

    with direct_vm.expect_revert("evidence sources must use independent hosts"):
        contract.submit_trace(lot_id, _trace(), "https://same.example.org/a\nhttps://same.example.org/b")

    _submit(contract, direct_vm, direct_alice, lot_id)
    card = contract.get_lot(lot_id)
    assert card["status"] == 1
    assert card["evidence_digest"] != ""
    assert card["evidence_verified"] is False


def test_t1_fetches_external_evidence_and_refund_is_retryable(direct_vm, direct_deploy, direct_owner, direct_alice):
    contract = _deploy(direct_vm, direct_deploy, direct_owner)
    lot_id = _register(contract, direct_vm, direct_alice)
    _submit(contract, direct_vm, direct_alice, lot_id)

    contract.verify_mass_balance(lot_id)
    _mock_external_evidence(direct_vm)
    _mock_t1(direct_vm, pct=85, evidence_verified=True)
    contract.adjudicate(lot_id)
    direct_vm.clear_mocks()

    card = contract.get_lot(lot_id)
    assert card["status"] == 3
    assert card["ruling"] == "VERIFIED"
    assert card["evidence_verified"] is True
    assert card["evidence_sources_confirmed"] == 2

    def fail_transfer(_vm, _request):
        raise RuntimeError("simulated bond refund failure")

    direct_vm._gl_call_hook = fail_transfer
    with direct_vm.expect_revert("simulated bond refund failure"):
        contract.issue_label(lot_id)
    assert contract.get_lot(lot_id)["status"] == 3
    assert contract.get_lot(lot_id)["bond_wei"] == str(MIN_BOND)
    assert contract.get_pool_balance() == str(MIN_BOND)

    transfers = _capture_transfers(direct_vm)
    contract.issue_label(lot_id)
    assert len(transfers) == 1
    final_card = contract.get_lot(lot_id)
    assert final_card["status"] == 5
    assert final_card["label_issued"] is True
    assert final_card["bond_wei"] == "0"
    assert contract.get_pool_balance() == "0"


def test_high_value_lot_requires_t2_with_external_evidence(direct_vm, direct_deploy, direct_owner, direct_alice):
    contract = _deploy(direct_vm, direct_deploy, direct_owner)
    lot_id = _register(contract, direct_vm, direct_alice, label="PCR-PET-HIGH", mass=6000, claimed=5000)
    _submit(contract, direct_vm, direct_alice, lot_id)
    contract.verify_mass_balance(lot_id)

    _mock_external_evidence(direct_vm)
    _mock_t1(direct_vm, pct=84, evidence_verified=True)
    contract.adjudicate(lot_id)
    direct_vm.clear_mocks()

    with direct_vm.expect_revert("high-value lots require T2"):
        contract.issue_label(lot_id)

    _mock_external_evidence(direct_vm)
    _mock_t2(direct_vm, pct=82, evidence_verified=True)
    contract.adjudicate_deep(lot_id)
    direct_vm.clear_mocks()

    card = contract.get_lot(lot_id)
    assert card["status"] == 4
    assert card["recycled_pct_t2"] == 82
    assert card["evidence_verified"] is True


def test_mass_balance_failure_can_cascade_to_descendants(direct_vm, direct_deploy, direct_owner, direct_alice):
    contract = _deploy(direct_vm, direct_deploy, direct_owner)
    root_id = _register(contract, direct_vm, direct_alice, label="ROOT-PET", mass=100, claimed=100)
    bad_parent_id = _register(contract, direct_vm, direct_alice, label="OVERCLAIM-PET", mass=200, claimed=150, parents=str(root_id), bond=MIN_BOND * 3)
    child_id = _register(contract, direct_vm, direct_alice, label="DOWNSTREAM-PET", mass=100, claimed=90, parents=str(bad_parent_id), bond=MIN_BOND * 5)

    _submit(contract, direct_vm, direct_alice, root_id)
    contract.verify_mass_balance(root_id)
    _submit(contract, direct_vm, direct_alice, bad_parent_id)
    _submit(contract, direct_vm, direct_alice, child_id)
    contract.verify_mass_balance(child_id)
    assert contract.get_lot(child_id)["status"] == 2

    contract.verify_mass_balance(bad_parent_id)
    assert contract.get_lot(bad_parent_id)["status"] == 6

    result = contract.cascade_flag_descendants(bad_parent_id)
    assert result["descendants_flagged"] == 1
    child = contract.get_lot(child_id)
    assert child["status"] == 7
    assert child["ruling"] == "DEPENDENCY_FLAGGED"
    assert child["ancestor_flag_source"] == bad_parent_id
