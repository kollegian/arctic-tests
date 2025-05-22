import {ethers} from "ethers";
import {BankExtension, QueryClient, setupBankExtension} from "@cosmjs/stargate";
import util from "node:util";
import {exec as execCallback} from "node:child_process";
import {SeiUser, UserFactory} from '../../shared/User';
import {expect} from "chai";
import {mintTokens, returnContracts, returnQueryClient, setMetadataOfaToken} from './utils';
const exec = util.promisify(execCallback);
import testConfig from "../../config/testConfig.json";
import {createTokenfactoryDenom, execCommandAndReturnJson} from '../../utils/cliUtils';
import {waitFor} from '../../utils/helpers';

describe('Bank Precompile Tests', function ()  {
  this.timeout(3 * 60 * 1000);
  let admin: SeiUser;
  let alice: SeiUser;
  let bankContract: ethers.Contract;
  let denomName: string;
  let bankQueryClient: QueryClient & BankExtension;

  before('Initializes clients and users', async () =>{
    admin = await UserFactory.createAdminUser(testConfig);
    ([alice] = await UserFactory.createSeiUsers(admin, 1, false));

    ({bankContract} = await returnContracts(admin));
    denomName = await createTokenfactoryDenom(alice, admin);
    bankQueryClient = await returnQueryClient(setupBankExtension) as QueryClient & BankExtension;
    console.log(denomName);
  });


  it('Can read balances from precompile', async () => {
    const balance = await bankContract.balance(alice.evmAddress, denomName);
    expect(balance.toString()).to.equal('0');
    await mintTokens(alice, denomName, '1000000');
    const balanceAfter = await bankContract.balance(alice.evmAddress, denomName);
    expect(Number(balanceAfter)).to.equal(Number(balance) + 1000000);
  });

  it('Can read all balances from precompile', async () => {
    const allBalances = await bankContract.all_balances(alice.evmAddress);
    for (const balance of allBalances){
      const denom = balance[1];
      const cosmosBalance = await execCommandAndReturnJson(`seid query bank balances ${alice.seiAddress} --denom ${denom}`);
      expect(Number(cosmosBalance.amount)).to.equal(Number(balance[0]));
    }
  });

  it('Can query decimals info of usei', async () =>{
    const decimals = await bankContract.decimals('usei');
    console.log(decimals);
  });

  it.skip('Can query decimals of a token factory denom', async () =>{
    const preDecimals = await bankContract.decimals(denomName);
    await setMetadataOfaToken(denomName, alice);
    await waitFor(2);
    const decimals = await bankContract.decimals(denomName);
    console.log(decimals);
  });

  it('Can query name of a token factory denom', async () =>{
    const name = await bankContract.name(denomName);
    expect(name).to.be.eq(denomName);
  });

  it('Can use to send tokens to sei address', async () =>{
    const preBalanceCosmos = await bankQueryClient.bank.balance(alice.seiAddress, denomName);
    const preBalanceEvm = await bankContract.balance(alice.evmAddress, denomName);
    const receipt = await execCommandAndReturnJson(`seid tx bank send ${alice.seiAddress} ${admin.seiAddress} 10000${denomName} --from ${alice.seiAddress} --fees 24200usei -y --broadcast-mode block`);
    await waitFor(1);
    const preBalanceSender = await bankContract.balance(admin.evmAddress, denomName);
    console.log(preBalanceCosmos, preBalanceEvm, preBalanceSender);
    const response = await exec(`seid tx evm register-evm-pointer NATIVE ${denomName} --from admin --evm-rpc=http://localhost:8545`);
    await waitFor(1);
    const transferTx = await bankContract.send(admin.evmAddress, alice.evmAddress, denomName, '1000', {gasLimit: 1000000});
    await transferTx.wait();

    const afterBalanceCosmos = await bankQueryClient.bank.balance(alice.seiAddress, denomName);
    const afterBalanceEvm = await bankContract.balance(alice.evmAddress, denomName);
    const afterBalanceSender = await bankContract.balance(admin.evmAddress, denomName);
    expect(Number(afterBalanceCosmos.amount)).to.equal(Number(preBalanceCosmos.amount) + 1000);
    expect(Number(afterBalanceEvm)).to.equal(Number(preBalanceEvm) + 1000);
    expect(Number(afterBalanceSender)).to.equal(Number(preBalanceSender) - 1000);
  });

  it('Can use to send native tokens native evm address', async () =>{
    const preBalanceCosmos = await bankQueryClient.bank.balance(admin.seiAddress, 'usei');
    const preBalanceEvm = await bankContract.balance(admin.evmAddress, 'usei');
    const preBalanceSender = await bankContract.balance(alice.evmAddress, 'usei');

    const transferTx = await bankContract.connect(alice.evmWallet.wallet)
      .sendNative(admin.seiAddress, {value: ethers.parseEther('0.01')});
    await transferTx.wait();

    const afterBalanceCosmos = await bankQueryClient.bank.balance(admin.seiAddress, 'usei');
    const afterBalanceEvm = await bankContract.balance(admin.evmAddress, 'usei');
    const afterBalanceSender = await bankContract.balance(alice.evmAddress, 'usei');

    expect(Number(afterBalanceCosmos.amount)).to.equal(Number(preBalanceCosmos.amount) + 10000);
    expect(Number(afterBalanceEvm)).to.eq(Number(preBalanceEvm) + 10000);
    expect(Number(preBalanceSender) - Number(afterBalanceSender)).to.be.gt(10000);
  });

  it('Can query supply of a token factory denom', async () =>{
    const supply = await bankContract.supply(denomName);
    console.log(supply);
  });

  it('Can query supply of a native token', async () =>{
    const supply = await bankContract.supply('usei');
    console.log(supply);
  });

  it('Can query symbol of a token', async () =>{
    const symbol = await bankContract.symbol(denomName);
    console.log(symbol);
  });

})