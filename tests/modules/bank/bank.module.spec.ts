import assert from 'assert';
import {SeiUser, UserFactory} from '../../../shared/User';
import {BankSei} from './Bank';
import {execCommandAndReturnJson} from '../../../shared/utils/cliUtils';
import {waitFor} from '../../../shared/utils/helpers';
import {coins} from '@cosmjs/stargate';
import {getPaidGasFee, returnExpect} from './utils';
import util from 'node:util';
import fs from 'fs';
import {Querier} from '@sei-js/cosmos/rest';
import testConfig from '../../../config/testConfig.json';

const exec = util.promisify(require('node:child_process').exec);
const restEndpoint = testConfig.restEndpoint;

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
  let admin: SeiUser;
  let alice: SeiUser;
  let unassociatedUser: SeiUser;
  let userWithBalanceOnEvm: SeiUser;
  let userWithBalanceOnSei: SeiUser;
  let bankSei: BankSei;
  let expect: Chai.ExpectStatic;

  before('Initialize users', async () => {
    expect = await returnExpect();
    admin = await UserFactory.createAdminUser();
    alice = await UserFactory.createSeiUser(admin, 'alice');
    unassociatedUser = await UserFactory.createUnassociatedUsers(admin, 'random');
    userWithBalanceOnEvm = await UserFactory.createUnassociatedUsers(admin, 'random1');
    userWithBalanceOnSei = await UserFactory.createUnassociatedUsers(admin, 'random2');
    bankSei = new BankSei();
  });

  describe('Bank balance tests', function () {

    it('Not associated user can receive funds on sei from Alice', async () => {
      const transferAmount = '100000';
      const preBalance = await unassociatedUser.seiWallet.queryBalance();
      const senderPreBalance = await alice.seiWallet.queryBalance();
      const sendMessage = bankSei.coinSendMessage(
        alice.seiAddress,
        unassociatedUser.seiAddress,
        transferAmount,
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      const afterBalance = await unassociatedUser.seiWallet.queryBalance();
      const gasPaid = getPaidGasFee(senderPreBalance, await alice.seiWallet.queryBalance(), transferAmount);
      expect(gasPaid).to.be.eq(21000);
      expect(Number(afterBalance.amount) - Number(preBalance.amount)).to.be.eq(Number(transferAmount));
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

    it('Alice cant send amounts with signs', async () => {
      const command = `seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} +1000000usei --fees 24200usei --from ${alice.seiAddress} -y`;
      try {
        await exec(command);
        expect(false).to.be.true;
      } catch (e: any) {
        expect(e.message).to.contain('invalid decimal coin expression');
      }
    });

    it('Alice can only pay fees with usei', async () => {
      await waitFor(1);
      const command = `seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} 1000000usei --fees 24200uusdt --broadcast-mode block -y --output json`;
      const {stdout, stderr} = await exec(command);
      expect(JSON.parse(stdout).raw_log).to.contain('insufficient fees; got: 24200uusdt required: 4000usei: insufficient fee');
    });


    it('Not associated user can have vesting schedule on their addresses and cant send more than their balance', async () => {
      const seiBalance = await userWithBalanceOnSei.seiWallet.queryBalance();
      const msg = bankSei.createVestingMessage(
        alice.seiAddress,
        userWithBalanceOnSei.seiAddress,
        '10000000',
        'usei',
        60
      );
      const tx = await alice.seiWallet.signingClient.signAndBroadcast(
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

    it('User cant send negative amounts', async () => {
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

    it('Alice cant send transactions with amount zero', async () => {
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


    it('Alice cannot send more than her balance on sei', async () => {
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

    it('Alice cant send to invalid address', async () => {
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

    it('Alice can perform valid multi-send with inputs equal to outputs', async () => {
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
      expect((BigInt(balance1.amount) - BigInt(balance.amount)).toString()).to.be.eq(BigInt(1000000).toString());
      expect((BigInt(balance2.amount) - BigInt(balance_1.amount)).toString()).to.be.eq(BigInt(1000000).toString());
    });

    it('Alice cannot perform multi-send with mismatched inputs and outputs', async () => {
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

    it('Alice can send coins to themselves', async () => {
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

    it('Alice cannot send tokens with invalid denominations', async () => {
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        '1000000',
        'invalidDenom'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expect(tx.rawLog).to.contain('insufficient funds');
    });

    it('Alice cannot send amount with fractions', async () => {
      const tx = await execCommandAndReturnJson(`seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} 10000invalidDenom --fees 24200usei -y --broadcast-mode block`);
      expect(tx.raw_log).to.contain('insufficient funds');
    });

    it('Alice cannot send txs with empty amounts', async () => {
      try {
        const response = await execCommandAndReturnJson(`seid tx bank send ${alice.seiAddress} ${userWithBalanceOnSei.seiAddress} --fees 24200usei -y --from ${alice.seiAddress} --broadcast-mode block`);
      } catch (e: any) {
        expect(e.message).to.contain('Command failed');
      }
    });

    it('Ferdie with no available balance cannot send tokens', async () => {
      const noBalanceUser = await UserFactory.createUnassociatedUsers(admin, 'ferdie');

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

    it('Alice can send tokens with specifying very high fee', async () => {
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

    it('Alice cant send funds with fees smaller than min fee', async () => {
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

    it('Alice can send all her balance to Eve', async () => {
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

    it('Alice can send with memo field filled', async () => {
      await UserFactory.fundAddressOnSei(alice.seiWallet.walletAddress);
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

    it('Alice can add long memo fields with different characters', async () => {
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

    it('Alice can call multisend with 100 input and outputs', async () => {
      alice.seiWallet.fee = {amount: coins(100000, 'usei'), gas: '2500000'};
      const inputAddress = alice.seiWallet.walletAddress;
      const outputs = [];

      for (let i = 0; i < 100; i++) {
        const recipientUser = await UserFactory.createUnassociatedUsers(admin, 'recipient' + i);
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

    it('Alice can send transaction with maximum memo length which is 256 chars', async () => {
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

    it('Alice cant send transaction with over maximum memo length', async () => {
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

    it('Alice can send transaction with unsupported characters in memo', async () => {
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

    it('Alice cannot perform multi-send with no outputs', async () => {
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

    it('Alice can send dust amount (minimum unit)', async () => {
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        '1',
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expect(tx.code).to.be.eq(0);
    });

    it('Tests new addition into final script', async () => {
      return true;
    });
  });

  describe('Bank Module Query Tests', function () {
    let tokenFactoryDenom: string;
    const tokenFactoryDenomSuffix = 'mydenom'; // or any string

    it('Alice can create a new tokenfactory denom', async () => {
      const createDenomCmd =
        `seid tx tokenfactory create-denom ${tokenFactoryDenomSuffix} ` +
        `--from ${alice.seiAddress} --fees 24200usei --broadcast-mode block -y`;
      const result = await execCommandAndReturnJson(createDenomCmd);
      expect(result.code).to.be.eq(0);
      tokenFactoryDenom = `factory/${alice.seiAddress}/${tokenFactoryDenomSuffix}`;
      console.log('Created new tokenfactory denom:', tokenFactoryDenom);
    });

    it('Alice can mint tokens for the new tokenfactory denom', async () => {
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

    it('QuerySupplyOf should return correct total supply for the new denom', async () => {
      const supplyOfCmd =
        `seid q bank total --denom ${tokenFactoryDenom}`;
      const supplyOfResult = await execCommandAndReturnJson(supplyOfCmd);

      // Should match the minted amount (5,000,000)
      expect(supplyOfResult.amount).to.be.eq('5000000');
    });

    it('QueryAllBalances for Alice should include the new tokenfactory denom', async () => {
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

  describe('Users can query through rest endpoints', function () {
    let tokenFactoryDenom: string;

    it('Alice can query her balance through rest endpoint for new tokenfactory denom', async () =>{
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

    it('Alice can query denom metadata through rest endpoint', async () =>{
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

    it('Alice can query all total supplies through rest endpoint', async () =>{
      const response = await Querier.cosmos.bank.v1beta1.TotalSupply({}, {
        pathPrefix: testConfig.restEndpoint
      });
      expect(response.supply).to.have.length.gt(3);
    });

    it('Alice can query all her available balance through rest endpoint', async () =>{
      const response = await Querier.cosmos.bank.v1beta1.AllBalances({
        address: alice.seiAddress
      }, {
        pathPrefix: testConfig.restEndpoint
      })
      expect(response.balances).to.have.length(2);
    });

    it('Alice can query her spendable balances', async () =>{
      const user = await UserFactory.createUnassociatedUsers(admin, 'user', true);
      const msg = bankSei.createVestingMessage(
        alice.seiAddress,
        user.seiAddress,
        '10000000',
        'usei',
        10
      );
      const tx = await alice.seiWallet.signingClient.signAndBroadcast(
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

    it.skip('Alice can query all metadata info through rest endpoint', async () =>{
      const response = await Querier.cosmos.bank.v1beta1.DenomsMetadata({}, {
        pathPrefix: restEndpoint
      });
      expect(response.metadatas).length.to.be.gt(7);
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('seid bank balance matches Querier balance for alice', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q bank balances ${alice.seiAddress} --denom usei`
      );
      const querierResult = await Querier.cosmos.bank.v1beta1.Balance({
        address: alice.seiAddress,
        denom: 'usei'
      }, { pathPrefix: restEndpoint });
      expect(cliResult.amount).to.be.eq(querierResult.balance!.amount);
      expect(cliResult.denom).to.be.eq(querierResult.balance!.denom);
    });

    it('seid total supply matches Querier total supply for usei', async () => {
      const cliResult = await execCommandAndReturnJson('seid q bank total --denom usei');
      const querierResult = await Querier.cosmos.bank.v1beta1.SupplyOf({
        denom: 'usei'
      }, { pathPrefix: restEndpoint });
      const cliAmount = Number(cliResult.amount);
      const querierAmount = Number(querierResult.amount!.amount);
      expect(Math.abs(cliAmount - querierAmount)).to.be.lt(cliAmount * 0.01);
    });

    it('All balances via seid match Querier all balances count', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q bank balances ${alice.seiAddress}`
      );
      const querierResult = await Querier.cosmos.bank.v1beta1.AllBalances({
        address: alice.seiAddress
      }, { pathPrefix: restEndpoint });
      expect(cliResult.balances.length).to.be.eq(querierResult.balances.length);
      for (const cliBal of cliResult.balances) {
        const querierBal = querierResult.balances.find((b: any) => b.denom === cliBal.denom);
        expect(querierBal).to.exist;
        expect(cliBal.amount).to.be.eq(querierBal!.amount);
      }
    });

    it('Denom metadata via seid matches Querier metadata', async () => {
      const cliResult = await execCommandAndReturnJson('seid q bank denom-metadata --denom usei');
      const querierResult = await Querier.cosmos.bank.v1beta1.DenomMetadata({
        denom: 'usei'
      }, { pathPrefix: restEndpoint });
      expect(cliResult.metadata.base || cliResult.base).to.be.eq(querierResult.metadata!.base);
    });
  });

  describe('Full Lifecycle Tests', function () {
    it('Fund -> Send -> Verify receiver balance -> Send back -> Verify original balance', async () => {
      const lifecycleUser = await UserFactory.createSeiUser(admin, 'bankLifecycle');
      const preBal = await lifecycleUser.seiWallet.queryBalance();
      expect(Number(preBal.amount)).to.be.gt(0);

      const sendMsg = bankSei.coinSendMessage(
        lifecycleUser.seiAddress,
        alice.seiAddress,
        '500000',
        'usei'
      );
      lifecycleUser.seiWallet.fee = { amount: coins(21000, 'usei'), gas: '500000' };
      const tx1 = await lifecycleUser.seiWallet.signAndSend(sendMsg);
      expect(tx1.code).to.be.eq(0);

      const midBal = await lifecycleUser.seiWallet.queryBalance();
      expect(Number(preBal.amount) - Number(midBal.amount)).to.be.eq(500000 + 21000);

      const sendBackMsg = bankSei.coinSendMessage(
        alice.seiAddress,
        lifecycleUser.seiAddress,
        '500000',
        'usei'
      );
      const tx2 = await alice.seiWallet.signAndSend(sendBackMsg);
      expect(tx2.code).to.be.eq(0);

      const finalBal = await lifecycleUser.seiWallet.queryBalance();
      expect(Number(finalBal.amount)).to.be.eq(Number(midBal.amount) + 500000);
    });

    it('Create TF denom -> Mint -> Send -> Query via CLI -> Query via REST -> Burn -> Verify supply', async () => {
      const lfUser = await UserFactory.createSeiUser(admin, 'bankLfTf');
      const subdenom = 'lftest';
      const fullDenom = `factory/${lfUser.seiAddress}/${subdenom}`;

      const createResult = await execCommandAndReturnJson(
        `seid tx tokenfactory create-denom ${subdenom} --from bankLfTf --fees 24200usei -y --broadcast-mode block`
      );
      expect(createResult.code).to.be.eq(0);

      const mintResult = await execCommandAndReturnJson(
        `seid tx tokenfactory mint 1000000${fullDenom} --from bankLfTf --fees 24200usei -y --broadcast-mode block`
      );
      expect(mintResult.code).to.be.eq(0);

      const cliBal = await execCommandAndReturnJson(
        `seid q bank balances ${lfUser.seiAddress} --denom ${fullDenom}`
      );
      expect(cliBal.amount).to.be.eq('1000000');

      const restBal = await Querier.cosmos.bank.v1beta1.Balance({
        address: lfUser.seiAddress,
        denom: fullDenom
      }, { pathPrefix: restEndpoint });
      expect(restBal.balance!.amount).to.be.eq('1000000');

      const burnResult = await execCommandAndReturnJson(
        `seid tx tokenfactory burn 500000${fullDenom} --from bankLfTf --fees 24200usei -y --broadcast-mode block`
      );
      expect(burnResult.code).to.be.eq(0);

      const supplyAfter = await execCommandAndReturnJson(
        `seid q bank total --denom ${fullDenom}`
      );
      expect(supplyAfter.amount).to.be.eq('500000');
    });
  });

  describe('Edge Cases', function () {
    it('Querying balance of non-existent address returns zero', async () => {
      const response = await Querier.cosmos.bank.v1beta1.Balance({
        address: 'sei1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        denom: 'usei'
      }, { pathPrefix: restEndpoint });
      expect(response.balance!.amount).to.be.eq('0');
    });

    it('Querying balance of non-existent denom returns zero', async () => {
      const response = await Querier.cosmos.bank.v1beta1.Balance({
        address: alice.seiAddress,
        denom: 'unonexistent999'
      }, { pathPrefix: restEndpoint });
      expect(response.balance!.amount).to.be.eq('0');
    });

    it('Multiple rapid sequential sends maintain correct balances', async () => {
      const rapidUser = await UserFactory.createSeiUser(admin, 'bankRapid');
      const preBalance = await rapidUser.seiWallet.queryBalance();

      for (let i = 0; i < 3; i++) {
        const msg = bankSei.coinSendMessage(
          rapidUser.seiAddress,
          alice.seiAddress,
          '1000',
          'usei'
        );
        rapidUser.seiWallet.fee = { amount: coins(21000, 'usei'), gas: '500000' };
        const tx = await rapidUser.seiWallet.signAndSend(msg);
        expect(tx.code).to.be.eq(0);
      }

      const postBalance = await rapidUser.seiWallet.queryBalance();
      const expectedDecrease = (1000 + 21000) * 3;
      expect(Number(preBalance.amount) - Number(postBalance.amount)).to.be.eq(expectedDecrease);
    });

    it('Send to self deducts only fees, balance net change equals negative fee', async () => {
      const selfUser = await UserFactory.createSeiUser(admin, 'bankSelfSend');
      selfUser.seiWallet.fee = { amount: coins(21000, 'usei'), gas: '500000' };
      const preBalance = await selfUser.seiWallet.queryBalance();

      const msg = bankSei.coinSendMessage(
        selfUser.seiAddress,
        selfUser.seiAddress,
        '100000',
        'usei'
      );
      const tx = await selfUser.seiWallet.signAndSend(msg);
      expect(tx.code).to.be.eq(0);

      const postBalance = await selfUser.seiWallet.queryBalance();
      expect(Number(preBalance.amount) - Number(postBalance.amount)).to.be.eq(21000);
    });
  });
});
