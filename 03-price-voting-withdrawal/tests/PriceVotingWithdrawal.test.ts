import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;

describe("PriceVotingWithdrawal", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", [
      "Vote Token",
      "VOTE",
      parseEther("1000000"),
    ]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract("PriceVotingWithdrawal", [
      token.address,
      votingEnd,
    ]);

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

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
      assert.equal(await voting.read.votesOf([alice.account.address, 100n]), parseEther("50"));
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("950"));
    });

    it("allows voting multiple times on the same price", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([100n, parseEther("30")], { account: bob.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("80"));
    });

    it("allows a voter to split votes across multiple prices", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: alice.account });

      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("100"));
      assert.equal(await voting.read.votesOf([alice.account.address, 100n]), parseEther("40"));
      assert.equal(await voting.read.votesOf([alice.account.address, 200n]), parseEther("60"));
      assert.equal(await voting.read.weightOf([100n]), parseEther("40"));
      assert.equal(await voting.read.weightOf([200n]), parseEther("60"));
    });

    it("reverts vote after votingEnd", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployFixture);
      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await assert.rejects(
        voting.write.vote([100n, parseEther("10")], { account: alice.account }),
        /VotingEnded/
      );
    });

    it("reverts vote with amount 0", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(
        voting.write.vote([100n, 0n], { account: alice.account }),
        /ZeroAmount/
      );
    });
  });

  describe("mid-voting withdrawal", function () {
    it("allows partial withdrawal during active voting period", async function () {
      const { voting, token, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await viem.assertions.emitWithArgs(
        voting.write.withdraw([100n, parseEther("20")], { account: alice.account }),
        voting,
        "Withdrawn",
        [getAddress(alice.account.address), 100n, parseEther("20")]
      );

      assert.equal(await voting.read.weightOf([100n]), parseEther("30"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("30"));
      assert.equal(await voting.read.votesOf([alice.account.address, 100n]), parseEther("30"));
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("970"));
    });

    it("allows voter to change mind: withdraw from price A and vote for price B", async function () {
      const { voting, token, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));

      await voting.write.withdraw([100n, parseEther("50")], { account: alice.account });
      assert.equal(await voting.read.weightOf([100n]), 0n);
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("1000"));

      await voting.write.vote([200n, parseEther("50")], { account: alice.account });
      assert.equal(await voting.read.weightOf([200n]), parseEther("50"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
    });

    it("reverts if attempting to withdraw more than locked for that price", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await assert.rejects(
        voting.write.withdraw([100n, parseEther("51")], { account: alice.account }),
        /InsufficientLockedBalance/
      );
    });

    it("reverts withdraw with amount 0", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(
        voting.write.withdraw([100n, 0n], { account: alice.account }),
        /ZeroAmount/
      );
    });

    it("allows withdrawAll across multiple prices", async function () {
      const { voting, token, alice } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("30")], { account: alice.account });
      await voting.write.vote([200n, parseEther("70")], { account: alice.account });

      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("100"));

      await voting.write.withdrawAll({ account: alice.account });

      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(await voting.read.weightOf([100n]), 0n);
      assert.equal(await voting.read.weightOf([200n]), 0n);
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("1000"));
    });

    it("allows withdrawal after votingEnd", async function () {
      const { voting, votingEnd, token, alice } = await networkHelpers.loadFixture(deployFixture);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await voting.write.withdraw([100n, parseEther("50")], { account: alice.account });
      assert.equal(await token.read.balanceOf([alice.account.address]), parseEther("1000"));
      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
    });
  });

  describe("winning price resolution with withdrawals", function () {
    it("withdrawal causes leader to flip correctly before finalization", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("80")], { account: bob.account });

      const [leadBefore] = await voting.read.leader();
      assert.equal(leadBefore, 100n);

      // Alice withdraws 40 from 100n -> 100n drops to 60 weight
      await voting.write.withdraw([100n, parseEther("40")], { account: alice.account });

      // 200n now leads with 80 weight
      const [leadAfter, weightAfter] = await voting.read.leader();
      assert.equal(leadAfter, 200n);
      assert.equal(weightAfter, parseEther("80"));

      await networkHelpers.time.increaseTo(votingEnd + 1n);
      await viem.assertions.emitWithArgs(
        voting.write.finalize(),
        voting,
        "PriceFinalized",
        [200n, parseEther("80")]
      );

      assert.equal(await voting.read.winningPrice(), 200n);
      assert.equal(await voting.read.currentTokenPrice(), 200n);
      assert.equal(await voting.read.finalized(), true);
    });

    it("withdrawal causing a tie results in unchanged price upon finalize", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployFixture);

      await voting.write.vote([100n, parseEther("100")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: bob.account });

      // Alice withdraws 40 -> 100n drops to 60 (tied with 200n)
      await voting.write.withdraw([100n, parseEther("40")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd + 1n);
      await voting.write.finalize();

      assert.equal(await voting.read.winningPrice(), 0n);
      assert.equal(await voting.read.finalized(), true);
    });

    it("finalize reverts before votingEnd", async function () {
      const { voting } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(voting.write.finalize(), /VotingActive/);
    });

    it("finalize reverts when called twice", async function () {
      const { voting, votingEnd } = await networkHelpers.loadFixture(deployFixture);
      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await voting.write.finalize();
      await assert.rejects(voting.write.finalize(), /AlreadyFinalized/);
    });
  });
});
