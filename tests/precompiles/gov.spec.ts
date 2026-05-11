import {expect} from "chai";
import {ethers} from "hardhat";
import {Contract, formatEther, parseEther} from "ethers";
import {SignerWithAddress} from "@nomicfoundation/hardhat-ethers/signers";
import {waitFor} from "../../shared/utils/helpers";
import {SeiUser, UserFactory} from "../../shared/User";
import GOV_ARTIFACTS from "./abis/gov_abi.json";
import {GovExtension, QueryClient, setupGovExtension, setupStakingExtension, StakingExtension} from "@cosmjs/stargate";
import {getProposalID, queryAllStakes, returnQueryClient, returnTextProposal} from "./utils";
import {TextProposal} from "cosmjs-types/cosmos/gov/v1beta1/gov";
import stakingAbi from "./abis/staking_abi.json";
import {ParameterChangeProposal} from "cosmjs-types/cosmos/params/v1beta1/params";

describe("Gov Precompile Tests", function () {
    this.timeout(15 * 60 * 1000); // Bumped for cold-chain staking delegation in before-all

    let govContract: Contract;
    let stakingContract: Contract;
    let admin: SeiUser;
    let proposalId: bigint;
    let voter1: SeiUser;
    let voter2: SeiUser;
    const GOV_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000001006";
    const STAKING_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000001005";
    const depositAmount = ethers.parseEther("10");
    const MIN_DEPOSIT = '10000000';
    let govQueryClient: QueryClient & GovExtension;
    let validatorAddress1: string;

    before(async function () {
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        [voter1, voter2] = await UserFactory.createSeiUsers(admin, 4, false);

        // Get the Gov precompile contract
        govContract = new ethers.Contract(GOV_PRECOMPILE_ADDRESS, GOV_ARTIFACTS, admin.evmWallet.wallet);
        govQueryClient = await returnQueryClient(setupGovExtension);
        stakingContract = new Contract(STAKING_PRECOMPILE_ADDRESS, stakingAbi, admin.evmWallet.wallet);
        const stakingQueryClient = await returnQueryClient(setupStakingExtension) as QueryClient & StakingExtension;

        const validatorsResponse = await stakingQueryClient.staking.validators("BOND_STATUS_BONDED");
        if (validatorsResponse.validators.length < 2) {
            throw new Error("At least two validators are required for these tests");
        }
        validatorAddress1 = validatorsResponse.validators[0].operatorAddress;
        const validatorAddress2 = validatorsResponse.validators[1].operatorAddress;

        // Should hold the quorum now
        const stakingTx = await stakingContract.delegate(validatorAddress1, {value: ethers.parseEther("50")});
        await stakingTx.wait();
        console.log('Staked into validator 1');
        const stakingTx2 = await stakingContract.delegate(validatorAddress2, {value: ethers.parseEther("50")});
        await stakingTx2.wait();
        console.log('Finished staking into validator 2');
    });

    describe("Create submission tests", function () {
        let proposalId: number;
        it("Users can create text proposals given that they send 1usei", async function () {
            const proposal = returnTextProposal();
            proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseUnits("1", 12),
                gasLimit: 1000000
            });
            await tx.wait();
            const proposalQuery = await govQueryClient.gov.proposal(Number(proposalId));
            expect(proposalQuery.proposal.status).to.be.eq(1);
            const totalDeposit = proposalQuery.proposal.totalDeposit;
            expect(totalDeposit[0].amount).to.be.eq("1");
            expect(totalDeposit[0].denom).to.be.eq("usei");
            expect(Number(proposalQuery.proposal.proposalId)).to.be.eq(Number(proposalId));
            expect(proposalQuery.proposal.content?.typeUrl).to.include('TextProposal');
            const textProposal = TextProposal.decode(proposalQuery.proposal.content!.value);
            expect(textProposal.title).to.be.eq('Test Text Proposal');
            expect(textProposal.description).to.be.eq('This is a test text proposal for governance');
            expect(Number(proposalQuery.proposal.depositEndTime.seconds - proposalQuery.proposal.submitTime.seconds)).to.be.eq(100);
            expect(Object.values(proposalQuery.proposal.finalTallyResult)).to.be.deep.eq(['0', '0', '0', '0']);
        });

        it('Users can create text proposals given that they send 10sei', async function () {
            const proposal = returnTextProposal();
            proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseUnits("10", 18),
                gasLimit: 1000000
            });
            const receipt = await tx.wait();
            const proposalQuery = await govQueryClient.gov.proposal(Number(proposalId));
            expect(proposalQuery.proposal.status).to.be.eq(2);
            const totalDeposit = proposalQuery.proposal.totalDeposit;
            expect(totalDeposit[0].amount).to.be.eq("10000000");
            expect(totalDeposit[0].denom).to.be.eq("usei");
            expect(Number(proposalQuery.proposal.proposalId)).to.be.eq(Number(proposalId));
        });

        it('Users can create text proposals given that they send 15 sei', async function () {
            const proposal = returnTextProposal();
            proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseUnits("15", 18),
                gasLimit: 1000000
            });
            const receipt = await tx.wait();
            const proposalQuery = await govQueryClient.gov.proposal(Number(proposalId));
            expect(proposalQuery.proposal.status).to.be.eq(2);
            const totalDeposit = proposalQuery.proposal.totalDeposit;
            expect(totalDeposit[0].amount).to.be.eq("15000000");
            expect(totalDeposit[0].denom).to.be.eq("usei");
            expect(Number(proposalQuery.proposal.proposalId)).to.be.eq(Number(proposalId));
        });

        //on cosmos same behavior
        it.skip('Sending proposals will fail unless user deposits sei', async function () {
            try {
                const proposal = returnTextProposal()
                proposalId = await getProposalID(govContract, proposal);
                const userBalance = await admin.evmWallet.queryBalance();
                const tx = await govContract.submitProposal(proposal, {gasLimit: 1000000});
                const receipt = await tx.wait();
                const userAfterBalance = await admin.evmWallet.queryBalance();
                console.log(formatEther(userBalance - userAfterBalance));
                const proposalQuery = await govQueryClient.gov.proposal(Number(proposalId));
            } catch (e: any) {
                console.log(e);
            }
        });

        it('Sending proposals with title over 140 characters will fail', async function () {
            const title = "This is a test text proposal for governance".repeat(500);
            try {
                const proposal = returnTextProposal(false, title);
                proposalId = await getProposalID(govContract, proposal);
                const tx = await govContract.submitProposal(proposal, {gasLimit: 1000000});
                await tx.wait();
                throw new Error('Fails tx');
            } catch (e: any) {
                expect(e.message).to.include('execution reverted');
            }
        });

        let passedProposalId: number;
        it('Users can submit a parameter change proposal given that they send 10 sei', async function () {
            const proposal = JSON.stringify({
                "title": "Gov Param Change",
                "description": "Update quorum to 0.45",
                "type": "ParameterChange",
                "changes": [
                    {
                        "subspace": "gov",
                        "key": "tallyparams",
                        "value": {
                            "quorum": "0.35"
                        }
                    }
                ],
                "is_expedited": false,
                "deposit": "50000000usei"
            });

            passedProposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: depositAmount,
                gasLimit: 1000000
            });
            await tx.wait();
            const proposalQuery = await govQueryClient.gov.proposal(Number(passedProposalId));
            expect(proposalQuery.proposal.status).to.be.eq(2);
            const totalDeposit = proposalQuery.proposal.totalDeposit;
            expect(totalDeposit[0].amount).to.be.eq("10000000");
            expect(totalDeposit[0].denom).to.be.eq("usei");
            expect(Number(proposalQuery.proposal.proposalId)).to.be.eq(Number(passedProposalId));
            expect(proposalQuery.proposal.content?.typeUrl).to.include('ParameterChangeProposal');
            const decoded = ParameterChangeProposal.decode(proposalQuery.proposal.content!.value);
            expect(decoded.title).to.be.eq('Gov Param Change');
            expect(decoded.description).to.be.eq('Update quorum to 0.45');
            expect(decoded.changes[0].subspace).to.be.eq('gov');
            expect(decoded.changes[0].key).to.be.eq('tallyparams');
            expect(JSON.parse(decoded.changes[0].value).quorum).to.be.eq('0.35');
            expect(Object.values(proposalQuery.proposal.finalTallyResult)).to.be.deep.eq(['0', '0', '0', '0']);
            expect(Number(proposalQuery.proposal.votingEndTime.seconds - proposalQuery.proposal.votingStartTime.seconds)).to.be.eq(30);
        });

        it('Users can submit a software upgrade proposal given that they send 1 sei', async () => {
            const height = (await admin.seiWallet.signingClient.getHeight()) + 20000;
            const proposal = JSON.stringify({
                title: "Upgrade to sei-v3",
                description: "Bumps the node binary to v3; halts at height " + height,
                type: "SoftwareUpgrade",
                plan: {
                    name: "sei-v3",
                    height: height,
                    info: 'test',
                    // time: ""
                },
                is_expedited: false
            });

            const proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseUnits("1", 18),
                gasLimit: 1000000
            });
            const receipt = await tx.wait();

            const proposalQuery = await govQueryClient.gov.proposal(Number(proposalId));
            expect(proposalQuery.proposal.status).to.be.eq(1);
            const totalDeposit = proposalQuery.proposal.totalDeposit;
            expect(totalDeposit[0].amount).to.be.eq("1000000");
            expect(totalDeposit[0].denom).to.be.eq("usei");

            expect(Number(proposalQuery.proposal.proposalId)).to.be.eq(Number(proposalId));
            expect(proposalQuery.proposal.content?.typeUrl).to.include('SoftwareUpgradeProposal');
            expect(Number(proposalQuery.proposal.depositEndTime.seconds - proposalQuery.proposal.submitTime.seconds)).to.be.eq(100);
            expect(Object.values(proposalQuery.proposal.finalTallyResult)).to.be.deep.eq(['0', '0', '0', '0']);
        });

        it('Legacy proposals are still supported', async () => {
            const proposal = JSON.stringify({
                "title": "Test v1 Proposal",
                "description": "This is a test proposal using the v1 governance module format",
                "messages": [
                    {
                        "@type": "/cosmos.gov.v1.MsgExecLegacyContent",
                        "authority": "sei10d07y265gmmuvt4z0w9aw880jnsr700jhwznsj",
                        "content": {
                            "@type": "/cosmos.gov.v1beta1.TextProposal",
                            "title": "Test v1 Text Proposal",
                            "description": "This is a text proposal using the v1 format"
                        }
                    }
                ],
                "metadata": "ipfs://CID",
                "deposit": "50000000usei",
                "is_expedited": false
            });

            // Submit the proposal and get its ID
            const proposalId = await getProposalID(govContract, proposal);
            const userPreBalance = await admin.evmWallet.queryBalance();
            const tx = await govContract.submitProposal(proposal, {
                value: depositAmount,
                gasLimit: 1000000
            });
            await tx.wait();
            const userAfterBalance = await admin.evmWallet.queryBalance();
            expect(Number(ethers.formatEther(userPreBalance - userAfterBalance))).to.be.gt(10);

            const proposalQuery = await govQueryClient.gov.proposal(Number(proposalId));
            expect(proposalQuery.proposal.status).to.be.eq(2);
            expect(proposalQuery.proposal.totalDeposit[0].amount).to.be.eq("10000000");
            expect(proposalQuery.proposal.totalDeposit[0].denom).to.be.eq("usei");
            expect(Number(proposalQuery.proposal.proposalId)).to.be.eq(Number(proposalId));
            expect(proposalQuery.proposal.content?.typeUrl).to.include('TextProposal');
            const decoded = new TextDecoder().decode(proposalQuery.proposal.content!.value);
            console.log(decoded);
            expect(decoded).to.contain("Test v1 Proposal=This is a test proposal using the v1 governance module format");
            expect(Object.values(proposalQuery.proposal.finalTallyResult)).to.be.deep.eq(['0', '0', '0', '0']);
            expect(Number(proposalQuery.proposal.votingEndTime.seconds - proposalQuery.proposal.votingStartTime.seconds)).to.be.eq(30);
        })
    });

    describe('Proposal deposit tests', function () {
        it('Users can deposit sei to a proposal given that it is on deposit period', async function () {
            // Create a proposal with less than min deposit to put it in deposit period
            const proposal = returnTextProposal();
            const proposalId = await getProposalID(govContract, proposal);

            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseEther("5"),
                gasLimit: 1000000
            });
            await tx.wait();
            const initialProposal = await govQueryClient.gov.proposal(Number(proposalId));
            expect(initialProposal.proposal.status).to.be.eq(1); // Deposit period
            expect(initialProposal.proposal.totalDeposit[0].amount).to.be.eq("5000000");

            const additionalDeposit = ethers.parseEther("3");
            const depositTx = await govContract.deposit(proposalId, {
                value: additionalDeposit,
                gasLimit: 1000000
            });
            await depositTx.wait();

            const updatedProposal = await govQueryClient.gov.proposal(Number(proposalId));
            expect(updatedProposal.proposal.totalDeposit[0].amount).to.be.eq("8000000");
            expect(updatedProposal.proposal.status).to.be.eq(1);

            const depositTx2 = await govContract.deposit(proposalId, {
                value: ethers.parseEther("3"),
                gasLimit: 1000000
            });
            await depositTx2.wait();

            const finalProposal = await govQueryClient.gov.proposal(Number(proposalId));
            expect(finalProposal.proposal.totalDeposit[0].amount).to.be.eq("11000000");
            expect(finalProposal.proposal.status).to.be.eq(2);
        });

        it('Users can deposit to proposals that are in the voting period', async function () {
            const proposal = returnTextProposal();
            const proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseEther("10"),
                gasLimit: 1000000
            });
            await tx.wait();
            console.log('Sent');
            // Verify proposal is in voting period
            const initialProposal = await govQueryClient.gov.proposal(Number(proposalId));
            expect(initialProposal.proposal.status).to.be.eq(2);

            const additionalDeposit = ethers.parseEther("5");
            const depositTx = await govContract.deposit(proposalId, {
                value: additionalDeposit,
                gasLimit: 1000000
            });
            await depositTx.wait();

            const afterDeposit = await govQueryClient.gov.proposal(Number(proposalId));
            expect(afterDeposit.proposal.totalDeposit[0].amount).to.be.eq("15000000");
            expect(afterDeposit.proposal.status).to.be.eq(2);
        });

        it('Users cant deposit to proposals that are closed due to not reaching min deposit', async () => {
            const proposal = returnTextProposal();
            const proposalId = await getProposalID(govContract, proposal);
            // Submit with full min deposit
            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseEther("5"),
                gasLimit: 1000000
            });
            await tx.wait();
            console.log('Waiting for 100 seconds');
            const userBalance = await admin.evmWallet.queryBalance();
            await waitFor(102);
            const userBalanceAfter = await admin.evmWallet.queryBalance();
            expect((userBalance - userBalanceAfter).toString()).to.be.eq('0');

            try{
                const tx = await govContract.deposit(proposalId, {
                    value: ethers.parseEther("5"),
                    gasLimit: 1000000
                });
                await tx.wait();
                throw new Error('Should return');
            } catch(e: any){
                expect(e.message).to.include('execution reverted');
            }
        });

        it('If proposals are passed deposits are returned to the users', async () => {
            const proposal = returnTextProposal();
            const proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseEther("10"),
                gasLimit: 1000000
            });
            await tx.wait();

            const voteTx = await govContract.vote(proposalId, 1);
            await voteTx.wait();

            const userPreBalance = await admin.evmWallet.queryBalance();
            await waitFor(30);
            console.log('Voted and waiting');
            const userAfterBalance = await admin.evmWallet.queryBalance();
            expect(ethers.formatEther(userAfterBalance - userPreBalance).toString()).to.be.eq('10.0');
        });

        it('If proposals are rejected deposits are returned to the users', async () => {
            const proposal = returnTextProposal();
            const proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseEther("50"),
                gasLimit: 1000000
            });
            await tx.wait();

            const voteTx = await govContract.vote(proposalId, 3);
            await voteTx.wait();
            console.log('Voted and waiting');
            const userPreBalance = await admin.evmWallet.queryBalance();
            await waitFor(30);
            const userAfterBalance = await admin.evmWallet.queryBalance();
            expect(ethers.formatEther(userAfterBalance - userPreBalance).toString()).to.be.eq('50.0');
        });

        it('Multiple people deposit tokens for proposals in voting period and if the proposal rejects,' +
            ' deposits are returned to the all users', async () => {
            const proposal = returnTextProposal();
            const proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseEther("50"),
                gasLimit: 1000000
            });
            await tx.wait();

            const depositTx1 = await govContract.connect(voter1.evmWallet.wallet)
                .deposit(proposalId, {value: ethers.parseEther("10")});
            const depositTx2 = await govContract.connect(voter2.evmWallet.wallet)
                .deposit(proposalId, {value: ethers.parseEther("10")});
            await Promise.all([depositTx1.wait(), depositTx2.wait()]);
            const voteTx = await govContract.vote(proposalId, 3);
            await voteTx.wait();
            const userPreBalance = await admin.evmWallet.queryBalance();
            const voter1PreBalance = await voter1.evmWallet.queryBalance();
            const voter2PreBalance = await voter2.evmWallet.queryBalance();
            await waitFor(30);
            const userAfterBalance = await admin.evmWallet.queryBalance();
            const voter1AfterBalance = await voter1.evmWallet.queryBalance();
            const voter2AfterBalance = await voter2.evmWallet.queryBalance();
            const proposalQuery = await govQueryClient.gov.proposal(Number(proposalId));
            expect(proposalQuery.proposal.status).to.be.eq(4);
            expect(ethers.formatEther(userAfterBalance - userPreBalance).toString()).to.be.eq('50.0');
            expect(ethers.formatEther(voter1AfterBalance - voter1PreBalance).toString()).to.be.eq('10.0');
            expect(ethers.formatEther(voter2AfterBalance - voter2PreBalance).toString()).to.be.eq('10.0');
        })

        it('If proposals are vetoed, deposits are burned', async () => {
            const proposal = returnTextProposal();
            const proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseEther("50"),
                gasLimit: 1000000
            });
            await tx.wait();
            const voteTx = await govContract.vote(proposalId, 4);
            await voteTx.wait();
            console.log('Voted, vetoed and waiting');
            const userPreBalance = await admin.evmWallet.queryBalance();
            await waitFor(30);
            const userAfterBalance = await admin.evmWallet.queryBalance();
            const proposalQuery = await govQueryClient.gov.proposal(Number(proposalId));
            expect(proposalQuery.proposal.status).to.be.eq(4);
            expect(ethers.formatEther(userAfterBalance - userPreBalance).toString()).to.be.eq('0.0');
        });

        it('Users cant deposit to proposals that are not existing', async () => {
            const userBalance = await admin.evmWallet.queryBalance();
            try{
                const depositTx = await govContract.deposit(9999, {
                    value: ethers.parseEther("50"),
                    gasLimit: 1000000
                });
                await depositTx.wait();
                throw new Error('Should return');
            } catch(e: any){
                expect(e.message).to.include('execution reverted');
            }
            const userAfterBalance = await admin.evmWallet.queryBalance();
            expect(Number(ethers.formatEther(userBalance - userAfterBalance))).to.be.within(0, 1);
        });

        it('Users can deposit and min deposit is different for expedited proposals hence wont move to voting period', async () => {
            const proposal = returnTextProposal(true);
            const proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseEther("10"),
                gasLimit: 1000000
            });
            await tx.wait();

            const additionalDepositTx = await govContract.deposit(proposalId, {
                value: ethers.parseEther("5"),
                gasLimit: 1000000
            });
            await additionalDepositTx.wait();

            const proposalQuery = await govQueryClient.gov.proposal(Number(proposalId));
            expect(proposalQuery.proposal.status).to.be.eq(1); // Deposit period
            expect(proposalQuery.proposal.totalDeposit[0].amount).to.be.eq("15000000");
        });
    });

    describe('Proposal voting tests', function () {

        it('Users cant vote on a proposal on deposit period', async () => {
            const proposal = returnTextProposal();
            const proposalId = await getProposalID(govContract, proposal);

            const tx = await govContract.submitProposal(proposal, {
                value: ethers.parseEther("5"),
                gasLimit: 1000000
            });
            await tx.wait();

            const initialProposal = await govQueryClient.gov.proposal(Number(proposalId));
            expect(initialProposal.proposal.status).to.be.eq(1); // Deposit period

            try {
                const voteTx = await govContract.connect(voter1.evmWallet.wallet).vote(proposalId, 1); // 1 = YES
                await voteTx.wait();
                throw new Error("Should have failed to vote on proposal in deposit period");
            } catch (e: any) {
                expect(e.message).to.include("execution reverted");
            };
            const vote = await govQueryClient.gov.tally(proposalId);
            expect(Object.values(vote.tally)).to.be.deep.eq(['0', '0', '0', '0']);
        });

        it('Users cant vote on unexisting periods', async () => {
            const nonExistentProposalId = 99999;
            try {
                const voteTx = await govContract.connect(voter1.evmWallet.wallet).vote(nonExistentProposalId, 1);
                await voteTx.wait();
                throw new Error("Should have failed to vote on non-existent proposal");
            } catch (e: any) {
                expect(e.message).to.include("execution reverted");
            }

            try {
                const options = [
                    { option: 1, weight: "0.7" }, // 70% YES
                    { option: 2, weight: "0.3" }  // 30% ABSTAIN
                ];

                const voteTx = await govContract.connect(voter1.evmWallet.wallet)
                    .voteWeighted(nonExistentProposalId, options);
                await voteTx.wait();
                throw new Error("Should have failed to weighted vote on non-existent proposal");
            } catch (e: any) {
                expect(e.message).to.include("execution reverted");
            }
        });

        it('Unstaked user can vote on a proposal but votes are not affecting the tally', async () => {
            const proposal = returnTextProposal();
            const proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: depositAmount,
                gasLimit: 1000000
            });
            await tx.wait();

            const initialProposal = await govQueryClient.gov.proposal(Number(proposalId));
            expect(initialProposal.proposal.status).to.be.eq(2); // Voting period

            const initialTally = await govQueryClient.gov.tally(Number(proposalId));

            // Have an unstaked user vote
            // We can use voter1 or voter2 since they don't have stakes according to the context
            const voteTx = await govContract.connect(voter1.evmWallet.wallet).vote(proposalId, 1); // 1 = YES
            await voteTx.wait();
            const afterTally = await govQueryClient.gov.tally(Number(proposalId));
            expect(afterTally.tally.yes).to.be.eq(initialTally.tally.yes);

            const adminVoteTx = await govContract.connect(admin.evmWallet.wallet).vote(proposalId, 1); // 1 = YES
            await adminVoteTx.wait();

            const finalTally = await govQueryClient.gov.tally(Number(proposalId));
            expect(BigInt(finalTally.tally.yes)).to.be.gt(BigInt(afterTally.tally.yes));
        });

        it('Staked users can cast weighted vote on an active proposal', async () => {
            const proposal = returnTextProposal();
            // Submit the proposal and get its ID
            const proposalId = await govContract.submitProposal.staticCall(proposal, {
                value: depositAmount
            });

            const tx = await govContract.submitProposal(proposal, {
                value: depositAmount,
                gasLimit: 1000000
            });
            await tx.wait();

            const initialProposal = await govQueryClient.gov.proposal(Number(proposalId));
            expect(initialProposal.proposal.status).to.be.eq(2); // Voting period

            // Create weighted vote options
            const options = [
                { option: 1, weight: "0.6" },
                { option: 3, weight: "0.4" }
            ];

            // Cast weighted vote with admin (who has stake)
            const voteTx = await govContract.connect(admin.evmWallet.wallet)
                .voteWeighted(proposalId, options);
            await voteTx.wait();

            // Get tally after vote
            const afterTally = await govQueryClient.gov.tally(Number(proposalId));
            console.log(afterTally);
        });

        it('Users can vote multiple times on a proposal', async () => {
           const proposal = returnTextProposal();
           const proposalId = await getProposalID(govContract, proposal);
           const tx = await govContract.submitProposal(proposal, {
               value: depositAmount,
               gasLimit: 1000000
           });
           await tx.wait();
           const initialProposal = await govQueryClient.gov.proposal(Number(proposalId));
           expect(initialProposal.proposal.status).to.be.eq(2);
           const vote1Tx = await govContract.vote(proposalId, 1);
           await vote1Tx.wait();
           const tallyBefore = await govQueryClient.gov.tally(Number(proposalId));
           const vote2Tx = await govContract.vote(proposalId, 1);
           await vote2Tx.wait();
           const tally = await govQueryClient.gov.tally(Number(proposalId));
           expect(JSON.stringify(tallyBefore.tally)).to.be.eq(JSON.stringify(tally.tally));
        });

        it('Incorrect vote options are rejected', async () => {
            const proposal = returnTextProposal();
            const proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: depositAmount,
                gasLimit: 1000000
            });
            await tx.wait();
            const initialProposal = await govQueryClient.gov.proposal(Number(proposalId));
            expect(initialProposal.proposal.status).to.be.eq(2);

            const options = [
                { option: 1, weight: "0.6" },
                { option: 3, weight: "0.2" }
            ];
            try{
                const voteTx = await govContract.voteWeighted(proposalId, options);
                await voteTx.wait();
                throw new Error('Should return');
            } catch(e: any){
                expect(e.message).to.include('execution reverted');
            }
        });
    });

    describe('Proposal tally tests', function () {
        it('Given that a proposal is rejected it is not executed', async () => {
            const paramChangeProposal = JSON.stringify({
                "title": "Gov Param Change",
                "description": "Update quorum to 0.90",
                "type": "ParameterChange",
                "changes": [
                    {
                        "subspace": "gov",
                        "key": "tallyparams",
                        "value": {
                            "quorum": "0.90"
                        }
                    }
                ],
                "is_expedited": false,
                "deposit": "50000000usei"
            });

            const proposalId = await getProposalID(govContract, paramChangeProposal);
            const broadcastTx = await govContract.submitProposal(paramChangeProposal, {
                value: ethers.parseEther("11"),
                gasLimit: 1000000
            });
            await broadcastTx.wait();

            //admin vetoes it
            const voteTx = await govContract.vote(proposalId, 3);
            await voteTx.wait();
            await waitFor(30);

            const status = await govQueryClient.gov.proposal(Number(proposalId));
            expect(status.proposal.status).to.be.eq(4);

            const parameters = await govQueryClient.gov.params('tallying');
            const textDecoder = new TextDecoder('utf-8');
            console.log(textDecoder.decode(parameters.tallyParams.quorum));
            console.log(textDecoder.decode(parameters.tallyParams.threshold));
            console.log(textDecoder.decode(parameters.tallyParams.vetoThreshold));
        });

        it('Given that a proposal passed, deposits are returned to the users', async () => {
            const textProposal = JSON.stringify({
                "title": "Test Deposit Period Voting",
                "description": "Testing voting power of unstaked users",
                "type": "Text",
                "is_expedited": false
            });
            const proposalId = await getProposalID(govContract, textProposal);
            const tx = await govContract.submitProposal(textProposal, {
                value: depositAmount,
                gasLimit: 1000000
            });
            await tx.wait();
            const voteTx = await govContract.vote(proposalId, 1);
            await voteTx.wait();
            const userBalance = await admin.evmWallet.queryBalance();
            await waitFor(30);
            const userAfterBalance = await admin.evmWallet.queryBalance();
            expect(ethers.formatEther(userAfterBalance - userBalance).toString()).to.be.eq('10.0');
            const proposalQuery = await govQueryClient.gov.proposal(Number(proposalId));
            expect(proposalQuery.proposal.status).to.be.eq(3);
        });

        it('Votes are counted correctly', async () => {
            // voter1 stakes 1000 sei
            const stakeTx = await stakingContract.connect(voter1.evmWallet.wallet).delegate(validatorAddress1, {value: ethers.parseEther("5")});
            await stakeTx.wait();
            const stakeTx2 = await stakingContract.connect(voter2.evmWallet.wallet).delegate(validatorAddress1, {value: ethers.parseEther("5")});
            await stakeTx2.wait();

            const proposal = JSON.stringify({
                "title": "Test Voting Period Voting",
                "description": "Testing voting power of staked users",
                "type": "Text",
                "is_expedited": false
            });
            const proposalId = await getProposalID(govContract, proposal);
            const tx = await govContract.submitProposal(proposal, {
                value: depositAmount,
                gasLimit: 1000000
            });
            await tx.wait();
            const vote1Tx = await govContract.connect(voter1.evmWallet.wallet).vote(proposalId, 1);
            const vote2Tx = await govContract.connect(voter2.evmWallet.wallet).vote(proposalId, 2);
            const vote3Tx = await govContract.vote(proposalId, 3);
            await Promise.all([vote1Tx.wait(), vote2Tx.wait(), vote3Tx.wait()]);
            await waitFor(30);
            const tally = await govQueryClient.gov.tally(proposalId);
            expect(tally.tally.yes).to.be.eq('5000000');
            expect(tally.tally.abstain).to.be.eq('5000000');

            const proposalStatus = await govQueryClient.gov.proposal(proposalId);
            expect(proposalStatus.proposal.status).to.be.eq(4);
        });

        it('Weighted votes are counted correctly', async () => {
            const paramChangeProposal = JSON.stringify({
                "title": "Gov Param Change",
                "description": "Update quorum to 0.90",
                "type": "ParameterChange",
                "changes": [
                    {
                        "subspace": "gov",
                        "key": "tallyparams",
                        "value": {
                            "quorum": "0.10"
                        }
                    }
                ],
                "is_expedited": false,
                "deposit": "50000000usei"
            });

            const proposalId = await getProposalID(govContract, paramChangeProposal);
            const broadcastTx = await govContract.submitProposal(paramChangeProposal, {
                value: ethers.parseEther("11"),
                gasLimit: 1000000
            });
            await broadcastTx.wait();
            const options = [
                { option: 1, weight: "0.7" }, // 70% YES
                { option: 2, weight: "0.3" }  // 30% ABSTAIN
            ];
            const totalStake = await queryAllStakes(admin);
            console.log(totalStake);
            const voteTx = await govContract.connect(admin.evmWallet.wallet)
                .voteWeighted(proposalId, options);
            await voteTx.wait();
            const tally = await govQueryClient.gov.tally(proposalId);
            console.log(tally);
            await waitFor(75);
            const status = await govQueryClient.gov.proposal(Number(proposalId));
            // expect(status.proposal.status).to.be.eq(3);
            console.log(status);
            const parameters = await govQueryClient.gov.params('tallying');
            const textDecoder = new TextDecoder('utf-8');
            console.log(textDecoder.decode(parameters.tallyParams.quorum));
            expect(textDecoder.decode(parameters.tallyParams.quorum)).to.be.eq('100000000000000000');
        });

        it('Invalid proposals wont be executed', async () =>{
            const paramChangeProposal = JSON.stringify({
                "title": "Gov Param Change",
                "description": "Update quorum to 0.90",
                "type": "ParameterChange",
                "changes": [
                    {
                        "subspace": "gov",
                        "key": "tallyparams",
                        "value": {
                            "quorum": "3.10"
                        }
                    }
                ],
                "is_expedited": false,
                "deposit": "50000000usei"
            });

            const proposalId = await getProposalID(govContract, paramChangeProposal);
            const broadcastTx = await govContract.submitProposal(paramChangeProposal, {
                value: ethers.parseEther("11"),
                gasLimit: 1000000
            });
            await broadcastTx.wait();
            const voteTx = await govContract.vote(proposalId, 1);
            await voteTx.wait();
            await waitFor(30);
            const status = await govQueryClient.gov.proposal(Number(proposalId));
            expect(status.proposal.status).to.be.eq(5);
            const parameters = await govQueryClient.gov.params('tallying');
            const textDecoder = new TextDecoder('utf-8');
            console.log(textDecoder.decode(parameters.tallyParams.quorum));
            expect(textDecoder.decode(parameters.tallyParams.quorum)).to.be.eq('100000000000000000');
        });

    });
});
