import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;

describe("PriceVoting", function () {
  async function deployVotingFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", [
      "Vote Token",
      "VOTE",
      parseEther("1000000"),
    ]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract("PriceVoting", [
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

  describe("voting scenarios", function () {
    it("1. A single vote sets the leading price and weight correctly", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      const [leaderPrice, leaderWeight] = await voting.read.leader();
      assert.equal(leaderPrice, 100n);
      assert.equal(leaderWeight, parseEther("50"));
    });

    it("2. Two voters voting for the same price stack the weight on that price", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([100n, parseEther("30")], { account: bob.account });

      assert.equal(await voting.read.weightOf([100n]), parseEther("80"));
      const [leaderPrice, leaderWeight] = await voting.read.leader();
      assert.equal(leaderPrice, 100n);
      assert.equal(leaderWeight, parseEther("80"));
    });

    it("3. Two voters voting for different prices: the one with more total weight wins", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("80")], { account: bob.account });

      const [leaderPrice, leaderWeight] = await voting.read.leader();
      assert.equal(leaderPrice, 200n);
      assert.equal(leaderWeight, parseEther("80"));
    });

    it("4. A single voter calling vote twice for different prices: their lockedBalance grows correctly, each price has the right weight", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);
      await voting.write.vote([100n, parseEther("40")], { account: alice.account });
      await voting.write.vote([200n, parseEther("60")], { account: alice.account });

      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("100"));
      assert.equal(await voting.read.weightOf([100n]), parseEther("40"));
      assert.equal(await voting.read.weightOf([200n]), parseEther("60"));
    });

    it("5. The leading price updates correctly when a new vote pushes a different price above the current leader", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      let [leaderPrice, leaderWeight] = await voting.read.leader();
      assert.equal(leaderPrice, 100n);
      assert.equal(leaderWeight, parseEther("50"));

      await voting.write.vote([200n, parseEther("75")], { account: bob.account });

      [leaderPrice, leaderWeight] = await voting.read.leader();
      assert.equal(leaderPrice, 200n);
      assert.equal(leaderWeight, parseEther("75"));
    });

    it("6. The leading price does NOT update on a tie", async function () {
      const { voting, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      const [leaderPrice, leaderWeight] = await voting.read.leader();
      assert.equal(leaderPrice, 100n);
      assert.equal(leaderWeight, parseEther("50"));
    });

    it("7. vote reverts when called after votingEnd", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);
      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await assert.rejects(
        voting.write.vote([100n, parseEther("10")], { account: alice.account }),
        /VotingEnded/
      );
    });

    it("8. vote reverts when called with amount == 0", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);
      await assert.rejects(
        voting.write.vote([100n, 0n], { account: alice.account }),
        /ZeroAmount/
      );
    });

    it("9. vote reverts when the voter has not approved the contract for enough tokens", async function () {
      const { token, voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);
      await token.write.approve([voting.address, 0n], { account: alice.account });

      await assert.rejects(
        voting.write.vote([100n, parseEther("10")], { account: alice.account })
      );
    });
  });

  describe("finalize scenarios", function () {
    it("10. finalize reverts when called before votingEnd", async function () {
      const { voting } = await networkHelpers.loadFixture(deployVotingFixture);
      await assert.rejects(voting.write.finalize(), /VotingActive/);
    });

    it("11. finalize reverts when called twice", async function () {
      const { voting, votingEnd } = await networkHelpers.loadFixture(deployVotingFixture);
      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await voting.write.finalize();

      await assert.rejects(voting.write.finalize(), /AlreadyFinalized/);
    });

    it("12. finalize correctly sets currentTokenPrice and finalized and emits PriceFinalized", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);
      await voting.write.vote([150n, parseEther("50")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await viem.assertions.emitWithArgs(
        voting.write.finalize(),
        voting,
        "PriceFinalized",
        [150n, parseEther("50")]
      );

      assert.equal(await voting.read.currentTokenPrice(), 150n);
      assert.equal(await voting.read.finalized(), true);
    });

    it("13. finalize with no votes succeeds and currentTokenPrice stays at 0", async function () {
      const { voting, votingEnd } = await networkHelpers.loadFixture(deployVotingFixture);
      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await voting.write.finalize();

      assert.equal(await voting.read.currentTokenPrice(), 0n);
      assert.equal(await voting.read.finalized(), true);
    });

    it("14. finalize with a tie succeeds and currentTokenPrice stays at 0", async function () {
      const { voting, votingEnd, alice, bob } = await networkHelpers.loadFixture(deployVotingFixture);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      await voting.write.vote([200n, parseEther("50")], { account: bob.account });

      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await voting.write.finalize();

      assert.equal(await voting.read.currentTokenPrice(), 0n);
      assert.equal(await voting.read.finalized(), true);
    });
  });

  describe("claim scenarios", function () {
    it("15. claim reverts when called before votingEnd", async function () {
      const { voting, alice } = await networkHelpers.loadFixture(deployVotingFixture);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await assert.rejects(
        voting.write.claim({ account: alice.account }),
        /VotingActive/
      );
    });

    it("16. claim reverts when the caller has nothing locked", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);
      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await assert.rejects(
        voting.write.claim({ account: alice.account }),
        /NothingToClaim/
      );
    });

    it("17. claim returns the correct amount and zeros out the voter's locked balance", async function () {
      const { token, voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);
      const initialBalance = await token.read.balanceOf([alice.account.address]);

      await voting.write.vote([100n, parseEther("50")], { account: alice.account });
      assert.equal(await voting.read.lockedOf([alice.account.address]), parseEther("50"));
      assert.equal(
        await token.read.balanceOf([alice.account.address]),
        initialBalance - parseEther("50")
      );

      await networkHelpers.time.increaseTo(votingEnd + 1n);

      await viem.assertions.emitWithArgs(
        voting.write.claim({ account: alice.account }),
        voting,
        "Claimed",
        [getAddress(alice.account.address), parseEther("50")]
      );

      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(await token.read.balanceOf([alice.account.address]), initialBalance);
    });

    it("18. A voter cannot claim twice", async function () {
      const { voting, votingEnd, alice } = await networkHelpers.loadFixture(deployVotingFixture);
      await voting.write.vote([100n, parseEther("50")], { account: alice.account });

      await networkHelpers.time.increaseTo(votingEnd + 1n);
      await voting.write.claim({ account: alice.account });

      await assert.rejects(
        voting.write.claim({ account: alice.account }),
        /NothingToClaim/
      );
    });
  });
});
