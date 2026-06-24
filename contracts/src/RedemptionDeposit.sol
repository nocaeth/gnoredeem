// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title  RedemptionDeposit (GIP-151)
/// @notice One-time, opt-in deposit router for the GnosisDAO pro-rata treasury redemption.
///         During the deposit window, GNO or osGNO holders opt in by depositing either token;
///         deposits are forwarded immediately to the GnosisDAO redemption Safe. Per-holder amounts
///         are recorded on-chain (storage + events) so the post-window Merkle distribution can be
///         reconstructed and independently verified by anyone.
/// @dev    Deliberately minimal:
///         - The contract NEVER custodies funds; every deposit is forwarded to `safe` in the same call.
///         - It records RAW amounts of GNO and osGNO separately (ground truth). The single
///           osGNO->GNO snapshot rate is baked in as an immutable at deploy: the contract is deployed
///           AFTER the proposal passes, when that rate is already fixed and published, so it is known
///           up front. It is exposed via gnoEquivalent()/totalGnoEquivalent() for transparency and
///           verifiable against getRate() at the snapshot block. The contract reads no oracle at
///           runtime; the canonical redemption Merkle tree is still built off-chain from the raw
///           amounts using the same rate.
///         - A holder of both tokens simply calls `deposit` twice (once per token); both are credited.
///         - There is no withdrawal: this is deployed only after GIP-151 has passed on Snapshot.
///         Assumes GNO and osGNO are standard, non-fee-on-transfer ERC20s (verified on Gnosis Chain).
///         Pending audit. Constructor addresses (safe) and `deadline` are set at deployment.
contract RedemptionDeposit {
    /// @notice GNO token (Gnosis Chain).
    IERC20 public immutable gno;
    /// @notice Stakewise osGNO token (Gnosis Chain).
    IERC20 public immutable osgno;
    /// @notice Destination Safe that receives all deposited tokens.
    address public immutable safe;
    /// @notice Unix timestamp (inclusive) of the last second deposits are accepted; end of the window.
    uint256 public immutable deadline;
    /// @notice Fixed osGNO->GNO rate (1e18-scaled) from the Stakewise rate provider at the GIP-151
    ///         snapshot. Set once at deployment. Verify against getRate() at the snapshot block.
    uint256 public immutable osgnoRate;

    /// @notice Total raw amount deposited, per token.
    mapping(address token => uint256 total) public totalDeposited;
    /// @notice Raw amount deposited, per holder per token.
    mapping(address holder => mapping(address token => uint256 amount)) public deposited;

    event Deposited(address indexed holder, address indexed token, uint256 amount);

    error DepositWindowClosed();
    error UnsupportedToken();
    error ZeroAmount();
    error TransferFailed();

    constructor(address gno_, address osgno_, address safe_, uint256 deadline_, uint256 osgnoRate_) {
        require(gno_ != address(0) && osgno_ != address(0) && safe_ != address(0), "zero addr");
        require(deadline_ > block.timestamp, "deadline in past");
        require(osgnoRate_ > 0, "rate=0");
        gno = IERC20(gno_);
        osgno = IERC20(osgno_);
        safe = safe_;
        deadline = deadline_;
        osgnoRate = osgnoRate_;
    }

    /// @notice A holder's GNO-equivalent deposit: raw GNO + raw osGNO valued at the fixed snapshot rate.
    /// @dev Transparency view. The canonical Merkle tree is built off-chain from the raw `deposited`
    ///      amounts using the same rate; this mirrors that math (floor division).
    function gnoEquivalent(address holder) external view returns (uint256) {
        return deposited[holder][address(gno)] + deposited[holder][address(osgno)] * osgnoRate / 1e18;
    }

    /// @notice Total GNO-equivalent across all deposits (raw GNO total + raw osGNO total at the fixed rate).
    function totalGnoEquivalent() external view returns (uint256) {
        return totalDeposited[address(gno)] + totalDeposited[address(osgno)] * osgnoRate / 1e18;
    }

    /// @notice Opt in by depositing `amount` of `token` (GNO or osGNO). Forwarded straight to the Safe.
    /// @dev Requires a prior ERC20 approval of this contract for `amount` of `token`.
    /// @param token GNO or osGNO address.
    /// @param amount Raw token amount (token's own decimals).
    function deposit(address token, uint256 amount) external {
        if (block.timestamp > deadline) revert DepositWindowClosed();
        if (token != address(gno) && token != address(osgno)) revert UnsupportedToken();
        if (amount == 0) revert ZeroAmount();

        // Effects before interaction (CEI). GNO/osGNO have no transfer callback, so this is safe.
        deposited[msg.sender][token] += amount;
        totalDeposited[token] += amount;

        _safeTransferFrom(token, msg.sender, safe, amount);

        emit Deposited(msg.sender, token, amount);
    }

    /// @dev transferFrom that tolerates tokens returning no data and reverts on `false`.
    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
