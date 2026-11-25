// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// ============================================================================
// PriceVotingWithdrawal
// ============================================================================
//
// Token holders lock tokens behind any proposed uint256 price. Voters can
// withdraw their locked tokens at ANY time (before or after votingEnd).
//
// ────────────────────────────────────────────────────────────────────────────
// REFLECTION: Handling Withdrawal-Induced Leader Changes
// ────────────────────────────────────────────────────────────────────────────
// In the previous task, weights were monotonic (only increasing), making leader
// tracking O(1). With mid-voting withdrawals, the leader can be demoted. In an
// unbounded option space, finding the predecessor cannot be done in O(1) without
// an expensive on-chain heap.
//
// Strategy chosen: Deferred Settlement with a Candidate Registry.
// - vote() and withdraw() update per-price and per-voter balances in O(1).
// - Each distinct price is added once to `candidatePrices`.
// - The winning price is computed deterministically upon `finalize()` after
//   `votingEnd`, ensuring gas-efficient voting and withdrawals.
// ============================================================================

contract PriceVotingWithdrawal {
    IERC20 private immutable _token;
    uint256 private immutable _votingEnd;

    // Per-price weight and per-voter per-price stake
    mapping(uint256 => uint256) private _weights;
    mapping(address => mapping(uint256 => uint256)) private _votes;
    mapping(address => uint256) private _locked;

    // Registry of unique candidate prices
    uint256[] private _candidatePrices;
    mapping(uint256 => bool) private _isCandidate;

    // History of prices voted on by each user
    mapping(address => uint256[]) private _voterPrices;
    mapping(address => mapping(uint256 => bool)) private _hasVotedOnPrice;

    // Finalized state
    uint256 private _winningPrice;
    uint256 private _winningWeight;
    bool private _finalized;

    // Errors
    error VotingEnded();
    error VotingActive();
    error AlreadyFinalized();
    error ZeroAmount();
    error InsufficientLockedBalance();
    error NothingToClaim();
    error TransferFailed();

    // Events
    event Voted(address indexed voter, uint256 indexed price, uint256 amount);
    event Withdrawn(address indexed voter, uint256 indexed price, uint256 amount);
    event PriceFinalized(uint256 indexed price, uint256 weight);

    constructor(IERC20 token_, uint256 votingEnd_) {
        _token = token_;
        _votingEnd = votingEnd_;
    }

    // ─── Mutations ────────────────────────────────────────────

    /// @notice Lock tokens behind a proposed price.
    function vote(uint256 price, uint256 amount) external {
        if (block.timestamp >= _votingEnd) {
            revert VotingEnded();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }

        bool ok = _token.transferFrom(msg.sender, address(this), amount);
        if (!ok) {
            revert TransferFailed();
        }

        if (!_isCandidate[price]) {
            _isCandidate[price] = true;
            _candidatePrices.push(price);
        }

        if (!_hasVotedOnPrice[msg.sender][price]) {
            _hasVotedOnPrice[msg.sender][price] = true;
            _voterPrices[msg.sender].push(price);
        }

        _votes[msg.sender][price] += amount;
        _weights[price] += amount;
        _locked[msg.sender] += amount;

        emit Voted(msg.sender, price, amount);
    }

    /// @notice Withdraw locked tokens from a price at ANY time (before or after votingEnd).
    function withdraw(uint256 price, uint256 amount) external {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (_votes[msg.sender][price] < amount) {
            revert InsufficientLockedBalance();
        }

        _votes[msg.sender][price] -= amount;
        _weights[price] -= amount;
        _locked[msg.sender] -= amount;

        bool ok = _token.transfer(msg.sender, amount);
        if (!ok) {
            revert TransferFailed();
        }

        emit Withdrawn(msg.sender, price, amount);
    }

    /// @notice Conveniently withdraw all locked tokens across all prices for msg.sender.
    function withdrawAll() external {
        uint256 totalToReturn = 0;
        uint256[] storage prices = _voterPrices[msg.sender];

        for (uint256 i = 0; i < prices.length; i++) {
            uint256 p = prices[i];
            uint256 stake = _votes[msg.sender][p];
            if (stake > 0) {
                _votes[msg.sender][p] = 0;
                _weights[p] -= stake;
                totalToReturn += stake;
                emit Withdrawn(msg.sender, p, stake);
            }
        }

        if (totalToReturn == 0) {
            revert NothingToClaim();
        }

        _locked[msg.sender] -= totalToReturn;

        bool ok = _token.transfer(msg.sender, totalToReturn);
        if (!ok) {
            revert TransferFailed();
        }
    }

    /// @notice Finalize the vote after the voting period ends.
    function finalize() external {
        if (block.timestamp < _votingEnd) {
            revert VotingActive();
        }
        if (_finalized) {
            revert AlreadyFinalized();
        }

        _finalized = true;

        (uint256 leadPrice, uint256 maxWeight, bool isTie) = _computeLeader();

        if (maxWeight > 0 && !isTie) {
            _winningPrice = leadPrice;
            _winningWeight = maxWeight;
            emit PriceFinalized(leadPrice, maxWeight);
        }
    }

    // ─── View Functions ───────────────────────────────────────

    function token() external view returns (IERC20) {
        return _token;
    }

    function votingEnd() external view returns (uint256) {
        return _votingEnd;
    }

    function weightOf(uint256 price) external view returns (uint256) {
        return _weights[price];
    }

    function lockedOf(address voter) external view returns (uint256) {
        return _locked[voter];
    }

    function votesOf(address voter, uint256 price) external view returns (uint256) {
        return _votes[voter][price];
    }

    function currentTokenPrice() external view returns (uint256) {
        return _winningPrice;
    }

    function winningPrice() external view returns (uint256) {
        return _winningPrice;
    }

    function finalized() external view returns (bool) {
        return _finalized;
    }

    function candidatePricesCount() external view returns (uint256) {
        return _candidatePrices.length;
    }

    function leader() external view returns (uint256 price, uint256 weight) {
        if (_finalized) {
            return (_winningPrice, _winningWeight);
        }
        (uint256 leadPrice, uint256 maxWeight, bool isTie) = _computeLeader();
        if (isTie) {
            return (0, maxWeight);
        }
        return (leadPrice, maxWeight);
    }

    // ─── Internal Helpers ─────────────────────────────────────

    function _computeLeader()
        internal
        view
        returns (uint256 leadPrice, uint256 maxWeight, bool isTie)
    {
        for (uint256 i = 0; i < _candidatePrices.length; i++) {
            uint256 p = _candidatePrices[i];
            uint256 w = _weights[p];

            if (w > maxWeight) {
                maxWeight = w;
                leadPrice = p;
                isTie = false;
            } else if (w > 0 && w == maxWeight) {
                isTie = true;
            }
        }
    }
}
