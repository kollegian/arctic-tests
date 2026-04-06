import {DirectSecp256k1HdWallet, Registry} from '@cosmjs/proto-signing';
import {coin, coins, GovExtension, QueryClient, SigningStargateClient} from '@cosmjs/stargate';
import {generateValidAddress, waitFor} from '../tokenfactory/helpers';
import {createGovQueryClient, createProposal, createSeiProvider, depositOnProposal} from '../utils/utils';
import {restEndpoint, rpcEndpoint} from '../constants';
import { Querier } from '@sei-js/cosmos/rest';
import { seiProtoRegistry } from '@sei-js/cosmos/encoding/stargate';
import {fee} from '../tokenfactory/types';
import ExpectStatic = Chai.ExpectStatic;
import {QueryProposalResponse} from 'cosmjs-types/cosmos/gov/v1/query';
import { Encoder } from '@sei-js/cosmos/encoding';
import {MsgDeposit} from 'cosmjs-types/cosmos/gov/v1beta1/tx';
let expect: ExpectStatic;

describe('Governance Queries', function () {
  this.timeout(4 * 60 * 1000);
  let seiWallet: DirectSecp256k1HdWallet;
  let signingClient: SigningStargateClient;
  let seiAddress: string;
  let proposalId: string;

  before('', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    seiWallet = await generateValidAddress();
    await waitFor(1);
    seiAddress = (await seiWallet.getAccounts())[0].address;
    signingClient = await createSeiProvider(rpcEndpoint, seiWallet);
    proposalId = await createProposal(signingClient, seiAddress);
  });

  it('Deposits on proposal with sei-js', async () =>{
    const msgDepositValue = Encoder.cosmos.gov.v1beta1.MsgDeposit.fromPartial({
      proposal_id: Number(proposalId),
      depositor: seiAddress,
      amount: coins('100000', 'usei')
    })
    const msgDeposit = {
      typeUrl: `/${Encoder.cosmos.gov.v1beta1.MsgDeposit.$type}`,
      value: msgDepositValue
    }
    const response = await signingClient.signAndBroadcast(seiAddress, [msgDeposit], fee, 'deposit on proposal');
    console.log(response);
  });

  it('deposit on proposal with cosm-js', async () =>{
    const sClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, seiWallet);
    const msg = {
      typeUrl: "/cosmos.gov.v1beta1.MsgDeposit",
      value: {
        proposal_id: Number(proposalId),
        depositor: seiAddress,
        amount: coins('100000', 'usei')
      },
    }
    const response = await sClient.signAndBroadcast(seiAddress, [msg], fee, 'Deposit to proposal');
    console.log(response);
  })

  it('Votes on proposal', async () =>{
    const msgVoteValue = Encoder.cosmos.gov.v1beta1.MsgVote.fromPartial({
      proposal_id: Number(proposalId),
      voter:seiAddress,
      option: 1
    })
    const msgVote = {
      typeUrl: `/${Encoder.cosmos.gov.v1beta1.MsgVote.$type}`,
      value: msgVoteValue
    }
    const response = await signingClient.signAndBroadcast(seiAddress, [msgVote], fee, 'vote on proposal');
    console.log(response);
  });

  it('Query proposal', async () =>{
    const response = await Querier.cosmos.gov.v1beta1.Proposal({
      proposal_id: Number(proposalId)
    }, {pathPrefix: restEndpoint});
    expect(response.proposal!.proposal_id).to.be.eq(proposalId)
    expect(response.proposal!.status).to.be.eq('PROPOSAL_STATUS_DEPOSIT_PERIOD');
  });

  it('Query all proposals', async () =>{
    const response = await Querier.cosmos.gov.v1beta1.Proposals({
      proposal_status: 0,
      voter: '',
      depositor: ''
    }, {pathPrefix: restEndpoint});
    console.log(response);
  });

  it('Query deposit', async () =>{
    const depWallet = await generateValidAddress();
    await waitFor(1);
    const address = (await depWallet.getAccounts())[0].address;
    // const registry = new Registry(seiProtoRegistry);
    const sClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, depWallet);
    const tx = await depositOnProposal(sClient, address, proposalId);
    const response = await Querier.cosmos.gov.v1beta1.Deposit({
      proposal_id: Number(proposalId),
      depositor: seiAddress
    }, {pathPrefix: restEndpoint});
    // expect(response.deposit?.amount).to.be.gt(0);
    console.log(response.deposit?.amount);
  });

  it('Query vote', async () =>{
    const queryClient = await createGovQueryClient(rpcEndpoint) as QueryClient & GovExtension;
    let response = await queryClient.gov.proposal(proposalId);
    console.log(response);
    // await waitFor(75);
    console.log('Waited for a minute for vote period');
    response = await queryClient.gov.proposal(proposalId);
    console.log(response);
    /*const response = await Querier.cosmos.gov.v1beta1.Proposal({
      proposal_id: Number(proposalId)
    }, {pathPrefix: restEndpoint});
    console.log(response);*/
    const msg = {
      typeUrl: "/cosmos.gov.v1beta1.MsgVote",
      value: {
        proposalId: proposalId,
        voter: seiAddress,
        option: 1,
      },
    };
    // const sClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, seiWallet);
    const result = await signingClient.signAndBroadcast(seiAddress, [msg], fee, "");
    console.log("Successfully voted on proposal:", result);
  });

});
