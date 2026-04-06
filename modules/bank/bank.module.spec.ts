import assert from 'assert';
import {SeiUser} from '../utils/User';
import {BankSei} from './Bank';
import {Funder} from '../utils/Funder';
import testConfig from '../testConfig.json';
import {execCommandAndReturnJson, waitFor} from '../tokenfactory/helpers';
import {coins, SigningStargateClient} from '@cosmjs/stargate';
import {getPaidGasFee, returnExpect} from './utils';
import util from 'node:util';
import fs from 'fs';
import {Querier} from '@sei-js/cosmos/rest';
import {restEndpoint} from '../constants';

const exec = util.promisify(require('node:child_process').exec);

const MAX_GAS_AMOUNT = '35000000';
const OVERMAXGAS = {
  amount: coins(21000, 'usei'),
  gas: '35000001'
};

const BELOW_MAX_GAS = {
  amount: coins(701000, 'usei'),
  gas: '35000000'
};

const REGULAR_FEE = {
  amount: coins(24000, 'usei'),
  gas: '1000000'
};

describe('Sei Bank Module Tests', function () {
  this.timeout(5 * 60 * 1000);
  let alice: SeiUser;
  let unassociatedUser: SeiUser;
  let userWithBalanceOnEvm: SeiUser;
  let userWithBalanceOnSei: SeiUser;
  let bankSei: BankSei;
  let funder = new Funder(testConfig.adminAddress);
  let expect: Chai.ExpectStatic;

  before('Initialize users', async () => {
    expect = await returnExpect();
    unassociatedUser = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
    await unassociatedUser.initialize('', 'random');

    userWithBalanceOnEvm = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
    await userWithBalanceOnEvm.initialize('', 'random1');

    userWithBalanceOnSei = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
    await userWithBalanceOnSei.initialize('', 'random2');

    alice = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
    await alice.initialize('', 'alice', true);
    await funder.fundAddressOnSei(alice.seiAddress);
    await waitFor(1);
    await alice.seiWallet.associate();
    await waitFor(1);
    bankSei = new BankSei();
  });

  describe('Bank balance tests', async () => {

    it.only('Not associated user can receive funds on sei from Alice', async () => {
      const transferAmount = '1000000';
      const preBalance = await unassociatedUser.seiWallet.queryBalance();
      const senderPreBalance = await alice.seiWallet.queryBalance();
      const sendMessage = bankSei.coinSendMessage(
        alice.seiAddress,
        unassociatedUser.seiAddress,
        '1000000',
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      const afterBalance = await unassociatedUser.seiWallet.queryBalance();
      const gasPaid = getPaidGasFee(senderPreBalance, await alice.seiWallet.queryBalance(), transferAmount);
      expect(gasPaid).to.be.eq(21000);
      expect(Number(afterBalance.amount) - Number(preBalance.amount)).to.be.eq(1000000);
      const isAssociated = await unassociatedUser.seiWallet.isAssociated();
      expect(isAssociated).to.be.false;
    });

    it.only('Alice cant send txs with over block max gas fee', async () => {
      const senderPreBalance = await alice.seiWallet.queryBalance();
      alice.seiWallet.fee = OVERMAXGAS;
      const sendMessage = bankSei.coinSendMessage(
        alice.seiAddress,
        unassociatedUser.seiAddress,
        '1000000',
        'usei'
      );
      try {
        const tx = await alice.seiWallet.signAndSend(sendMessage);
        expect(true).to.be.false;
      } catch (e: any) {
        const gasPaid = getPaidGasFee(senderPreBalance, await alice.seiWallet.queryBalance(), '0');
        expect(e.message).to.contain('exceeds block max gas limit 35000000: out of gas');
        expect(gasPaid).to.be.eq(0);
      }
    });

    it.only('Alice can send txs with max allowed gas limit', async () => {
      const senderPreBalance = await alice.seiWallet.queryBalance();
      alice.seiWallet.fee = BELOW_MAX_GAS;
      const sendMessage = bankSei.coinSendMessage(
        alice.seiAddress,
        unassociatedUser.seiAddress,
        '1000000',
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expect(tx.code).to.be.eq(0);
      const gasPaid = getPaidGasFee(senderPreBalance, await alice.seiWallet.queryBalance(), '1000000');
      expect(gasPaid).to.be.eq(Number(BELOW_MAX_GAS.amount[0].amount));
    });

    it.only('Alice cant send amounts with signs', async () => {
      const command = `seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} +1000000usei --fees 24200usei --from ${alice.seiAddress} -y`;
      try {
        await exec(command);
        expect(false).to.be.true;
      } catch (e: any) {
        expect(e.message).to.contain('invalid decimal coin expression');
      }
    });

    it.only('Alice can only pay fees with usei', async () => {
      await funder.fundAdminOnSei('uusdt');
      await waitFor(1);
      const command = `seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} 1000000usei --fees 24200uusdt --broadcast-mode block -y --output json`;
      const {stdout, stderr} = await exec(command);
      expect(JSON.parse(stdout).raw_log).to.contain('insufficient fees; got: 24200uusdt required: 4000usei: insufficient fee');
    });


    it.only('Not associated user can have vesting schedule on their addresses and cant send more than their balance', async () => {
      const seiBalance = await userWithBalanceOnSei.seiWallet.queryBalance();
      const msg = bankSei.createVestingMessage(
        alice.seiAddress,
        userWithBalanceOnSei.seiAddress,
        '10000000',
        'usei',
        60
      );
      const signingClient = await SigningStargateClient.connectWithSigner(
        testConfig.seiRpcEndpoint,
        alice.seiWallet.wallet
      );
      const tx = await signingClient.signAndBroadcast(
        alice.seiAddress,
        [msg],
        alice.seiWallet.fee,
        'vest'
      );
      const seiBalanceAfter = await userWithBalanceOnSei.seiWallet.queryBalance();
      expect(Number(seiBalanceAfter.amount) - Number(seiBalance.amount)).to.be.eq(10000000);

      const sendMsg = bankSei.coinSendMessage(
        userWithBalanceOnSei.seiWallet.walletAddress,
        alice.seiWallet.walletAddress,
        '100000',
        'usei'
      );
      try {
        const tx2 = await userWithBalanceOnSei.seiWallet.signAndSend(sendMsg);
        expect(false).to.be.true;
      } catch (e: any) {
        expect(e.message).to.contain('insufficient funds: insufficient funds');
      }

      // fund user
      const sendMsg2 = bankSei.coinSendMessage(
        alice.seiAddress,
        userWithBalanceOnSei.seiAddress,
        '100000',
        'usei'
      );
      await alice.seiWallet.signAndSend(sendMsg2);
      await waitFor(0.5);

      const sendMsg3 = bankSei.coinSendMessage(
        userWithBalanceOnSei.seiAddress,
        alice.seiAddress,
        '150000',
        'usei'
      );
      const tx3 = await userWithBalanceOnSei.seiWallet.signAndSend(sendMsg3);
      expect(tx3.code).not.to.be.eq(0);

      // Multi send also fails
      const inputAddress = userWithBalanceOnSei.seiAddress;
      const outputAddress1 = alice.seiAddress;
      const outputAddress2 = unassociatedUser.seiAddress;

      const inputs = [
        {address: inputAddress, amount: [{amount: '120000', denom: 'usei'}]},
      ];

      const outputs = [
        {address: outputAddress1, amount: [{amount: '60000', denom: 'usei'}]},
        {address: outputAddress2, amount: [{amount: '60000', denom: 'usei'}]},
      ];

      const sendMessage = bankSei.coinMultiSendMessage(inputs, outputs);

      const multiTx = await userWithBalanceOnSei.seiWallet.signAndSend(sendMessage);
      expect(multiTx.code).not.to.be.eq(0);

      console.log('Now waiting for vesting release');
      await waitFor(60);
      console.log('Vesting should have been released');
      const tx2 = await userWithBalanceOnSei.seiWallet.signAndSend(sendMsg3);
      expect(tx2.code).to.be.eq(0);
    });

    it.only('User cant send negative amounts', async () => {
      const unsignedTx = await exec(`seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} 1000000usei --fees 24200usei -y --from ${alice.seiAddress} --generate-only > unsignedNegative.json`);
      await waitFor(0.5);

      //Parses the json and updates the amount here
      const msg = JSON.parse(fs.readFileSync('unsignedNegative.json', 'utf8'));
      msg.body.messages[0].amount[0].amount = '-1000000';
      fs.writeFileSync('unsignedNegative.json', JSON.stringify(msg, null, 2));

      await waitFor(1);
      const signTx = await exec(`seid tx sign unsignedNegative.json --from ${alice.seiAddress} --chain-id sei-chain > signed_tx.json`);
      await waitFor(0.5);
      const broadcastTX = await execCommandAndReturnJson(`seid tx broadcast signed_tx.json --from ${alice.seiAddress} --broadcast-mode block`);
      expect(broadcastTX.raw_log).to.contain('invalid coins');
    });

    it.only('Alice cant send transactions with amount zero', async () => {
      const unsignedTx = await exec(`seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} 1000000usei --fees 24200usei -y --from ${alice.seiAddress} --generate-only > zeroAmount.json`);
      await waitFor(0.5);

      //Parses the json and updates the amount here
      const msg = JSON.parse(fs.readFileSync('zeroAmount.json', 'utf8'));
      msg.body.messages[0].amount[0].amount = '0';
      fs.writeFileSync('zeroAmount.json', JSON.stringify(msg, null, 2));

      await waitFor(1);
      const signTx = await exec(`seid tx sign zeroAmount.json --from ${alice.seiAddress} --chain-id sei-chain > signed_zero_tx.json`);
      await waitFor(0.5);
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast signed_zero_tx.json --from ${alice.seiAddress} --broadcast-mode block`);
      expect(broadcastTx.raw_log).to.contain('invalid coins');
    });


    it.only('Alice cannot send more than her balance on sei', async () => {
      const balance = await alice.seiWallet.queryBalance();
      const balanceAmount = parseInt(balance.amount);
      const sendAmount = (balanceAmount + 1000000).toString();
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        sendAmount,
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expect(tx.rawLog).to.contain('insufficient funds');
    });

    it.only('Alice cant send to invalid address', async () => {
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        'invalid_address',
        '1000000',
        'usei'
      );
      try {
        const tx = await alice.seiWallet.signAndSend(sendMessage);
        assert.fail('Transaction should have failed');
      } catch (e: any) {
        expect(e.message).to.contain('Invalid recipient address');
      }
    });

    it.only('Alice can perform valid multi-send with inputs equal to outputs', async () => {
      const inputAddress = alice.seiWallet.walletAddress;
      const outputAddress1 = userWithBalanceOnSei.seiWallet.walletAddress;
      const outputAddress2 = unassociatedUser.seiWallet.walletAddress;

      const balance = await userWithBalanceOnSei.seiWallet.queryBalance();
      const balance_1 = await unassociatedUser.seiWallet.queryBalance();

      console.log('Balance userWithBalanceOnSei:', balance);
      console.log('Balance unassociatedUser:', balance_1);

      const inputs = [
        {address: inputAddress, amount: [{amount: '2000000', denom: 'usei'}]},
      ];

      const outputs = [
        {address: outputAddress1, amount: [{amount: '1000000', denom: 'usei'}]},
        {address: outputAddress2, amount: [{amount: '1000000', denom: 'usei'}]},
      ];

      const sendMessage = bankSei.coinMultiSendMessage(inputs, outputs);
      const tx = await alice.seiWallet.signAndSend(sendMessage);

      const balance1 = await userWithBalanceOnSei.seiWallet.queryBalance();
      const balance2 = await unassociatedUser.seiWallet.queryBalance();

      console.log('Balance userWithBalanceOnSei:', balance1);
      console.log('Balance unassociatedUser:', balance2);

      expect((BigInt(balance1.amount) - BigInt(balance.amount)).toString()).to.be.eq(BigInt(1000000).toString());
      expect((BigInt(balance2.amount) - BigInt(balance_1.amount)).toString()).to.be.eq(BigInt(1000000).toString());
    });

    it.only('Alice cannot perform multi-send with mismatched inputs and outputs', async () => {
      const inputAddress = alice.seiAddress;
      const outputAddress1 = userWithBalanceOnSei.seiAddress;
      const outputAddress2 = unassociatedUser.seiAddress;
      const outputAddress1PreBalance = await userWithBalanceOnSei.seiWallet.queryBalance();
      const outputAddress2PreBalance = await unassociatedUser.seiWallet.queryBalance();
      const inputPreBalance = await alice.seiWallet.queryBalance();
      const inputs = [
        {address: inputAddress, amount: [{amount: '1000000', denom: 'usei'}]},
      ];

      const outputs = [
        {address: outputAddress1, amount: [{amount: '1000000', denom: 'usei'}]},
        {address: outputAddress2, amount: [{amount: '1000000', denom: 'usei'}]},
      ];

      const sendMessage = bankSei.coinMultiSendMessage(inputs, outputs);
      try {
        const tx = await alice.seiWallet.signAndSend(sendMessage);
        assert.fail('Transaction should have failed');
      } catch (e: any) {
        expect(e.message).to.contain('sum inputs != sum outputs');
      }
      const outputAddress1AfterBalance = await userWithBalanceOnSei.seiWallet.queryBalance();
      const outputAddress2AfterBalance = await unassociatedUser.seiWallet.queryBalance();
      const inputAfterBalance = await alice.seiWallet.queryBalance();

      //Expect all balances are the same
      expect((BigInt(outputAddress1AfterBalance.amount) - BigInt(outputAddress1PreBalance.amount)).toString()).to.be.eq(BigInt(0).toString());
      expect((BigInt(outputAddress2AfterBalance.amount) - BigInt(outputAddress2PreBalance.amount)).toString()).to.be.eq(BigInt(0).toString());
      expect((BigInt(inputAfterBalance.amount) - BigInt(inputPreBalance.amount)).toString()).to.be.eq(BigInt(0).toString());
    });

    it.only('Alice can send coins to themselves', async () => {
      const preBalance = await alice.seiWallet.queryBalance();
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        alice.seiWallet.walletAddress,
        '1000000',
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      const afterBalance = await alice.seiWallet.queryBalance();

      const feeAmount = parseInt(alice.seiWallet.fee.amount[0].amount);
      assert.strictEqual(
        parseInt(preBalance.amount) - parseInt(afterBalance.amount),
        feeAmount,
        'Balance should have decreased by fee amount only'
      );
    });

    it.only('Alice cannot send tokens with invalid denominations', async () => {
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        '1000000',
        'invalidDenom'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expect(tx.rawLog).to.contain('insufficient funds');
    });

    it.only('Alice cannot send amount with fractions', async () => {
      const tx = await execCommandAndReturnJson(`seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} 10000invalidDenom --fees 24200usei -y --broadcast-mode block`);
      expect(tx.raw_log).to.contain('insufficient funds');
    });

    it.only('Alice cannot send txs with empty amounts', async () => {
      try {
        const response = await execCommandAndReturnJson(`seid tx bank send ${alice.seiAddress} ${userWithBalanceOnSei.seiAddress} --fees 24200usei -y --from ${alice.seiAddress} --broadcast-mode block`);
      } catch (e: any) {
        expect(e.message).to.contain('Command failed');
      }
    });

    it.only('Ferdie with no available balance cannot send tokens', async () => {
      // Create a new user with no balance
      const noBalanceUser = new SeiUser(
        testConfig.seiRpcEndpoint,
        testConfig.evmRpcEndpoint,
        testConfig.restEndpoint
      );
      await noBalanceUser.initialize('', 'ferdie');

      const sendMessage = bankSei.coinSendMessage(
        noBalanceUser.seiWallet.walletAddress,
        alice.seiWallet.walletAddress,
        '1000000',
        'usei'
      );
      try {
        const tx = await noBalanceUser.seiWallet.signAndSend(sendMessage);
        assert.fail('Transaction should have failed due to insufficient funds');
      } catch (e: any) {
        expect(e.message).to.contain('does not exist on chain');
      }
    });

    it.only('Alice can send tokens with specifying very high fee', async () => {
      const preBalance = await alice.seiWallet.queryBalance();
      // Set a high fee
      alice.seiWallet.fee = {amount: coins(10000000, 'usei'), gas: '500000'};

      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        '1000000',
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      const afterBalance = await alice.seiWallet.queryBalance();

      const feeAmount = parseInt(alice.seiWallet.fee.amount[0].amount);
      assert.strictEqual(
        parseInt(preBalance.amount) - parseInt(afterBalance.amount),
        1000000 + feeAmount,
        'Balance should have decreased by amount plus fee'
      );

      // Reset fee to default
      alice.seiWallet.fee = {amount: coins(21000, 'usei'), gas: '500000'};
    });

    it.only('Alice cant send funds with fees smaller than min fee', async () => {
      alice.seiWallet.fee = {amount: coins(1, 'usei'), gas: '500000'};

      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        '1000000',
        'usei'
      );
      try {
        const tx = await alice.seiWallet.signAndSend(sendMessage);
        assert.fail('Transaction should have failed due to insufficient fee');
      } catch (e: any) {
        expect(e.message).to.contain('insufficient fees');
      }

      // Reset fee to default
      alice.seiWallet.fee = {amount: coins(21000, 'usei'), gas: '500000'};
    });

    it.only('Alice can send all her balance to Eve', async () => {
      const balance = await alice.seiWallet.queryBalance();
      const feeAmount = parseInt(alice.seiWallet.fee.amount[0].amount);
      const sendAmount = (parseInt(balance.amount) - feeAmount).toString();

      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        sendAmount,
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      const afterBalance = await alice.seiWallet.queryBalance();

      assert.strictEqual(
        parseInt(afterBalance.amount),
        0,
        'Balance should be zero after sending maximum amount'
      );
    });

    it.only('Alice can send with memo field filled', async () => {
      await funder.fundAddressOnSei(alice.seiWallet.walletAddress);
      await waitFor(1);
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        '1000000',
        'usei'
      );
      const memo = 'Test memo field';
      const tx = await alice.seiWallet.signAndSend(sendMessage, memo);
      expect(tx.code).to.be.eq(0);
    });

    it.only('Alice can add long memo fields with different characters', async () => {
      await funder.fundAdminOnSei();
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        '1000000',
        'usei'
      );
      const memo = 'Test memo field with crazy field 12121??????şlşşşşaççöçöşğüüğü';
      const tx = await alice.seiWallet.signAndSend(sendMessage, memo);
      expect(tx.code).to.be.eq(0);
    });

    it.only('Alice can call multisend with 100 input and outputs', async () => {
      alice.seiWallet.fee = {amount: coins(100000, 'usei'), gas: '2500000'};
      const inputAddress = alice.seiWallet.walletAddress;
      const outputs = [];

      // Create a large number of outputs (e.g., 100)
      for (let i = 0; i < 100; i++) {
        const recipientUser = new SeiUser(
          testConfig.seiRpcEndpoint,
          testConfig.evmRpcEndpoint,
          testConfig.restEndpoint
        );
        await recipientUser.initialize('', 'recipient' + i);
        outputs.push({
          address: recipientUser.seiWallet.walletAddress,
          amount: [{amount: '1000', denom: 'usei'}],
        });
      }
      const totalAmount = (1000 * outputs.length).toString();
      const inputs = [
        {address: inputAddress, amount: [{amount: totalAmount, denom: 'usei'}]},
      ];

      const sendMessage = bankSei.coinMultiSendMessage(inputs, outputs);


      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expect(tx.code).to.be.eq(0);
      alice.seiWallet.fee = {amount: coins(21000, 'usei'), gas: '500000'};
    });

    it.only('Alice can send transaction with maximum memo length which is 256 chars', async () => {
      const memo = 'a'.repeat(256);
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        '1000',
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage, memo);
      expect(tx.code).to.be.eq(0);
    });

    it.only('Alice cant send transaction with over maximum memo length', async () => {
      const memo = 'a'.repeat(257);
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        '1000',
        'usei'
      );
      try{
        const tx = await alice.seiWallet.signAndSend(sendMessage, memo);
      } catch(e: any) {
        expect(e.message).to.contain('maximum number of characters is 256 but received 257 characters: memo too large');
      }

      const command = await exec(`seid tx bank send ${alice.seiAddress} ${userWithBalanceOnSei.seiAddress} 1000000usei --fees 24200usei -y  --from ${alice.seiAddress} --note ${memo} --generate-only > overMaxMemo.json`);
      await waitFor(0.5);
      const signTx = await exec(`seid tx sign overMaxMemo.json --from ${alice.seiAddress} --chain-id sei-chain > overMaxMemoSigned.json`);
      await waitFor(0.5);

      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast overMaxMemoSigned.json --from ${alice.seiAddress} --broadcast-mode block`);
      expect(broadcastTx.raw_log).to.contain('maximum number of characters');
    });

    it.only('Alice can send transaction with unsupported characters in memo', async () => {
      const memo = '\u0001\u0002\u0003\u0004';
      const alicePreBalance = await alice.seiWallet.queryBalance();
      const userPreBalance = await userWithBalanceOnSei.seiWallet.queryBalance();

      const command = await exec(`seid tx bank send ${alice.seiAddress} ${userWithBalanceOnSei.seiAddress} 1000000usei --fees 24200usei -y  --from ${alice.seiAddress} --note ${memo} --generate-only > unsupportedChars.json`);
      await waitFor(0.5);
      const signTx = await exec(`seid tx sign unsupportedChars.json --from ${alice.seiAddress} --chain-id sei-chain > unsupported_signed_tx.json`);
      await waitFor(0.5);

      const broadcastTx = await exec(`seid tx broadcast unsupported_signed_tx.json --from ${alice.seiAddress} --broadcast-mode block`);

      const alicePostBalance = await alice.seiWallet.queryBalance();
      const userPostBalance = await userWithBalanceOnSei.seiWallet.queryBalance();

      expect((BigInt(alicePreBalance.amount) - BigInt(alicePostBalance.amount)).toString()).to.be.eq(BigInt(1024200).toString());
      expect((BigInt(userPostBalance.amount) - BigInt(userPreBalance.amount)).toString()).to.be.eq(BigInt(1000000).toString());
    });

    it.only('Alice cannot perform multi-send with no outputs', async () => {
      const inputs = [
        {address: alice.seiWallet.walletAddress, amount: [{amount: '1000', denom: 'usei'}]},
      ];
      const outputs: any[] = [];
      const sendMessage = bankSei.coinMultiSendMessage(inputs, outputs);
      try {
        await alice.seiWallet.signAndSend(sendMessage);
        assert.fail('Transaction should have failed due to no outputs');
      } catch (e: any) {
        expect(e.message).to.contain('Broadcasting transaction failed');
      }
    });

    it.only('Alice can send dust amount (minimum unit)', async () => {
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        '1',
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expect(tx.code).to.be.eq(0);
    });

    it.only('Tests new addition into final script', async () => {
      return true;
    });
  });

  describe.only('Bank Module Query Tests', function () {
    let tokenFactoryDenom: string;
    const tokenFactoryDenomSuffix = 'mydenom'; // or any string

    it.only('Alice can create a new tokenfactory denom', async () => {
      const createDenomCmd =
        `seid tx tokenfactory create-denom ${tokenFactoryDenomSuffix} ` +
        `--from ${alice.seiAddress} --fees 24200usei --broadcast-mode block -y`;
      const result = await execCommandAndReturnJson(createDenomCmd);
      expect(result.code).to.be.eq(0);
      tokenFactoryDenom = `factory/${alice.seiAddress}/${tokenFactoryDenomSuffix}`;
      console.log('Created new tokenfactory denom:', tokenFactoryDenom);
    });

    it.only('Alice can mint tokens for the new tokenfactory denom', async () => {
      const mintAmount = '5000000';
      const mintCmd =
        `seid tx tokenfactory mint ${mintAmount}${tokenFactoryDenom} ` +
        `--from ${alice.seiAddress} --fees 24200usei -y --broadcast-mode block`;
      const mintResult = await execCommandAndReturnJson(mintCmd);
      expect(mintResult.code).to.be.eq(0);


      const balanceCmd =
        `seid q bank balances ${alice.seiAddress} --denom ${tokenFactoryDenom}`;
      const balanceResult = await execCommandAndReturnJson(balanceCmd);
      expect(balanceResult.amount).to.be.eq(mintAmount);
    });

    it.only('QuerySupplyOf should return correct total supply for the new denom', async () => {
      const supplyOfCmd =
        `seid q bank total --denom ${tokenFactoryDenom}`;
      const supplyOfResult = await execCommandAndReturnJson(supplyOfCmd);

      // Should match the minted amount (5,000,000)
      expect(supplyOfResult.amount).to.be.eq('5000000');
    });

    it.only('QueryAllBalances for Alice should include the new tokenfactory denom', async () => {
      const allBalancesCmd =
        `seid q bank balances ${alice.seiAddress}`;
      const allBalancesResult = await execCommandAndReturnJson(allBalancesCmd);

      // Find the newly minted denom among all balances
      const found = allBalancesResult.balances.find(
        (b: any) => b.denom === tokenFactoryDenom
      );
      expect(found).to.exist;
      expect(found.amount).to.be.eq('5000000');
    });
  });

  describe.only('Users can query through rest endpoints', function () {
    let tokenFactoryDenom: string;

    it.only('Alice can query her balance through rest endpoint for new tokenfactory denom', async () =>{
      tokenFactoryDenom = `factory/${alice.seiAddress}/mydenom`;
      const response = await Querier.cosmos.bank.v1beta1.Balance({
        address: alice.seiAddress,
        denom: tokenFactoryDenom
      }, {
        pathPrefix: testConfig.restEndpoint
      });
      expect(response.balance!.amount).to.be.eq('5000000');
      expect(response.balance!.denom).to.be.eq(tokenFactoryDenom);
    })

    it.only('Alice can query denom metadata through rest endpoint', async () =>{
      const response = await Querier.cosmos.bank.v1beta1.DenomMetadata({
        denom: 'usei'
      }, {
        pathPrefix: testConfig.restEndpoint
      })
      expect(response.metadata!.base).to.be.eq('usei');
      expect(response.metadata!.display).to.be.eq('usei');
    });

    it.skip('Alice can query total supply of tokenfactory tokens through rest endpoint', async () =>{
      const response = await Querier.cosmos.bank.v1beta1.SupplyOf({
        denom: tokenFactoryDenom
      }, {
        pathPrefix: testConfig.restEndpoint
      })
      console.log(response);
    });

    it.only('Alice can query all total supplies through rest endpoint', async () =>{
      const response = await Querier.cosmos.bank.v1beta1.TotalSupply({}, {
        pathPrefix: testConfig.restEndpoint
      });
      expect(response.supply).to.have.length.gt(3);
    });

    it.only('Alice can query all her available balance through rest endpoint', async () =>{
      const response = await Querier.cosmos.bank.v1beta1.AllBalances({
        address: alice.seiAddress
      }, {
        pathPrefix: testConfig.restEndpoint
      })
      expect(response.balances).to.have.length(2);
    });

    it.only('Alice can query her spendable balances', async () =>{
      // alice vests on new user
      const user = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
      await user.initialize('', 'user', true);
      const msg = bankSei.createVestingMessage(
        alice.seiAddress,
        user.seiAddress,
        '10000000',
        'usei',
        10
      );
      const signingClient = await SigningStargateClient.connectWithSigner(
        testConfig.seiRpcEndpoint,
        alice.seiWallet.wallet
      );
      const tx = await signingClient.signAndBroadcast(
        alice.seiAddress,
        [msg],
        alice.seiWallet.fee,
        'vest'
      );

      let response = await Querier.cosmos.bank.v1beta1.SpendableBalances({
        address: user.seiAddress
      }, {
        pathPrefix: restEndpoint
      });

      expect(response.balances[0].denom).to.be.eq('usei');
      expect(response.balances[0].amount).to.be.eq('0');
      await waitFor(10);

      response = await Querier.cosmos.bank.v1beta1.SpendableBalances({
        address: user.seiAddress
      }, {
        pathPrefix: restEndpoint
      });
      expect(response.balances[0].amount).to.be.eq('10000000');
    });

    it.only('Alice can query all metadata info through rest endpoint', async () =>{
      const response = await Querier.cosmos.bank.v1beta1.DenomsMetadata({}, {
        pathPrefix: restEndpoint
      });
      expect(response.metadatas).length.to.be.gt(7);
    });
  });
});
