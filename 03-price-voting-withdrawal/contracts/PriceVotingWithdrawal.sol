// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// ============================================================================
// PriceVotingWithdrawal (O(1) Optimistic Claim-and-Challenge Design)
// ============================================================================
//
// Token holders lock tokens behind any proposed uint256 price during the
// voting window. Voters may withdraw their locked tokens at ANY time — both
// during the active voting period and after voting ends.
//
// ────────────────────────────────────────────────────────────────────────────
// REQUIRED CALL ORDER (Settlement Lifecycle)
// ────────────────────────────────────────────────────────────────────────────
// 1. Voting Phase (block.timestamp < votingEnd):
//    - Voters call `vote(price, amount)` to lock tokens behind a price.
//    - Voters may call `withdraw(price, amount)` to unlock tokens and remove
//      their weight from that price before voting ends.
//
// 2. Post-Voting Withdrawal (block.timestamp >= votingEnd):
//    - Voters may still call `withdraw(price, amount)` at any time to reclaim
//      their tokens. Because the voting period is over, post-voting withdrawals
//      do NOT alter `_weights[price]` (weights are frozen at `votingEnd`).
//
// 3. Settlement Phase (block.timestamp >= votingEnd):
//    - If NO votes remain (`totalWeight == 0`), anyone can call `finalize()`
//      immediately to mark the round finalized with `winningPrice = 0`.
//    - If votes remain (`totalWeight > 0`):
//      a) Anyone calls `proposeWinner(price)` with a candidate that has > 0
//         weight. This opens a challenge window of `CHALLENGE_PERIOD` (1 hour).
//      b) While `block.timestamp < challengeEnd`, anyone can call
//         `challenge(challengerPrice)` with a different price that has strictly
//         greater weight (overtaking the candidate and resetting the challenge
//         window) or equal weight (marking the top weight as tied).
//      c) Once `block.timestamp >= challengeEnd`, anyone calls `finalize()` to
//         lock in `winningPrice` and emit `PriceFinalized`.
//
// ────────────────────────────────────────────────────────────────────────────
// TIE-BREAKING RULE (Documented & Applied Consistently)
// ────────────────────────────────────────────────────────────────────────────
// If two or more distinct prices tie for the highest final weight at
// `votingEnd`, NO winner is declared: `winningPrice` is set to `0` (and
// `currentTokenPrice()` remains `0`).
// - If `challenge(price)` presents a distinct price with `weight == candidateWeight`,
//   `isTied` becomes `true`.
// - A tie can only be broken if a subsequent `challenge(price)` supplies a
//   price with strictly higher weight (`weight > candidateWeight`), which sets
//   `isTied = false` and promotes the new leader.
// - At `finalize()`, if `isTied == true`, `winningPrice` resolves to `0`.
//
// ────────────────────────────────────────────────────────────────────────────
// REFLECTION: Strategy for Handling Withdrawal-Induced Leader Changes
// ────────────────────────────────────────────────────────────────────────────
// In Task 02, leader tracking used an incremental `if (newWeight > leaderWeight)`
// check on every vote. That breaks as soon as withdrawals are allowed, because
// withdrawing from the leader can demote it, and finding the new highest-weight
// price across an unbounded uint256 option space cannot be done in O(1).
//
// Even deferring the max-search to a `finalize()` loop over an array of voted
// prices (or a `withdrawAll()` loop over a voter's price array) creates an
// unbounded iteration vulnerability: an attacker could spam small votes across
// thousands of dummy prices to cause out-of-gas DoS during settlement.
//
// Solution: Optimistic Claim-and-Challenge Settlement.
// - `vote` and `withdraw` execute in strict O(1) time with zero loops.
// - No voter-controlled arrays exist in storage.
// - After `votingEnd`, anyone proposes the winning price in O(1), challengers
//   can dispute it in O(1) during `CHALLENGE_PERIOD`, and `finalize()` settles
//   the outcome in O(1). Every operation has bounded constant gas cost.
// ============================================================================

contract PriceVotingWithdrawal {
    uint256 public constant CHALLENGE_PERIOD = 1 hours;

    IERC20 private immutable _token;
    uint256 private immutable _votingEnd;

    // O(1) bookkeeping: no voter-controlled dynamic arrays anywhere in storage
    mapping(uint256 => uint256) private _weights;
    mapping(address => mapping(uint256 => uint256)) private _votes;
    mapping(address => uint256) private _locked;
    uint256 private _totalWeight;

    // Claim-and-challenge settlement state
    uint256 private _candidatePrice;
    uint256 private _candidateWeight;
    bool private _isTied;
    uint256 private _challengeEnd;

    uint256 private _winningPrice;
    bool private _finalized;

    // Custom Errors
    error VotingEnded();
    error VotingActive();
    error AlreadyFinalized();
    error ZeroAmount();
    error ZeroWeight();
    error InsufficientLockedBalance();
    error TransferFailed();
    error CandidateAlreadyProposed();
    error NoCandidateProposed();
    error ChallengePeriodActive();
    error ChallengePeriodEnded();
    error SameCandidate();
    error InsufficientWeight();
    error AlreadyTied();

    // Events
    event Voted(address indexed voter, uint256 indexed price, uint256 amount);
    event Withdrawn(address indexed voter, uint256 indexed price, uint256 amount);
    event WinnerProposed(uint256 indexed price, uint256 weight, uint256 challengeEnd);
    event WinnerChallenged(uint256 indexed challengerPrice, uint256 weight, bool isTied, uint256 challengeEnd);
    event PriceFinalized(uint256 indexed price, uint256 weight);

    constructor(IERC20 token_, uint256 votingEnd_) {
        _token = token_;
        _votingEnd = votingEnd_;
    }

    // ─── Voting & Withdrawal (Strict O(1)) ────────────────────

    /// @notice Lock `amount` tokens behind `price` during the active voting period.
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

        _votes[msg.sender][price] += amount;
        _locked[msg.sender] += amount;
        _weights[price] += amount;
        _totalWeight += amount;

        emit Voted(msg.sender, price, amount);
    }

    /// @notice Withdraw `amount` tokens locked on `price` at any time (before or after `votingEnd`).
    /// @dev Follows Checks-Effects-Interactions. Before `votingEnd`, withdrawal also reduces
    ///      the price's election weight; after `votingEnd`, weights remain frozen.
    function withdraw(uint256 price, uint256 amount) external {
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (_votes[msg.sender][price] < amount) {
            revert InsufficientLockedBalance();
        }

        // Effects before interaction (CEI)
        _votes[msg.sender][price] -= amount;
        _locked[msg.sender] -= amount;

        if (block.timestamp < _votingEnd) {
            _weights[price] -= amount;
            _totalWeight -= amount;
        }

        // Interaction
        bool ok = _token.transfer(msg.sender, amount);
        if (!ok) {
            revert TransferFailed();
        }

        emit Withdrawn(msg.sender, price, amount);
    }

    // ─── Claim-and-Challenge Settlement (Strict O(1)) ─────────

    /// @notice Propose the winning price after voting ends to start the challenge window.
    function proposeWinner(uint256 price) external {
        if (block.timestamp < _votingEnd) {
            revert VotingActive();
        }
        if (_finalized) {
            revert AlreadyFinalized();
        }
        if (_challengeEnd != 0) {
            revert CandidateAlreadyProposed();
        }

        uint256 weight = _weights[price];
        if (weight == 0) {
            revert ZeroWeight();
        }

        _candidatePrice = price;
        _candidateWeight = weight;
        _isTied = false;
        _challengeEnd = block.timestamp + CHALLENGE_PERIOD;

        emit WinnerProposed(price, weight, _challengeEnd);
    }

    /// @notice Challenge the proposed winner with another price having >= weight.
    /// @dev Strictly higher weight replaces the candidate and clears any tie.
    ///      Equal weight marks the round as tied per the documented tie-breaking rule.
    function challenge(uint256 challengerPrice) external {
        if (_finalized) {
            revert AlreadyFinalized();
        }
        if (_challengeEnd == 0) {
            revert NoCandidateProposed();
        }
        if (block.timestamp >= _challengeEnd) {
            revert ChallengePeriodEnded();
        }
        if (challengerPrice == _candidatePrice) {
            revert SameCandidate();
        }

        uint256 challengerWeight = _weights[challengerPrice];
        if (challengerWeight < _candidateWeight) {
            revert InsufficientWeight();
        }

        if (challengerWeight > _candidateWeight) {
            _candidatePrice = challengerPrice;
            _candidateWeight = challengerWeight;
            _isTied = false;
            _challengeEnd = block.timestamp + CHALLENGE_PERIOD;
        } else {
            // Tie at the top weight
            if (_isTied) {
                revert AlreadyTied();
            }
            _isTied = true;
            _challengeEnd = block.timestamp + CHALLENGE_PERIOD;
        }

        emit WinnerChallenged(challengerPrice, challengerWeight, _isTied, _challengeEnd);
    }

    /// @notice Finalize the winning price after the challenge window closes (or immediately if no votes).
    /// @dev Applies the tie-breaking rule: if tied or no votes, `winningPrice` remains 0.
    function finalize() external {
        if (block.timestamp < _votingEnd) {
            revert VotingActive();
        }
        if (_finalized) {
            revert AlreadyFinalized();
        }

        if (_totalWeight == 0) {
            _finalized = true;
            return;
        }

        if (_challengeEnd == 0) {
            revert NoCandidateProposed();
        }
        if (block.timestamp < _challengeEnd) {
            revert ChallengePeriodActive();
        }

        _finalized = true;

        if (!_isTied) {
            _winningPrice = _candidatePrice;
            emit PriceFinalized(_candidatePrice, _candidateWeight);
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

    function totalWeight() external view returns (uint256) {
        return _totalWeight;
    }

    function challengeEnd() external view returns (uint256) {
        return _challengeEnd;
    }

    function isTied() external view returns (bool) {
        return _isTied;
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

    /// @notice Returns the leading/winning price and weight. Returns (0, weight) when tied.
    function leader() external view returns (uint256 price, uint256 weight) {
        if (_finalized) {
            return (_winningPrice, _isTied ? 0 : _candidateWeight);
        }
        return (_isTied ? 0 : _candidatePrice, _candidateWeight);
    }
}
