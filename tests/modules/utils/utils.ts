import {
  calculateFee,
  coin,
  coins,
  DeliverTxResponse,
  MsgSubmitProposalEncodeObject, QueryClient, setupGovExtension,
  SigningStargateClient
} from '@cosmjs/stargate';
import {DirectSecp256k1HdWallet, Registry} from '@cosmjs/proto-signing';
import { Encoder } from '@sei-js/cosmos/encoding';
import { seiProtoRegistry } from '@sei-js/cosmos/encoding';
import {SigningCosmWasmClient} from '@cosmjs/cosmwasm-stargate';
import fs from 'node:fs';
import { Any } from 'cosmjs-types/google/protobuf/any';
import {ParameterChangeProposal} from 'cosmjs-types/cosmos/params/v1beta1/params';
import {MsgSubmitProposal} from 'cosmjs-types/cosmos/gov/v1/tx';
import {CometClient, Tendermint34Client} from '@cosmjs/tendermint-rpc';

const fee = {
  amount: coins(50000, "usei"),
  gas: "200000",
};


export function parseEvents(receipt: DeliverTxResponse, searchedEvent: string) {
  return receipt.events.find((event) => event.type === searchedEvent)
    || (() => { throw new Error('Event not found'); })();
}


async function associateEvmAddress(wallet: DirectSecp256k1HdWallet, customMessage = '', signingClient: SigningStargateClient) {
  const senderAddress = (await wallet.getAccounts())[0].address;

  const msgAssociate = Encoder.evm.MsgAssociate.fromPartial({
    sender: senderAddress,
    custom_message: customMessage,
  });

  const msgSend = {
    typeUrl: `/${Encoder.evm.MsgAssociate.$type}`,
    value: msgAssociate,
  };

  return await signingClient.signAndBroadcast(senderAddress, [msgSend], fee);
}

export async function registerPointer(wallet: DirectSecp256k1HdWallet, ercAddress: string, pointerType: 'ERC20' | 'ERC721', client: SigningStargateClient) {
  const senderAddress = (await wallet.getAccounts())[0].address;

  const pointerTypeEnum = pointerType === 'ERC20' ? 0 : 1; // Assuming 0: ERC20, 1: ERC721

  const msgRegisterPointer = Encoder.evm.MsgRegisterPointer.fromPartial({
    sender: senderAddress,
    erc_address: ercAddress,
    pointer_type: pointerTypeEnum,
  });

  const msgSend = {
    typeUrl: `/${Encoder.evm.MsgRegisterPointer.$type}`,
    value: msgRegisterPointer,
  };

  return await client.signAndBroadcast(senderAddress, [msgSend], fee);
}

export async function createSeiWasmProvider(rpcUrl: string, wallet: DirectSecp256k1HdWallet){
  return await SigningCosmWasmClient.connectWithSigner(rpcUrl, wallet, {});
}

export async function deployWasmContract(client: SigningCosmWasmClient, seiAddress: string){
  const wasm = fs.readFileSync("./tests/modules/module_artifacts/cw_nameservice.wasm");
  const uploadFee = calculateFee(4000000, '0.1usei');
  const result = await client.upload(seiAddress, wasm, uploadFee)
  return result.codeId;
}

export async function instantiateCode(client: SigningCosmWasmClient, seiAddress: string, codeId: number){
  const instantiateMsg = {"purchase_price":{"amount":"100","denom":"usei"},"transfer_price":{"amount":"999","denom":"usei"}};
  const instantiateResponse = await client.instantiate(seiAddress, codeId, instantiateMsg, "Our Name Service", fee);
  return instantiateResponse.contractAddress;
}

export async function registerName(client: SigningCosmWasmClient, seiAddress: string, name: string, contractAddress: string){
  const registerMessage = {"register": {"name": name}};
  const purchaseFee = coin('110', 'usei')
  const tx = await client.execute(seiAddress, contractAddress, registerMessage, fee, '', [purchaseFee]);
  return tx;
}

export async function createSeiProvider(rpcUrl: string, wallet: DirectSecp256k1HdWallet){
  const registry = new Registry(seiProtoRegistry);
  return await SigningStargateClient.connectWithSigner(rpcUrl, wallet, {registry});
}

export async function createProposal(signingClient: SigningStargateClient, senderAddress: string){
  const textProposal = Encoder.cosmos.gov.v1beta1.TextProposal.fromPartial({
    title: "Test Proposal",
    description: "This proposal is a test proposal",
  });

  const proposalMsg = {
    typeUrl: '/cosmos.gov.v1beta1.MsgSubmitProposal',
    value: {
      content: {
        typeUrl: '/cosmos.gov.v1beta1.TextProposal',
        value: Uint8Array.from(Encoder.cosmos.gov.v1beta1.TextProposal.encode(textProposal).finish()),
      },
      proposer: senderAddress,
      initialDeposit: [coin("1000000", "usei")],
    },
  };

  const result = await signingClient.signAndBroadcast(senderAddress, [proposalMsg], fee, "title");
  const event = result.events.find(ev=> ev.type === 'submit_proposal');
  return event!.attributes[0].value;
}


export async function createParamProposal(signingClient: SigningStargateClient, senderAddress: string){
  const proposalTitle = 'Parameter Change Proposal';
  const proposalDescription = 'This proposal aims to change certain parameters.';
  const depositAmount = coins(1000000, 'usei');

  // Define the parameter changes
  const paramChanges = [
    {
      subspace: 'staking',
      key: 'MaxValidators',
      value: '105', // New value for the parameter
    },
    {
      subspace: 'staking',
      key: 'UnbondingTime',
      value: '"1814400000000000"', // New value in nanoseconds (e.g., 21 days)
    },
  ];

  // Create the ParameterChangeProposal content
  const parameterChangeProposal = ParameterChangeProposal.fromPartial({
    title: proposalTitle,
    description: proposalDescription,
    changes: paramChanges,
  });

  // Encode the proposal content
  const proposalContentAny = {
    typeUrl: '/cosmos.params.v1beta1.ParameterChangeProposal',
    value: ParameterChangeProposal.encode(parameterChangeProposal).finish(),
  };

  // Create the MsgSubmitProposal message
  const msgSubmitProposal: MsgSubmitProposal = MsgSubmitProposal.fromPartial({
    messages: [proposalContentAny],
    initialDeposit: depositAmount,
    proposer: senderAddress,
  });

  const msgSubmitProposalEncodeObject: MsgSubmitProposalEncodeObject = {
    typeUrl: '/cosmos.gov.v1beta1.MsgSubmitProposal',
    value: msgSubmitProposal,
  };

  // Define the fee
  const fee = {
    amount: coins(2000, 'uatom'), // Adjust the fee amount and denom as needed
    gas: '200000', // Adjust the gas limit as needed
  };

  // Sign and broadcast the transaction
  const result = await signingClient.signAndBroadcast(senderAddress, [msgSubmitProposalEncodeObject], fee);
  const event = result.events.find(ev=> ev.type === 'submit_proposal');
  return event!.attributes[0].value;
}



export async function depositOnProposal(signingClient: SigningStargateClient, depositorAddress: string, proposalId: string) {
  console.log('Proposal Id is ', proposalId)
  const msg = {
    typeUrl: "/cosmos.gov.v1beta1.MsgDeposit",
    value: {
      proposalId: Number(proposalId).toString(),
      depositor: depositorAddress,
      amount: [
        {
          denom: "usei",
          amount: "50000",
        },
      ],
    },
  };

  const result = await signingClient.signAndBroadcast(depositorAddress, [msg], fee, "");
  console.log("Successfully deposited on proposal:", result);
}

export async function voteOnProposal(client: SigningStargateClient, voterAddress: string, proposalId: string) {
  const msg = {
    typeUrl: "/cosmos.gov.v1beta1.MsgVote",
    value: {
      proposalId: proposalId,
      voter: voterAddress,
      option: 1,
    },
  };

  const result = await client.signAndBroadcast(voterAddress, [msg], fee, "");
  const event = result.events.find(ev=> ev.type === 'submit_proposal');
  return event!.attributes[0].value;
}

export async function createGovQueryClient(rpcEndpoint: string){
    const cometClient = await Tendermint34Client.connect(rpcEndpoint);
    const queries = [QueryClient.withExtensions(cometClient, setupGovExtension), cometClient];
    return queries[0];
}