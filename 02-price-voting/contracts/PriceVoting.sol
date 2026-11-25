// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// PriceVoting — token holders lock tokens behind a price to vote on it. While
// voting is open, anyone can vote(price, amount); the contract pulls the tokens
// via transferFrom. After votingEnd, anyone can finalize() once to set the
// winning price, and voters claim() their locked tokens back.
//
// ============================================================================
// REFLECTION NOTE: What breaks if mid-voting withdrawals are allowed?
// ============================================================================
// 1. `leaderPrice` and `leaderWeight` (Leader Tracking Breakdown):
//    When votes only accumulate, tracking the leader is O(1) by simply checking
//    `newWeight > leaderWeight`. If withdrawals are allowed during voting,
//    withdrawing from the leader price decreases its weight. If its weight drops
//    below other candidates, the contract would have to find the NEXT highest price.
//    In an unbounded option space (any uint256 price), finding the new leader
//    requires iterating over all active prices (exceeding block gas limit / DoS)
//    or maintaining an expensive on-chain priority queue / sorted heap.
//
// 2. `weightOf` and `lockedOf` (Vote Reuse / Stake Multiplication):
//    If tokens can be withdrawn and recast, a voter with 100 tokens could vote
//    for Price A, withdraw, and vote for Price B with the exact same tokens,
//    multiplying their voting influence beyond their actual token holdings.
// ============================================================================
contract PriceVoting {
    IERC20 private immutable _token;
    uint256 private immutable _votingEnd;

    mapping(uint256 => uint256) private _weights;
    mapping(address => uint256) private _locked;

    uint256 private _leaderPrice;
    uint256 private _leaderWeight;
    bool private _isTie;

    uint256 private _currentTokenPrice;
    bool private _finalized;

    error VotingEnded();
    error VotingActive();
    error AlreadyFinalized();
    error ZeroAmount();
    error NothingToClaim();
    error TransferFailed();

    event Voted(address indexed voter, uint256 indexed price, uint256 amount);
    event PriceFinalized(uint256 indexed price, uint256 weight);
    event Claimed(address indexed voter, uint256 amount);

    constructor(IERC20 token_, uint256 votingEnd_) {
        _token = token_;
        _votingEnd = votingEnd_;
    }

    // ----- write -----

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

        _locked[msg.sender] += amount;
        uint256 newWeight = _weights[price] + amount;
        _weights[price] = newWeight;

        if (newWeight > _leaderWeight) {
            _leaderPrice = price;
            _leaderWeight = newWeight;
            _isTie = false;
        } else if (newWeight == _leaderWeight) {
            _isTie = true;
        }

        emit Voted(msg.sender, price, amount);
    }

    function finalize() external {
        if (block.timestamp < _votingEnd) {
            revert VotingActive();
        }
        if (_finalized) {
            revert AlreadyFinalized();
        }

        _finalized = true;

        if (_leaderWeight > 0 && !_isTie) {
            _currentTokenPrice = _leaderPrice;
            emit PriceFinalized(_leaderPrice, _leaderWeight);
        }
    }

    function claim() external {
        if (block.timestamp < _votingEnd) {
            revert VotingActive();
        }

        uint256 amount = _locked[msg.sender];
        if (amount == 0) {
            revert NothingToClaim();
        }

        _locked[msg.sender] = 0;

        bool ok = _token.transfer(msg.sender, amount);
        if (!ok) {
            revert TransferFailed();
        }

        emit Claimed(msg.sender, amount);
    }

    // ----- read -----

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

    function leader() external view returns (uint256 price, uint256 weight) {
        return (_leaderPrice, _leaderWeight);
    }

    function currentTokenPrice() external view returns (uint256) {
        return _currentTokenPrice;
    }

    function finalized() external view returns (bool) {
        return _finalized;
    }
}
