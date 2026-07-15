// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title  RedemptionDistributor (GIP-151 — claim phase)
/// @notice GIP-151 proposal (Snapshot): https://snapshot.org/#/s:gnosis.eth/proposal/0x657fbf8892200d24e887c68245cee73b59c466394192be1c10673b39814c74c4
/// @notice Pull-claim distributor for the post-window redemption basket. ONE leaf per holder encodes
///         that holder's full multi-asset entitlement, so a single claim() transfers the ENTIRE basket
///         (all payout tokens) in one transaction.
/// @dev    Deliberately minimal, admin-free, immutable — same philosophy as RedemptionDeposit:
///         - The Merkle root, the canonical payout-token set, the per-token totals, and the funding
///           `safe` are committed at deploy (and published in the claim manifest). No setRoot, no owner,
///           no upgrade, no pause.
///         - SAFE CUSTODY. The basket never enters this contract. It stays in the redemption Safe, which
///           funds the distributor by APPROVING it (ERC20 allowance) for each committed total; claim()
///           then pulls the holder's legs Safe -> holder via transferFrom. Anyone may call activate(),
///           which opens claims ONLY once the Safe both holds >= and has approved >= every committed
///           total. Because funds stay in the Safe, the Safe (GnosisDAO multisig) keeps custody for
///           issue/emergency handling: setting a token's allowance to 0 halts claims of that token,
///           re-approving resumes them — no distributor redeploy, no admin role here.
///         - No claim deadline. There is intentionally NO sweep/recovery: an unclaimed basket stays
///           claimable forever (it simply remains in the Safe). A residual sunset is a governance
///           decision and is deliberately NOT built in here (adding it would require an admin/timelock —
///           out of scope, keep it trustless).
///
///         Payout-token assumptions & accepted trade-offs — the basket MUST be curated to honor these;
///         NONE are enforced on-chain:
///         - STANDARD ERC20s ONLY. Each payout token is assumed standard: non-fee-on-transfer,
///           non-rebasing, honoring standard allowance/transferFrom semantics.
///         - ACTIVATE IS A POINT-IN-TIME READINESS CHECK, NOT A DURABLE SOLVENCY GUARANTEE. activate()
///           checks the Safe's balance and allowance once, at that instant; both can drop afterward (the
///           intended emergency lever, or an ordinary Safe spend), reverting affected claims until the
///           Safe restores balance/approval. This weaker guarantee — versus escrowing the basket in the
///           contract — is the deliberate price of leaving custody with the Safe.
///         - ATOMIC, ALL-OR-NOTHING CLAIM (intentional). claim() pays a holder's whole basket in one call
///           and succeeds only if EVERY leg transfers. If any single payout token blocks transfer to a
///           holder (per-recipient blocklist/allowlist, pause, or non-transferable) — or the Safe lacks
///           balance/allowance for that leg — that holder can claim NO leg, including the healthy ones,
///           until the condition clears. This is deliberate: one leaf = one atomic basket transfer keeps
///           claims minimal and the contract trustless. It is a curation requirement — include only
///           tokens that cannot restrict transfers to a holder (in particular, none with a governance
///           transfer switch).
///         - SINGLE-USE ROOT (no domain separation). The leaf commits to (account, amounts) only — no
///           chainId, no contract address — so a published proof is valid against ANY distributor
///           carrying the same root. Deploy a given root to EXACTLY ONE distributor; never reuse it.
///         - ROOT WELL-FORMEDNESS IS A DEPLOY-TIME INVARIANT. This contract validates the token set
///           (non-zero, unique, <= MAX_PAYOUT_TOKENS) but treats the root as opaque: it does NOT verify
///           one-leaf-per-holder, conservation (a token's leaves must sum to payoutTotal), or that no
///           leaf is issued to address(0). Those are guaranteed by DeployDistributor.s.sol, which
///           re-derives the root, rejects duplicate/unsorted/zero-address holders, and asserts
///           conservation + solvency before broadcast. A distributor deployed with a malformed root
///           (bypassing that script) can lock a duplicate holder's second allocation or burn an
///           address(0) leaf.
///
///         Leaf format (must match the off-chain builder, e.g. OZ StandardMerkleTree with leaf encoding
///         ['address','uint256[]']):
///             leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amounts))))
///         where amounts[i] is `account`'s entitlement for payoutTokens()[i] (same order, same length).
contract RedemptionDistributor {
    using SafeERC20 for IERC20;

    /// @notice GIP-151 is a one-off redemption with a small basket (expected <=5 legs).
    ///         This hard cap leaves limited operational slack while preventing gas-bricked claims.
    uint256 public constant MAX_PAYOUT_TOKENS = 10;

    /// @notice Merkle root over all holder leaves. Immutable; published with the claim manifest.
    bytes32 public immutable merkleRoot;

    /// @notice The redemption Safe that custodies the basket. claim() pulls each leg from here via
    ///         transferFrom, so the Safe must keep an allowance to this contract for every payout token.
    address public immutable safe;

    /// @notice Canonical, ordered payout-token set. Leaf `amounts` are aligned to this order.
    address[] private _payoutTokens;
    /// @notice Committed total to be distributed per payout token (sum of all leaves for that token).
    mapping(address token => uint256 total) public payoutTotal;
    /// @notice Whether an account has already claimed its basket.
    mapping(address account => bool claimed) public hasClaimed;
    /// @notice Claims are only open once the Safe holds and has approved >= every committed total.
    bool public activated;

    event Activated();
    event Claimed(address indexed account, uint256[] amounts);

    error AlreadyActivated();
    error NotActivated();
    error AlreadyClaimed();
    error InvalidProof();
    error LengthMismatch();
    error UnderFunded(address token);
    error NotApproved(address token);

    constructor(bytes32 merkleRoot_, address[] memory tokens, uint256[] memory totals, address safe_) {
        require(merkleRoot_ != bytes32(0), "zero root");
        require(safe_ != address(0), "zero safe");
        require(tokens.length > 0, "empty basket");
        require(tokens.length <= MAX_PAYOUT_TOKENS, "too many tokens");
        require(tokens.length == totals.length, "length mismatch");
        merkleRoot = merkleRoot_;
        safe = safe_;
        for (uint256 i = 0; i < tokens.length; i++) {
            address t = tokens[i];
            require(t != address(0), "zero token");
            require(totals[i] > 0, "zero total");
            require(payoutTotal[t] == 0, "duplicate token");
            _payoutTokens.push(t);
            payoutTotal[t] = totals[i];
        }
    }

    /// @notice The ordered payout-token set; leaf `amounts` align to this.
    function payoutTokens() external view returns (address[] memory) {
        return _payoutTokens;
    }

    /// @notice Open claims. Permissionless, but reverts unless the Safe both holds and has approved this
    ///         contract for the full committed basket of every token — so claims cannot open before the
    ///         Safe is funded and approved.
    /// @dev    A point-in-time readiness check, not a durable guarantee: the Safe's balance and allowance
    ///         are read once, here, and can drop afterward (see the contract NatSpec). `UnderFunded` and
    ///         `NotApproved` are distinct so ops can tell "Safe doesn't hold enough" from "Safe holds it
    ///         but hasn't approved".
    function activate() external {
        if (activated) revert AlreadyActivated();
        uint256 n = _payoutTokens.length;
        for (uint256 i = 0; i < n; i++) {
            address t = _payoutTokens[i];
            uint256 total = payoutTotal[t];
            if (IERC20(t).balanceOf(safe) < total) revert UnderFunded(t);
            if (IERC20(t).allowance(safe, address(this)) < total) revert NotApproved(t);
        }
        activated = true;
        emit Activated();
    }

    /// @notice Claim `account`'s full basket. Anyone may submit it; funds always go to `account`.
    /// @param account The holder the leaf was issued to (receives the basket).
    /// @param amounts Per-token entitlements, aligned to payoutTokens().
    /// @param proof Merkle proof of the leaf against `merkleRoot`.
    /// @dev    Atomic: pays the WHOLE basket and marks `account` claimed only if every leg transfers; a
    ///         payout token that blocks transfer to `account`, or a Safe balance/allowance shortfall on
    ///         any leg, makes the entire basket unclaimable until the condition clears (see the
    ///         payout-token assumptions in the contract NatSpec). Zero-amount legs are skipped.
    function claim(address account, uint256[] calldata amounts, bytes32[] calldata proof) external {
        if (!activated) revert NotActivated();
        if (hasClaimed[account]) revert AlreadyClaimed();
        uint256 n = _payoutTokens.length;
        if (amounts.length != n) revert LengthMismatch();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amounts))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();

        // Effects before interactions (CEI): mark claimed, then pull the basket from the Safe.
        hasClaimed[account] = true;

        for (uint256 i = 0; i < n; i++) {
            uint256 amt = amounts[i];
            if (amt > 0) IERC20(_payoutTokens[i]).safeTransferFrom(safe, account, amt);
        }

        emit Claimed(account, amounts);
    }
}
