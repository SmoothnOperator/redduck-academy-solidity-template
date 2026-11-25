// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract Pair is ERC20 {
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    address private constant DEAD_ADDRESS = address(0xdead);

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;

    bool private _locked;

    error InsufficientLiquidity();
    error InsufficientAmount();
    error InsufficientOutput();
    error InvalidToken();

    event LiquidityAdded(address indexed who, uint256 amount0, uint256 amount1, uint256 liquidity);
    event LiquidityRemoved(address indexed who, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swapped(address indexed who, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

    modifier nonReentrant() {
        require(!_locked, "REENTRANCY");
        _locked = true;
        _;
        _locked = false;
    }

    constructor(IERC20 _token0, IERC20 _token1) ERC20("Simple AMM LP", "sLP") {
        token0 = _token0;
        token1 = _token1;
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        if (amountIn == 0) revert InsufficientAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;

        return numerator / denominator;
    }

    function addLiquidity(uint256 amount0, uint256 amount1) external nonReentrant returns (uint256 liquidity) {
        if (amount0 == 0 || amount1 == 0) revert InsufficientAmount();

        uint256 currentSupply = totalSupply();

        if (currentSupply == 0) {
            uint256 totalMinted = _sqrt(amount0 * amount1);
            if (totalMinted <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            liquidity = totalMinted - MINIMUM_LIQUIDITY;
            _mint(DEAD_ADDRESS, MINIMUM_LIQUIDITY);
        } else {
            liquidity = _min((amount0 * currentSupply) / reserve0, (amount1 * currentSupply) / reserve1);
            if (liquidity == 0) revert InsufficientLiquidity();
        }

        require(token0.transferFrom(msg.sender, address(this), amount0), "TRANSFER_FAILED");
        require(token1.transferFrom(msg.sender, address(this), amount1), "TRANSFER_FAILED");

        _mint(msg.sender, liquidity);

        reserve0 = token0.balanceOf(address(this));
        reserve1 = token1.balanceOf(address(this));

        emit LiquidityAdded(msg.sender, amount0, amount1, liquidity);
    }

    function removeLiquidity(uint256 liquidity) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (liquidity == 0) revert InsufficientLiquidity();

        uint256 currentSupply = totalSupply();
        uint256 balance0 = token0.balanceOf(address(this));
        uint256 balance1 = token1.balanceOf(address(this));

        amount0 = (liquidity * balance0) / currentSupply;
        amount1 = (liquidity * balance1) / currentSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();

        _burn(msg.sender, liquidity);

        require(token0.transfer(msg.sender, amount0), "TRANSFER_FAILED");
        require(token1.transfer(msg.sender, amount1), "TRANSFER_FAILED");

        reserve0 = token0.balanceOf(address(this));
        reserve1 = token1.balanceOf(address(this));

        emit LiquidityRemoved(msg.sender, amount0, amount1, liquidity);
    }

    function swap(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut
    ) external nonReentrant returns (uint256 amountOut) {
        if (tokenIn != address(token0) && tokenIn != address(token1)) {
            revert InvalidToken();
        }

        bool isToken0 = tokenIn == address(token0);
        (IERC20 inToken, IERC20 outToken, uint256 resIn, uint256 resOut) = isToken0
            ? (token0, token1, reserve0, reserve1)
            : (token1, token0, reserve1, reserve0);

        amountOut = getAmountOut(amountIn, resIn, resOut);
        if (amountOut < minAmountOut) revert InsufficientOutput();

        require(inToken.transferFrom(msg.sender, address(this), amountIn), "TRANSFER_FAILED");
        require(outToken.transfer(msg.sender, amountOut), "TRANSFER_FAILED");

        reserve0 = token0.balanceOf(address(this));
        reserve1 = token1.balanceOf(address(this));

        emit Swapped(msg.sender, tokenIn, amountIn, amountOut);
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
