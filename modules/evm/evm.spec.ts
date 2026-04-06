import { DirectSecp256k1HdWallet, Registry } from '@cosmjs/proto-signing';
import {coins, SigningStargateClient} from '@cosmjs/stargate';
import { seiProtoRegistry } from '@sei-js/cosmos/encoding/stargate';
import { Querier } from '@sei-js/cosmos/rest';
import { Encoder } from '@sei-js/cosmos/encoding';
import {ethers, hexlify, toBeHex} from 'ethers';
import ExpectStatic = Chai.ExpectStatic;
import {fundAddress, generateValidAddress, waitFor} from '../whitelist_tests/helpers';
import {fundEvmWallet} from '../evm_rpc/utils/cmdUtils'
import {generateEvmAddressFromMnemonic, generateSeiAddressFromMnemonic} from '../evm_rpc/utils/seiUtils';
import {sendFundsFromEvmClient} from '../evm_rpc/utils/evmUtils';
import {registerPointer} from './utils';
import abi from '../evm_rpc/artifacts/MockERC20.json';
let expect: ExpectStatic;

const restEndpoint = 'http://127.0.0.1:1317';
const evmRpcEndpoint = 'http://127.0.0.1:8545';
const rpcEndpoint = 'http://127.0.0.1:26657';

const fee = {
  amount: coins(24500, "usei"),
  gas: "200000",
};

describe('EVM Module Tests', function () {
  this.timeout(5 * 60 * 1000);
  let seiWallet: DirectSecp256k1HdWallet;
  let seiAddress: string;
  let evmAddress: string;
  let newEvmAddress: string;
  let evmProvider: ethers.JsonRpcProvider;
  let signingClient: SigningStargateClient;
  let registry: Registry;
  let evmWallet: ethers.HDNodeWallet;
  let newEvmWallet: ethers.HDNodeWallet;

  before('Initialize', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    seiWallet = await generateValidAddress();
    await waitFor(1);
    evmProvider = new ethers.JsonRpcProvider(evmRpcEndpoint);
    evmWallet = ethers.Wallet.createRandom().connect(evmProvider);
    evmAddress = evmWallet.address;
    //@ts-ignore
    await fundEvmWallet(evmWallet, evmRpcEndpoint);
    await waitFor(1);
    newEvmWallet = ethers.Wallet.createRandom().connect(evmProvider);
    newEvmWallet= newEvmWallet.connect(evmProvider);
    evmWallet = evmWallet.connect(evmProvider);
    newEvmAddress = newEvmWallet.address;
    //@ts-ignore
    await fundEvmWallet(newEvmWallet, evmRpcEndpoint);
    await waitFor(1);
    registry = new Registry(seiProtoRegistry);
    signingClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, seiWallet, { registry });
  });



  it('Can associate an EVM address with a Sei address', async () => {
    const senderAddress = (await seiWallet.getAccounts())[0].address;
    const evmAddress = await generateEvmAddressFromMnemonic(seiWallet);
    let response = await Querier.evm.EVMAddressBySeiAddress({ sei_address: senderAddress }, { pathPrefix: restEndpoint });
    expect(response.evm_address).to.be.eq('');
    expect(response.associated).to.be.false;

    const msgAssociate = Encoder.evm.MsgAssociate.fromPartial({
      sender: senderAddress,
      custom_message: 'customMessage',
    });

    const msgSend = {
      typeUrl: `/${Encoder.evm.MsgAssociate.$type}`,
      value: msgAssociate,
    };
    const registry = new Registry(seiProtoRegistry);
    const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, seiWallet, { registry });
    const txResult = await client.signAndBroadcast(senderAddress, [msgSend], fee);
    expect(txResult.code).to.equal(0); // Ensure the transaction was successful

    response = await Querier.evm.EVMAddressBySeiAddress({ sei_address: senderAddress }, { pathPrefix: restEndpoint });
    expect(response.evm_address.toLowerCase()).to.be.eq(evmAddress.toLowerCase());
    expect(response.associated).to.be.true;
  });

  it('Can query Sei address by EVM address', async () => {
    //@ts-ignore
    const seiAddress = await generateSeiAddressFromMnemonic(evmWallet);

    //Implicitly associate
    //@ts-ignore
    await sendFundsFromEvmClient(evmWallet, newEvmAddress, '0.1');
    const response = await Querier.evm.SeiAddressByEVMAddress({ evm_address: evmAddress }, { pathPrefix: restEndpoint });
    expect(response.sei_address.toLowerCase()).to.be.eq(seiAddress.toLowerCase());
    expect(response.associated).to.be.true;
  });

  it('Querying not associated address returns correct value', async () =>{
    const response = await Querier.evm.SeiAddressByEVMAddress({ evm_address: newEvmAddress }, { pathPrefix: restEndpoint });
    expect(response.sei_address).to.be.eq('');
    expect(response.associated).to.be.false;
  });

  it('Querying not associated address returns correct value from sei address', async () =>{
    const newSeiWallet = await generateValidAddress();
    const senderAddress = (await newSeiWallet.getAccounts())[0].address;
    const response = await Querier.evm.EVMAddressBySeiAddress({ sei_address: senderAddress }, { pathPrefix: restEndpoint });
    expect(response.evm_address.toLowerCase()).to.be.eq('');
    expect(response.associated).to.be.false;
  });

  it.skip('Cannot associate an EVM address that is already associated', async () => {
    const senderAddress = (await seiWallet.getAccounts())[0].address;

    const msgAssociate = Encoder.evm.MsgAssociate.fromPartial({
      sender: senderAddress,
      custom_message: 'customMessage',
    });

    const msgSend = {
      typeUrl: `/${Encoder.evm.MsgAssociate.$type}`,
      value: msgAssociate,
    };
    const registry = new Registry(seiProtoRegistry);
    const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, seiWallet, { registry });
    const txResult = await client.signAndBroadcast(senderAddress, [msgSend], fee);
    console.log(txResult.rawLog);
    expect(txResult.rawLog).to.contain('EVM address already associated');
  });

  it('Can register an ERC20 pointer', async () => {
    const erc20Address = evmAddress;
    const txResult = await registerPointer(seiWallet, erc20Address, 'ERC20', signingClient);
    expect(txResult.code).to.equal(0); // Ensure the transaction was successful

    // Query the pointer using Querier
    const response = await Querier.evm.Pointer(
      { pointer_type: 0, pointee: erc20Address },
      { pathPrefix: restEndpoint }
    );
    expect(response.pointer).to.exist;
    expect(response.exists).to.be.true;
    console.log(response);
  });

  it('Can get pointer version', async () => {
    const response = await Querier.evm.PointerVersion({ pointer_type: 0 }, { pathPrefix: restEndpoint });
    console.log(response);
    expect(response.version).to.be.a('number');
    expect(response.cw_code_id).to.be.a('string');
  });

  it.only('Can execute a static call', async () => {
    const contractFactory = new ethers.ContractFactory(abi.abi, abi.bytecode, evmWallet);
    const contract = await contractFactory.deploy('Test', 'TST', '1000000000000000');
    await contract.waitForDeployment();
    console.log(await contract.getAddress());
    const data = contract.connect(evmWallet).interface.encodeFunctionData("balanceOf", [evmAddress]);
    const tx = {
      to: await contract.getAddress(),
      data: data,
      from: evmAddress,
    };

    const to = evmAddress;
    console.log(data.slice(2));
    console.log(data);
    const response = await Querier.evm.StaticCall({ data: ethers.toUtf8Bytes(tx.data), to : await contract.getAddress()}, { pathPrefix: restEndpoint });
    expect(response.data).to.exist;
    console.log(response);
  });

  it.only('Can execute an EVM transaction', async () => {
    console.log(await evmProvider.getNetwork());
    const recipientAddress = ethers.Wallet.createRandom().address;
    const tx = {
      to: recipientAddress,
      value: ethers.parseEther('0.01'), // Sending 0.01 ETH
      gasLimit: 21000, // Standard gas limit for ETH transfer
      gasPrice: ethers.parseUnits('10', 'gwei'),
      nonce: await evmProvider.getTransactionCount(evmAddress),
    };

    const signedTx = await evmWallet.signTransaction(tx);
    const msgEVMTransaction = Encoder.evm.MsgEVMTransaction.fromPartial({
      derived: ethers.toUtf8Bytes(signedTx),
    });
    const msgSend = {
      typeUrl: `/${Encoder.evm.MsgEVMTransaction.$type}`,
      value: msgEVMTransaction,
    };
    const senderAddress = (await seiWallet.getAccounts())[0].address;
    const txResult = await signingClient.signAndBroadcast(senderAddress, [msgSend], fee);
    expect(txResult.code).to.equal(0);
    console.log(txResult.rawLog);

  });

  it('Can get pointee by pointer', async () => {
    const erc20Address = evmAddress;
    const txResult = await registerPointer(seiWallet, erc20Address, 'ERC20', signingClient);
    expect(txResult.code).to.equal(0);
    await waitFor(1);
    const pointerResponse = await Querier.evm.Pointer(
      { pointer_type: 0, pointee: erc20Address },
      { pathPrefix: restEndpoint }
    );
    const pointer = pointerResponse.pointer;

    const pointeeResponse = await Querier.evm.Pointee(
      { pointer_type: 0, pointer },
      { pathPrefix: restEndpoint }
    );
    expect(pointeeResponse.pointee).to.be.eq(erc20Address);
    expect(pointeeResponse.exists).to.be.true;
  });
});
