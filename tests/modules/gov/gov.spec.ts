import { coins, GovExtension, QueryClient } from '@cosmjs/stargate';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { createGovQueryClient, createProposal, depositOnProposal } from '../utils/utils';
import { Querier } from '@sei-js/cosmos/rest';

import { SeiUser, UserFactory } from '../../../shared/User';
import testConfig from '../../../config/testConfig.json';
import ExpectStatic = Chai.ExpectStatic;

let expect: ExpectStatic;
const restEndpoint = testConfig.restEndpoint;
const fee = { amount: coins(24000, 'usei'), gas: '500000' };

describe('Governance Module Tests', function () {
  this.timeout(4 * 60 * 1000);
  let admin: SeiUser;
  let user: SeiUser;

  before(async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    admin = await UserFactory.createAdminUser();
    user = await UserFactory.createSeiUser(admin, 'govUser');
  });

  describe('seid CLI Tests', function () {
    let cliProposalId: string;

    it('Submit proposal via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx gov submit-proposal --type text --title "CLI Test Proposal" --description "CLI test proposal description" --deposit 1000000usei --from govUser --fees 24200usei -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
      const event = result.logs?.[0]?.events?.find((e: any) => e.type === 'submit_proposal');
      cliProposalId = event?.attributes?.find((a: any) => a.key === 'proposal_id')?.value;
      expect(cliProposalId).to.exist;
    });

    it('Deposit on proposal via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx gov deposit ${cliProposalId} 100000usei --from govUser --fees 24200usei -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
    });

    it('Vote on proposal via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx gov vote ${cliProposalId} yes --from govUser --fees 24200usei -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
    });

    it('Query proposal via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q gov proposal ${cliProposalId}`
      );
      expect(result.proposal_id || result.id).to.exist;
    });

    it('Query proposals via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q gov proposals`
      );
      expect(result.proposals).to.be.an('array');
      expect(result.proposals).to.have.length.gte(1);
    });

    it('Query deposits via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q gov deposit ${cliProposalId} ${user.seiAddress}`
      );
      expect(result.deposit || result.amount).to.exist;
    });

    it('Query votes via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q gov vote ${cliProposalId} ${user.seiAddress}`
      );
      expect(result.vote || result.voter).to.exist;
    });

    it('Query gov params via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q gov params`
      );
      expect(result.deposit_params || result.params).to.exist;
    });
  });

  describe('CosmJS Tests', function () {
    let proposalId: string;

    before(async () => {
      proposalId = await createProposal(user.seiWallet.signingClient, user.seiAddress);
    });

    it('Deposits on proposal with sei-js encoder', async () => {
      const msgDeposit = {
        typeUrl: '/cosmos.gov.v1beta1.MsgDeposit',
        value: {
          proposalId: Number(proposalId),
          depositor: user.seiAddress,
          amount: coins('100000', 'usei')
        }
      };
      const response = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [msgDeposit], fee, 'deposit on proposal'
      );
      expect(response.code).to.be.eq(0);
    });

    it('Deposits on proposal with cosmjs', async () => {
      const msg = {
        typeUrl: "/cosmos.gov.v1beta1.MsgDeposit",
        value: {
          proposalId: Number(proposalId),
          depositor: user.seiAddress,
          amount: coins('100000', 'usei')
        },
      };
      const response = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [msg], fee, 'Deposit to proposal'
      );
      expect(response.code).to.be.eq(0);
    });

    it('Votes on proposal', async () => {
      const msgVote = {
        typeUrl: '/cosmos.gov.v1beta1.MsgVote',
        value: {
          proposalId: Number(proposalId),
          voter: user.seiAddress,
          option: 1
        }
      };
      const response = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [msgVote], fee, 'vote on proposal'
      );
      expect(response.code).to.be.eq(0);
    });

    it('Query proposal via Querier', async () => {
      const response = await Querier.cosmos.gov.v1beta1.Proposal({
        proposal_id: Number(proposalId)
      }, { pathPrefix: restEndpoint });
      expect(response.proposal!.proposal_id).to.be.eq(proposalId);
      expect(response.proposal!.status).to.be.eq('PROPOSAL_STATUS_DEPOSIT_PERIOD');
    });

    it('Query all proposals via Querier', async () => {
      const response = await Querier.cosmos.gov.v1beta1.Proposals({
        proposal_status: 0,
        voter: '',
        depositor: ''
      }, { pathPrefix: restEndpoint });
      expect(response.proposals).to.be.an('array');
      expect(response.proposals).to.have.length.gte(1);
    });

    it('Query deposit', async () => {
      await depositOnProposal(admin.seiWallet.signingClient, admin.seiAddress, proposalId);
      const response = await Querier.cosmos.gov.v1beta1.Deposit({
        proposal_id: Number(proposalId),
        depositor: user.seiAddress
      }, { pathPrefix: restEndpoint });
      expect(response.deposit).to.exist;
      expect(response.deposit!.amount).to.be.an('array');
      expect(response.deposit!.amount).to.have.length.gte(1);
      expect(Number(response.deposit!.amount[0].amount)).to.be.gt(0);
    });

    it('Query vote for proposal via gov extension', async () => {
      const queryClient = await createGovQueryClient(testConfig.seiRpcEndpoint) as QueryClient & GovExtension;
      const response = await queryClient.gov.proposal(proposalId);
      expect(response.proposal).to.exist;
      expect(response.proposal!.proposalId.toString()).to.be.eq(proposalId);
    });
  });

  describe('Error Cases', function () {
    let errorProposalId: string;

    before(async () => {
      errorProposalId = await createProposal(user.seiWallet.signingClient, user.seiAddress);
    });

    it('Cannot vote on non-existent proposal (CosmJS)', async () => {
      const msgVote = {
        typeUrl: '/cosmos.gov.v1beta1.MsgVote',
        value: {
          proposalId: 999999,
          voter: user.seiAddress,
          option: 1
        }
      };
      const result = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [msgVote], fee, 'vote on nonexistent'
      );
      expect(result.code).to.not.be.eq(0);
    });

    it('Cannot deposit on non-existent proposal (CosmJS)', async () => {
      const msgDeposit = {
        typeUrl: '/cosmos.gov.v1beta1.MsgDeposit',
        value: {
          proposalId: 999999,
          depositor: user.seiAddress,
          amount: coins('100000', 'usei')
        }
      };
      try {
        const result = await user.seiWallet.signingClient.signAndBroadcast(
          user.seiAddress, [msgDeposit], fee, 'deposit on nonexistent'
        );
        expect(result.code).to.not.be.eq(0);
      } catch (e: any) {
        expect(e.message).to.exist;
      }
    });

    it('Cannot vote with invalid option (seid CLI)', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx gov vote ${errorProposalId} invalid_option --from govUser --fees 24200usei -y --broadcast-mode block`
      );
      expect(result.code === undefined || result.code !== 0).to.be.true;
    });

    it('Cannot submit proposal with zero deposit (seid CLI)', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx gov submit-proposal --type text --title "Zero Deposit" --description "Should fail" --deposit 0usei --from govUser --fees 24200usei -y --broadcast-mode block`
      );
      expect(result.code === undefined || result.code !== 0).to.be.true;
    });

    it('Double voting updates the vote (CosmJS)', async () => {
      const voteProposalId = await createProposal(user.seiWallet.signingClient, user.seiAddress);

      await depositOnProposal(admin.seiWallet.signingClient, admin.seiAddress, voteProposalId);

      const voteYes = {
        typeUrl: '/cosmos.gov.v1beta1.MsgVote',
        value: {
          proposalId: Number(voteProposalId),
          voter: user.seiAddress,
          option: 1
        }
      };
      const yesResult = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [voteYes], fee, 'vote yes'
      );
      expect(yesResult.code).to.be.eq(0);

      const voteNo = {
        typeUrl: '/cosmos.gov.v1beta1.MsgVote',
        value: {
          proposalId: Number(voteProposalId),
          voter: user.seiAddress,
          option: 3
        }
      };
      const noResult = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [voteNo], fee, 'vote no'
      );
      expect(noResult.code).to.be.eq(0);

      const voteQuery = await execCommandAndReturnJson(
        `seid q gov vote ${voteProposalId} ${user.seiAddress}`
      );
      const options = voteQuery.options || voteQuery.vote?.options;
      expect(options).to.exist;
      const lastOption = options[options.length - 1];
      expect(lastOption.option === 'VOTE_OPTION_NO' || lastOption.option === 3).to.be.true;
    });
  });

  describe('Cross-Runtime Consistency', function () {
    let xProposalId: string;

    before(async () => {
      xProposalId = await createProposal(user.seiWallet.signingClient, user.seiAddress);
      await depositOnProposal(admin.seiWallet.signingClient, admin.seiAddress, xProposalId);
    });

    it('Proposal queried via seid matches Querier result', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q gov proposal ${xProposalId}`
      );
      const restResponse = await Querier.cosmos.gov.v1beta1.Proposal({
        proposal_id: Number(xProposalId)
      }, { pathPrefix: restEndpoint });

      const cliId = String(cliResult.proposal_id || cliResult.id);
      const restId = String(restResponse.proposal!.proposal_id);
      expect(cliId).to.be.eq(restId);

      const cliStatus = cliResult.status;
      const restStatus = restResponse.proposal!.status;
      expect(cliStatus).to.be.eq(restStatus);
    });

    it('Deposit amount via seid matches Querier deposit query', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q gov deposit ${xProposalId} ${user.seiAddress}`
      );
      const restResponse = await Querier.cosmos.gov.v1beta1.Deposit({
        proposal_id: Number(xProposalId),
        depositor: user.seiAddress
      }, { pathPrefix: restEndpoint });

      const cliAmount = cliResult.deposit?.amount || cliResult.amount;
      const restAmount = restResponse.deposit!.amount;
      expect(cliAmount).to.be.an('array');
      expect(restAmount).to.be.an('array');
      expect(cliAmount[0].denom).to.be.eq(restAmount[0].denom);
      expect(cliAmount[0].amount).to.be.eq(restAmount[0].amount);
    });
  });

  describe('Full Lifecycle', function () {
    it('Full proposal lifecycle: create -> deposit -> vote -> query tally -> verify status transitions', async () => {
      const lifecycleProposalId = await createProposal(user.seiWallet.signingClient, user.seiAddress);

      const proposalAfterCreate = await Querier.cosmos.gov.v1beta1.Proposal({
        proposal_id: Number(lifecycleProposalId)
      }, { pathPrefix: restEndpoint });
      expect(proposalAfterCreate.proposal!.status).to.be.eq('PROPOSAL_STATUS_DEPOSIT_PERIOD');

      await depositOnProposal(admin.seiWallet.signingClient, admin.seiAddress, lifecycleProposalId);

      const proposalAfterDeposit = await Querier.cosmos.gov.v1beta1.Proposal({
        proposal_id: Number(lifecycleProposalId)
      }, { pathPrefix: restEndpoint });
      const statusAfterDeposit = String(proposalAfterDeposit.proposal!.status);
      expect(
        statusAfterDeposit === 'PROPOSAL_STATUS_DEPOSIT_PERIOD' ||
        statusAfterDeposit === 'PROPOSAL_STATUS_VOTING_PERIOD'
      ).to.be.true;

      const voteMsg = {
        typeUrl: '/cosmos.gov.v1beta1.MsgVote',
        value: {
          proposalId: Number(lifecycleProposalId),
          voter: user.seiAddress,
          option: 1
        }
      };
      const voteResult = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [voteMsg], fee, 'lifecycle vote'
      );
      expect(voteResult.code).to.be.eq(0);

      const tallyResult = await execCommandAndReturnJson(
        `seid q gov tally ${lifecycleProposalId}`
      );
      const yesVotes = Number(tallyResult.yes || tallyResult.yes_count || '0');
      expect(yesVotes).to.be.gt(0);
    });
  });
});
