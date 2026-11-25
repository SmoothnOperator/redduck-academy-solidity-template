import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;
const CHALLENGE_PERIOD = 60 * 60;

describe("PriceVotingWithdrawal", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", ["Vote Token", "VOTE", parseEther("1000000")]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract("PriceVotingWithdrawal", [token.address, votingEnd]);

    for (const w of [alice, bob, carol]) {
      await token.write.transfer([w.account.address, parseEther("1000")]);
      await token.write.approve([voting.address, parseEther("1000")], {
        account: w.account,
      });
    }

    return { token, voting, votingEnd, deployer, alice, bob, carol };
  }

  describe("voting", function () {
    it("locks tokens and records vote weight", async function () {
      const { voting, token, alice } = await networkHelpers.loadFixture(deployFixture);

      await viem.assertions.emitWithArgs(
        voting.write.vote([100n, parseEther("50")], { account: alice.account }),
        voting,
        "Voted",
        [getAddress(alice.account.address), 100n, parseEther("50")],
      );

      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
      assert.equal(await voting.read.votesOf([alice.account.address, 100n]), parseEther("50"));
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("950"));
    });

    it("stacks weights from multiple voters on the same price and splits across prices", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([100n, parseEther("30")], { account: bob.account });
      await voting.write.vote([200n, parseEther("60")], { account: alice.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("70"));
      assert.equal(await voting.read.weightOf([200n]), parseEther("60"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("100"));
      assert.equal(await voting.read.totalWeight(), parseEther("130"));
    });

    it("reverts vote after votingEnd and reverts with amount 0", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployFixture);

      await assert.rejects(voting.write.vote([100n, 0n], { account: alice.account }), /ZeroAmount/);

      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await assert.rejects(
        voting.write.vote([100n, parseEther("10")], { account: alice.account }),
        /VotingEnded/,
      );
    });
  });

  describe("mid-voting and post-voting withdrawal", function () {
    it("allows partial withdrawal during active voting period and updates weights", async function () {
      const { voting, token, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await viem.assertions.emitWithArgs(
        voting.write.withdraw([100n, parseEther("20")], { account: alice.account }),
        voting,
        "Withdrawn",
        [getAddress(alice.account.address), 100n, parseEther("20")],
      );

      assert.equal(await voting.read.weightOf([100n]), parseEther("30"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("30"));
      assert.equal(await voting.read.votesOf([alice.account.address, 100n]), parseEther("30"));
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("970"));
    });

    it("allows voter to change mind: withdraw from price A and vote for price B", async function () {
      const { voting, token, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.withdraw([100n, parseEther("50")], { account: alice.account });

      assert.equal(await voting.read.weightOf([100n]), 0n);
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("1000"));

      await voting.write.vote([200n, parseEther("50")], { account: alice.account });
      assert.equal(await voting.read.weightOf([200n]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
    });

    it("reverts on over-withdrawal or zero withdrawal", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await assert.rejects(
        voting.write.withdraw([100n, 0n], { account: alice.account }),
        /ZeroAmount/,
      );
      await assert.rejects(
        voting.write.withdraw([100n, parseEther("51")], { account: alice.account }),
        /InsufficientLockedBalance/,
      );
    });

    it("allows withdrawal after votingEnd without altering frozen election weights", async function () {
      const { voting, votingEnd, token, alice, bob } =
        await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("80")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd + 1n);

      // Alice withdraws after voting ended
      await voting.write.withdraw([100n, parseEther("80")], { account: alice.account });
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("1000"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);

      // Frozen weight for price 100n stays 80e18, so price 100n still wins!
      assert.equal(await voting.read.weightOf([100n]), parseEther("80"));

      await voting.write.proposeWinner([100n]);
      await networkHelpers.time.increase(BigInt(CHALLENGE_PERIOD));
      await voting.write.finalize();

      assert.equal(await voting.read.winningPrice(), 100n);
    });
  });

  describe("winning-price correctness and claim-and-challenge settlement", function () {
    it("vote-only winning-price scenario: selects highest-weight price with no withdrawals", async function () {
      const { voting, votingEnd, alice, bob, carol } =
        await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: bob.account });
      await voting.write.vote([200n, parseEther("30")], { account: carol.account });
      await voting.write.vote([300n, parseEther("70")], { account: carol.account });

      // Weights: 100n -> 40, 200n -> 90, 300n -> 70
      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await voting.write.proposeWinner([200n]);
      await networkHelpers.time.increase(BigInt(CHALLENGE_PERIOD));

      await viem.assertions.emitWithArgs(voting.write.finalize(), voting, "PriceFinalized", [
        200n,
        parseEther("90"),
      ]);

      assert.equal(await voting.read.winningPrice(), 200n);
      assert.equal(await voting.read.currentTokenPrice(), 200n);
      assert.equal(await voting.read.finalized(), true);
      const [leadPrice, leadWeight] = await voting.read.leader();
      assert.equal(leadPrice, 200n);
      assert.equal(leadWeight, parseEther("90"));
    });

    it("withdrawal-induced winner change: leader flips after mid-voting withdrawal", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("80")], { account: bob.account });

      // Alice withdraws 40 from 100n -> 100n drops to 60, so 200n (80) leads
      await voting.write.withdraw([100n, parseEther("40")], { account: alice.account });
      assert.equal(await voting.read.weightOf([100n]), parseEther("60"));

      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await voting.write.proposeWinner([200n]);
      await networkHelpers.time.increase(BigInt(CHALLENGE_PERIOD));
      await voting.write.finalize();

      assert.equal(await voting.read.winningPrice(), 200n);
      assert.equal(await voting.read.currentTokenPrice(), 200n);
      assert.equal(await voting.read.finalized(), true);
    });

    it("challenge replaces a lower-weight candidate proposed by an attacker", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("10")], { account: alice.account });
      await voting.write.vote([200n, parseEther("90")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd + 1n);

      // Attacker proposes losing price 100n
      await voting.write.proposeWinner([100n]);

      // Honest participant challenges with 200n
      await voting.write.challenge([200n], { account: bob.account });

      await networkHelpers.time.increase(BigInt(CHALLENGE_PERIOD));
      await voting.write.finalize();

      assert.equal(await voting.read.winningPrice(), 200n);
    });

    it("tie-breaking rule: equal top weights result in winningPrice = 0, and higher weight breaks the tie", async function () {
      const { voting, votingEnd, alice, bob, carol } =
        await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: bob.account });
      await voting.write.vote([300n, parseEther("60")], { account: carol.account });

      // Alice withdraws 40 -> 100n drops to 60, tied with 200n and 300n
      await voting.write.withdraw([100n, parseEther("40")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await voting.write.proposeWinner([100n]);
      await voting.write.challenge([200n]);
      assert.equal(await voting.read.isTied(), true);

      // Cannot challenge again with yet another equal-weight tie
      await assert.rejects(voting.write.challenge([300n]), /AlreadyTied/);

      await networkHelpers.time.increase(BigInt(CHALLENGE_PERIOD));
      await voting.write.finalize();

      assert.equal(await voting.read.winningPrice(), 0n);
      assert.equal(await voting.read.finalized(), true);
      const [leadPrice] = await voting.read.leader();
      assert.equal(leadPrice, 0n);
    });

    it("a strictly higher-weight challenge clears a tie", async function () {
      const { voting, votingEnd, alice, bob, carol } =
        await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });
      await voting.write.vote([300n, parseEther("80")], { account: carol.account });

      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await voting.write.proposeWinner([100n]);
      await voting.write.challenge([200n]);
      assert.equal(await voting.read.isTied(), true);

      // Price 300n breaks the tie
      await voting.write.challenge([300n]);
      assert.equal(await voting.read.isTied(), false);

      await networkHelpers.time.increase(BigInt(CHALLENGE_PERIOD));
      await voting.write.finalize();

      assert.equal(await voting.read.winningPrice(), 300n);
    });

    it("finalizes immediately with 0 when no votes remain at votingEnd", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.withdraw([100n, parseEther("50")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd + 1n);
      await voting.write.finalize();

      assert.equal(await voting.read.winningPrice(), 0n);
      assert.equal(await voting.read.finalized(), true);
    });

    it("enforces settlement call order and revert conditions", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("10")], { account: bob.account });

      // Cannot propose or finalize before votingEnd
      await assert.rejects(voting.write.proposeWinner([100n]), /VotingActive/);
      await assert.rejects(voting.write.finalize(), /VotingActive/);

      await networkHelpers.time.increaseTo(votingEnd + 1n);

      // Cannot challenge or finalize when votes exist without a proposal
      await assert.rejects(voting.write.challenge([200n]), /NoCandidateProposed/);
      await assert.rejects(voting.write.finalize(), /NoCandidateProposed/);

      // Cannot propose a 0-weight price
      await assert.rejects(voting.write.proposeWinner([999n]), /ZeroWeight/);

      await voting.write.proposeWinner([100n]);

      // Cannot propose twice
      await assert.rejects(voting.write.proposeWinner([200n]), /CandidateAlreadyProposed/);

      // Cannot challenge with strictly lower weight
      await assert.rejects(voting.write.challenge([200n]), /InsufficientWeight/);

      // Cannot finalize before challenge window ends
      await assert.rejects(voting.write.finalize(), /ChallengePeriodActive/);

      await networkHelpers.time.increase(BigInt(CHALLENGE_PERIOD));

      // Cannot challenge after challenge window ended
      await assert.rejects(voting.write.challenge([200n]), /ChallengePeriodEnded/);

      await voting.write.finalize();

      // Cannot finalize twice
      await assert.rejects(voting.write.finalize(), /AlreadyFinalized/);
    });
  });
});
