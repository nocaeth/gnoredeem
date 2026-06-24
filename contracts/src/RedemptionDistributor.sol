// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title  RedemptionDistributor (GIP-151 — claim phase)
/// @notice Pull-claim distributor for the post-window redemption basket. ONE leaf per holder encodes
///         that holder's full multi-asset entitlement, so a single claim() transfers the ENTIRE basket
///         (all payout tokens) in one transaction.
/// @dev    Deliberately minimal, admin-free, immutable — same philosophy as RedemptionDeposit:
///         - The Merkle root, the canonical payout-token set, and the per-token totals are committed at
///           deploy (and published in the claim manifest). No setRoot, no owner, no upgrade, no pause.
///         - The redemption Safe funds it by transferring the assembled basket in. Anyone may then call
///           activate(), which opens claims ONLY once the contract holds >= every committed total — the
///           solvency gate: it can never go live unable to pay every leaf, so early claimers cannot
///           strand late ones.
///         - No claim deadline. There is intentionally NO sweep/recovery: an unclaimed basket stays
///           claimable forever. A residual sunset is a governance decision and is deliberately NOT built
///           in here (adding it would require an admin/timelock — out of scope, keep it trustless).
///
///         Leaf format (must match the off-chain builder, e.g. OZ StandardMerkleTree with leaf encoding
///         ['address','uint256[]']):
///             leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amounts))))
///         where amounts[i] is `account`'s entitlement for payoutTokens()[i] (same order, same length).
contract RedemptionDistributor {
    using SafeERC20 for IERC20;

    /// @notice Merkle root over all holder leaves. Immutable; published with the claim manifest.
    bytes32 public immutable merkleRoot;

    /// @notice Canonical, ordered payout-token set. Leaf `amounts` are aligned to this order.
    address[] private _payoutTokens;
    /// @notice Committed total to be distributed per payout token (sum of all leaves for that token).
    mapping(address token => uint256 total) public payoutTotal;
    /// @notice Whether an account has already claimed its basket.
    mapping(address account => bool claimed) public hasClaimed;
    /// @notice Claims are only open once funded to >= every committed total.
    bool public activated;

    event Activated();
    event Claimed(address indexed account, uint256[] amounts);

    error AlreadyActivated();
    error NotActivated();
    error AlreadyClaimed();
    error InvalidProof();
    error LengthMismatch();
    error UnderFunded(address token);

    constructor(bytes32 merkleRoot_, address[] memory tokens, uint256[] memory totals) {
        require(merkleRoot_ != bytes32(0), "zero root");
        require(tokens.length > 0, "empty basket");
        require(tokens.length == totals.length, "length mismatch");
        merkleRoot = merkleRoot_;
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

    /// @notice Open claims. Permissionless, but reverts unless the contract already holds the full
    ///         committed basket for every token — so claims can never open under-funded.
    function activate() external {
        if (activated) revert AlreadyActivated();
        uint256 n = _payoutTokens.length;
        for (uint256 i = 0; i < n; i++) {
            address t = _payoutTokens[i];
            if (IERC20(t).balanceOf(address(this)) < payoutTotal[t]) revert UnderFunded(t);
        }
        activated = true;
        emit Activated();
    }

    /// @notice Claim `account`'s full basket. Anyone may submit it; funds always go to `account`.
    /// @param account The holder the leaf was issued to (receives the basket).
    /// @param amounts Per-token entitlements, aligned to payoutTokens().
    /// @param proof Merkle proof of the leaf against `merkleRoot`.
    function claim(address account, uint256[] calldata amounts, bytes32[] calldata proof) external {
        if (!activated) revert NotActivated();
        if (hasClaimed[account]) revert AlreadyClaimed();
        uint256 n = _payoutTokens.length;
        if (amounts.length != n) revert LengthMismatch();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amounts))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();

        // Effects before interactions (CEI): mark claimed, then transfer the basket.
        hasClaimed[account] = true;

        for (uint256 i = 0; i < n; i++) {
            uint256 amt = amounts[i];
            if (amt > 0) IERC20(_payoutTokens[i]).safeTransfer(account, amt);
        }

        emit Claimed(account, amounts);
    }
}
