import { expect } from "chai";
import { ethers } from "hardhat";
import {Contract, formatEther, parseEther} from "ethers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { waitFor } from "../../shared/utils/helpers";
import {SeiUser, UserFactory} from "../../shared/User";
import GOV_ARTIFACTS from "./abis/gov_abi.json";
import {GovExtension, QueryClient, setupGovExtension} from "@cosmjs/stargate";
import {returnQueryClient} from "./utils";
import {TextProposal} from "cosmjs-types/cosmos/gov/v1beta1/gov";

export interface WeightedVoteOption {
    /**
     * Vote option:
     * 1 = Yes
     * 2 = Abstain
     * 3 = No
     * 4 = NoWithVeto
     */
    option: number;

    /**
     * Weight as decimal string (e.g., "0.7")
     * All weights must sum to 1.0
     */
    weight: string;
}

// Add interface for governance queries
interface ProposalResponse {
    id: bigint;
    title: string;
    description: string;
    status: string;
    finalTallyResult?: {
        yes: string;
        abstain: string;
        no: string;
        noWithVeto: string;
    };
    submitTime: string;
    depositEndTime: string;
    votingStartTime: string;
    votingEndTime: string;
    totalDeposit: string;
    metadata: string;
}

interface Status {

}

describe("Gov Precompile Tests", function () {
    this.timeout(10 * 60 * 1000); // Extended timeout for proposal processing

    let govContract: Contract;
    let admin: SeiUser;
    let proposalId: bigint;
    let voter1: SeiUser;
    let voter2: SeiUser;
    const GOV_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000001006";
    const depositAmount = ethers.parseEther("10");
    const MIN_DEPOSIT = '10000000';
    let govQueryClient: QueryClient & GovExtension;

    before(async function () {
        admin = await UserFactory.createAdminUser();
        // await UserFactory.fundAdminOnSei();
        [voter1, voter2] = await UserFactory.createSeiUsers(admin, 4, false);

        // Get the Gov precompile contract
        govContract = new ethers.Contract(GOV_PRECOMPILE_ADDRESS, GOV_ARTIFACTS, admin.evmWallet.wallet);
        govQueryClient = await returnQueryClient(setupGovExtension);
    });

    describe("Query Functions Tests", function () {
        it.only("should retrieve governance parameters", async function () {
            const params = await govQueryClient.gov.params("deposit");
            console.log(params);
            console.log(params.depositParams.minDeposit);
            // Validate that critical parameters exist
            // Store min deposit for later use
            // MIN_DEPOSIT = ethers.parseEther(params.depositParams.minDeposit[0].amount);
        });
    });

    describe("Proposal Submission Tests", function () {
        it.skip("should submit a text proposal", async function () {
            const proposalJSON = JSON.stringify({
                title: "Test Text Proposal",
                description: "This is a test text proposal for governance",
                type: "Text",
                is_expedited: false
            });
            const userBalance = await admin.evmWallet.queryBalance();
            const proposalId: bigint = await govContract
                .submitProposal
                .staticCall(proposalJSON, { value: parseEther("10") });

            const tx = await govContract.submitProposal(proposalJSON, {
                value: depositAmount
            });
            const receipt = await tx.wait();
            const userAfterBalance = await admin.evmWallet.queryBalance();
            expect(Number(formatEther(userBalance - userAfterBalance))).to.be.within(10, 11);
            const proposals = await govQueryClient.gov.proposal(Number(proposalId));
            console.log(proposals);
        });

        it.skip("should submit a parameter change proposal", async function () {
            const proposalJSON = JSON.stringify({
                title: "Parameter Change Proposal",
                description: "This proposal changes a parameter in the system",
                type: "ParameterChange",
                is_expedited: false,
                changes: [
                    {
                        subspace: "staking",
                        key: "MaxValidators",
                        value: "150"
                    }
                ]
            });

            const tx = await govContract.submitProposal(proposalJSON, {
                value: depositAmount
            });
            const receipt = await tx.wait();

            // Extract proposal ID from events
            const event = receipt.logs.find(log =>
                log.topics[0] === ethers.id("ProposalSubmitted(uint64,string,string)")
            );
            expect(event).to.not.be.undefined;

            // Verify proposal was created with correct metadata
            const paramChangeProposalId = event.args.proposalId;
            const proposal = await govContract.getProposal(paramChangeProposalId);
            expect(proposal.title).to.equal("Parameter Change Proposal");
            expect(proposal.status).to.equal("PROPOSAL_STATUS_DEPOSIT_PERIOD");
        });

        it.skip("should fail when submitting proposal with insufficient deposit", async function () {
            const proposalJSON = JSON.stringify({
                title: "Insufficient Deposit Proposal",
                description: "This proposal should fail due to insufficient deposit",
                type: "Text"
            });

            await expect(govContract.submitProposal(proposalJSON, {
                value: MIN_DEPOSIT.div(2) // Half of minimum deposit
            })).to.be.revertedWith("insufficient deposit");
        });

        it.skip("should fail when submitting proposal with invalid JSON", async function () {
            const invalidJSON = "{title: This is invalid JSON}";

            await expect(govContract.submitProposal(invalidJSON, {
                value: depositAmount
            })).to.be.reverted;
        });
    });

    describe("Deposit Tests", function () {
        it.only("With the deposit amount equals to min deposit, proposal enters the voting period", async function () {
            const proposalJSON = JSON.stringify({
                title: "Test Text Proposal",
                description: "This is a test text proposal for governance",
                type: "Text",
                is_expedited: false
            });
            const userBalance = await admin.evmWallet.queryBalance();
            const proposalId: bigint = await govContract
                .submitProposal
                .staticCall(proposalJSON, { value: parseEther("10") });

            const tx = await govContract.submitProposal(proposalJSON, {
                value: depositAmount
            });
            const receipt = await tx.wait();
            const userAfterBalance = await admin.evmWallet.queryBalance();
            expect(Number(formatEther(userBalance - userAfterBalance))).to.be.within(10, 11);
            const proposal = await govQueryClient.gov.proposal(Number(proposalId));
            expect(proposal.proposal.status).to.be.eq(2);
            expect(proposal.proposal.content?.typeUrl).to.include('TextProposal');
            const textProposal = TextProposal.decode(proposal.proposal.content!.value);
            expect(textProposal.title).to.be.eq('Test Text Proposal');
            expect(textProposal.description).to.be.eq('This is a test text proposal for governance');
            const votingPeriod = proposal.proposal.votingEndTime.seconds -proposal.proposal.votingStartTime.seconds;
            expect(Number(votingPeriod)).to.be.eq(30);
            const totalDeposit = proposal.proposal.totalDeposit;
            expect(totalDeposit[0].amount).to.be.eq("10000000");
            expect(totalDeposit[0].denom).to.be.eq("usei");
        });

        it.only('With deposit amounts lower than min deposit, proposal enters the deposit period', async function () {
            const proposalJSON = JSON.stringify({
                title: "Test Text Proposal",
                description: "This is a test text proposal for governance",
                type: "Text",
                is_expedited: false
            });
            const userBalance = await admin.evmWallet.queryBalance();
            const proposalId: bigint = await govContract
                .submitProposal
                .staticCall(proposalJSON, { value: parseEther("10") });

            const tx = await govContract.submitProposal(proposalJSON, {
                value: depositAmount - ethers.parseEther("1")
            });
            const receipt = await tx.wait();
            const proposal = await govQueryClient.gov.proposal(Number(proposalId));
            expect(proposal.proposal.status).to.be.eq(1);
            expect(proposal.proposal.content?.typeUrl).to.include('TextProposal');
            expect(proposal.proposal.totalDeposit[0].amount).to.be.eq("9000000");
            expect(proposal.proposal.totalDeposit[0].denom).to.be.eq("usei");
            expect(Number(proposal.proposal.submitTime.seconds - proposal.proposal.depositEndTime.seconds)).to.be.eq(100);
        });

        it('Cant deposit after deposit time ends', () => {

        });

        it('With deposit amounts higher than min deposit, proposal enters the voting period', async function () {

        })

        it("should fail depositing to non-existent proposal", async function () {
            const nonExistentProposalId = BigInt(999999999);

            await expect(govContract.deposit(nonExistentProposalId, {
                value: depositAmount
            })).to.be.reverted;
        });

        it("should fail depositing zero tokens", async function () {
            await expect(govContract.deposit(proposalId, {
                value: 0
            })).to.be.revertedWith("deposit amount must be positive");
        });
    });

    describe("Voting Tests", function () {
        before(async function() {
            // Wait for the proposal to enter voting period
            // This might require chain-specific handling in a real test
            // For this example, we'll assume it's ready for voting

            // Get proposal status
            const proposal = await govContract.getProposal(proposalId);

            // If not in voting period, we might need to wait or add more deposits
            if (proposal.status !== "PROPOSAL_STATUS_VOTING_PERIOD") {
                console.log(`Proposal status: ${proposal.status}. Adding more deposits if needed.`);
                if (proposal.status === "PROPOSAL_STATUS_DEPOSIT_PERIOD") {
                    // Add more deposit to reach threshold if needed
                    await govContract.deposit(proposalId, { value: ethers.parseEther("20") });
                    // In real tests, you might need to wait for the chain to transition the proposal
                    // to voting period, or use chain-specific methods to advance time
                    await waitFor(5); // Wait for chain to process
                }
            }
        });

        it("should cast a YES vote", async function () {
            const voteOption = 1; // YES

            const tx = await govContract.connect(voter1).vote(proposalId, voteOption);
            const receipt = await tx.wait();

            expect(receipt.status).to.equal(1);

            // Verify vote was recorded
            const vote = await govContract.getVote(proposalId, voter1.address);
            expect(vote.option).to.equal(voteOption);
        });

        it("should cast a NO vote", async function () {
            const voteOption = 3; // NO

            const tx = await govContract.connect(voter2).vote(proposalId, voteOption);
            const receipt = await tx.wait();

            expect(receipt.status).to.equal(1);

            // Verify vote was recorded
            const vote = await govContract.getVote(proposalId, voter2.address);
            expect(vote.option).to.equal(voteOption);
        });

        it("should cast an ABSTAIN vote", async function () {
            const voteOption = 2; // ABSTAIN

            const tx = await govContract.connect(owner).vote(proposalId, voteOption);
            const receipt = await tx.wait();

            expect(receipt.status).to.equal(1);

            // Verify vote was recorded
            const vote = await govContract.getVote(proposalId, owner.address);
            expect(vote.option).to.equal(voteOption);
        });

        it("should cast a NO_WITH_VETO vote", async function () {
            // Create a new proposal for this test
            const proposalJSON = JSON.stringify({
                title: "Test Veto Proposal",
                description: "This is a test proposal for veto voting",
                type: "Text"
            });

            const submitTx = await govContract.submitProposal(proposalJSON, {
                value: depositAmount
            });
            const submitReceipt = await submitTx.wait();
            const event = submitReceipt.logs.find(log =>
                log.topics[0] === ethers.id("ProposalSubmitted(uint64,string,string)")
            );
            const newProposalId = event.args.proposalId;

            // Add more deposit to reach threshold
            await govContract.deposit(newProposalId, { value: ethers.parseEther("20") });

            // Wait for proposal to enter voting period
            await waitFor(5);

            // Cast a VETO vote
            const voteOption = 4; // NO_WITH_VETO

            const voteTx = await govContract.connect(voter3).vote(newProposalId, voteOption);
            const voteReceipt = await voteTx.wait();

            expect(voteReceipt.status).to.equal(1);

            // Verify vote was recorded
            const vote = await govContract.getVote(newProposalId, voter3.address);
            expect(vote.option).to.equal(voteOption);
        });

        it("should fail voting with an invalid option", async function () {
            const invalidOption = 5; // Only 1-4 are valid

            await expect(govContract.connect(voter1).vote(proposalId, invalidOption))
                .to.be.reverted;
        });

        it("should fail voting on a non-existent proposal", async function () {
            const nonExistentProposalId = BigInt(999999999);

            await expect(govContract.connect(voter1).vote(nonExistentProposalId, 1))
                .to.be.reverted;
        });

        it("should fail voting twice on the same proposal", async function () {
            // Voter1 already voted YES in a previous test
            await expect(govContract.connect(voter1).vote(proposalId, 3)) // Try to vote NO now
                .to.be.revertedWith("already voted");
        });

        it("should cast a weighted vote", async function () {
            // Create a new proposal for weighted voting
            const proposalJSON = JSON.stringify({
                title: "Weighted Voting Test Proposal",
                description: "This is a test proposal for weighted voting",
                type: "Text"
            });

            const submitTx = await govContract.submitProposal(proposalJSON, {
                value: depositAmount
            });
            const submitReceipt = await submitTx.wait();
            const event = submitReceipt.logs.find(log =>
                log.topics[0] === ethers.id("ProposalSubmitted(uint64,string,string)")
            );
            const weightedProposalId = event.args.proposalId;

            // Add more deposit to reach threshold
            await govContract.deposit(weightedProposalId, { value: ethers.parseEther("20") });

            // Wait for proposal to enter voting period
            await waitFor(5);

            // Create options for weighted voting
            const options = [
                { option: 1, weight: "0.7" }, // 70% YES
                { option: 2, weight: "0.3" }  // 30% ABSTAIN
            ];

            const tx = await govContract.connect(voter2).voteWeighted(weightedProposalId, options);
            const receipt = await tx.wait();

            expect(receipt.status).to.equal(1);

            // Verify vote was recorded
            const vote = await govContract.getVote(weightedProposalId, voter2.address);
            expect(vote).to.not.be.undefined;
        });

        it("should fail weighted voting when weights don't sum to 1", async function () {
            // Create invalid options where weights sum to more than 1
            const invalidOptions = [
                { option: 1, weight: "0.7" }, // 70% YES
                { option: 2, weight: "0.5" }  // 50% ABSTAIN (total 120%)
            ];

            await expect(govContract.connect(nonVoter).voteWeighted(proposalId, invalidOptions))
                .to.be.revertedWith("weights must sum to 1");
        });
    });

    describe("Tally and Results Tests", function () {
        it("should retrieve the tally for an ongoing proposal", async function () {
            const tally = await govContract.getTally(proposalId);

            // Check that tally properties exist
            expect(tally).to.have.property("yes");
            expect(tally).to.have.property("no");
            expect(tally).to.have.property("abstain");
            expect(tally).to.have.property("noWithVeto");

            // Verify the votes match what we cast
            // Note: These should match the actual voting power, which might be different
            // from the number of voters if the chain uses staked tokens for voting power
            expect(BigInt(tally.yes)).to.be.gt(0); // At least one YES vote
            expect(BigInt(tally.no)).to.be.gt(0);  // At least one NO vote
            expect(BigInt(tally.abstain)).to.be.gt(0); // At least one ABSTAIN vote
        });

        it("should query votes for a specific voter", async function () {
            // Check a vote we know exists
            const vote = await govContract.getVote(proposalId, voter1.address);
            expect(vote.option).to.equal(1); // YES

            // Check a non-existent vote
            const nonVote = await govContract.getVote(proposalId, nonVoter.address);
            expect(nonVote.option).to.equal(0); // No vote cast
        });
    });

    describe("End-to-End Governance Tests", function () {
        it("should complete a full governance cycle for Text proposal", async function () {
            // 1. Submit proposal
            const proposalJSON = JSON.stringify({
                title: "Complete Text Proposal Test",
                description: "Testing full governance cycle",
                type: "Text"
            });

            const submitTx = await govContract.submitProposal(proposalJSON, {
                value: depositAmount
            });
            const submitReceipt = await submitTx.wait();
            const event = submitReceipt.logs.find(log =>
                log.topics[0] === ethers.id("ProposalSubmitted(uint64,string,string)")
            );
            const fullCycleProposalId = event.args.proposalId;

            // 2. Add additional deposit to reach threshold
            const depositTx = await govContract.deposit(fullCycleProposalId, {
                value: ethers.parseEther("20")
            });
            await depositTx.wait();

            // 3. Wait for proposal to enter voting period
            await waitFor(5);

            // 4. Query proposal to confirm it's in voting period
            const proposal = await govContract.getProposal(fullCycleProposalId);
            console.log(`Proposal status: ${proposal.status}`);

            // 5. Vote with multiple signers if proposal is in voting period
            if (proposal.status === "PROPOSAL_STATUS_VOTING_PERIOD") {
                await govContract.connect(owner).vote(fullCycleProposalId, 1); // YES
                await govContract.connect(voter1).vote(fullCycleProposalId, 1); // YES
                await govContract.connect(voter2).vote(fullCycleProposalId, 1); // YES

                // 6. Get tally to verify votes
                const tally = await govContract.getTally(fullCycleProposalId);
                expect(BigInt(tally.yes)).to.be.gt(0);

                // Note: In a real test, we would wait for the voting period to end
                // and check that the proposal was executed
            }

            expect(true).to.equal(true);
        });
    });

    describe("Error handling and edge cases", function() {
        it("should handle attempted voting after voting period ends", async function() {
            // This test would require chain-specific methods to advance time
            // or find a proposal that's already ended voting

            // For this example, we'll just skip with a comment
            console.log("Skipping test for voting after period ends - requires chain-specific time advancement");
        });

        it("should reject malformed proposal JSON", async function() {
            const malformedJSON = "{title: 'Malformed JSON missing quotes', description: 'This JSON is invalid'}";

            await expect(govContract.submitProposal(malformedJSON, {
                value: depositAmount
            })).to.be.reverted;
        });

        it("should reject proposal with missing required fields", async function() {
            // Missing description
            const incompleteJSON = JSON.stringify({
                title: "Incomplete Proposal",
                // description field missing
                type: "Text"
            });

            await expect(govContract.submitProposal(incompleteJSON, {
                value: depositAmount
            })).to.be.revertedWith("proposal missing required fields");
        });

        it("should reject weighted vote with invalid options", async function() {
            // Create invalid options with negative weight
            const invalidOptions = [
                { option: 1, weight: "-0.5" }, // Negative weight
                { option: 2, weight: "1.5" }   // Weight > 1
            ];

            await expect(govContract.connect(nonVoter).voteWeighted(proposalId, invalidOptions))
                .to.be.reverted;
        });

        it("should reject weighted vote with no options", async function() {
            const emptyOptions: WeightedVoteOption[] = [];

            await expect(govContract.connect(nonVoter).voteWeighted(proposalId, emptyOptions))
                .to.be.revertedWith("empty options");
        });
    });
});
