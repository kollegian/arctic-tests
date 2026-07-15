import assert from 'assert';
import {SeiUser, UserFactory} from '../../../shared/User';
import {BankSei} from './Bank';
import {execCommandAndReturnJson} from '../../../shared/utils/cliUtils';
import {waitFor} from '../../../shared/utils/helpers';
import {BankExtension, coins, QueryClient, setupBankExtension} from '@cosmjs/stargate';
import {getPaidGasFee, returnExpect} from './utils';
import util from 'node:util';
import fs from 'fs';
import {Tendermint34Client} from '@cosmjs/tendermint-rpc';
import testConfig from '../../../config/testConfig.json';
import {expectFailure, expectTxFailure, expectTxSuccess, expectUseiBalanceDelta, expectUseiCoin} from '../moduleTestUtils';

const exec = util.promisify(require('node:child_process').exec);

const REGULAR_FEE = {
  amount: coins(50000, 'usei'),
  gas: '500000'
};
const SEND_AMOUNT = '100000';
const TOKENFACTORY_MINT_AMOUNT = '5000000';
const VESTING_AMOUNT = '100000';
const CLI_FEE = '24200usei';
const STANDARD_SIGN_AND_SEND_FEE = { amount: coins(50000, 'usei'), gas: '500000' };
const HIGH_MULTISEND_FEE = { amount: coins(250000, 'usei'), gas: '2500000' };
const VERY_HIGH_BUT_VALID_FEE = { amount: coins(100000, 'usei'), gas: '500000' };

// JSON artifacts produced by the generate-only/sign/broadcast CLI flows.
// Tracked here so the suite can clean them up instead of littering the repo.
const GENERATED_TX_FILES = [
  'unsignedNegative.json',
  'signed_tx.json',
  'zeroAmount.json',
  'signed_zero_tx.json',
  'fractionAmount.json',
  'signed_fraction_tx.json',
  'overMaxMemo.json',
  'overMaxMemoSigned.json',
  'unsupportedChars.json',
  'unsupported_signed_tx.json',
  'duplicateUnsigned.json',
  'duplicateSigned.json',
];

async function getCurrentBlockMaxGas(rpcEndpoint: string): Promise<number> {
  const result = await execCommandAndReturnJson(
    `seid query params blockparams -o json --node "${rpcEndpoint}"`
  );
  return Number(result.max_gas);
}

async function withBankQueryClient<T>(
  callback: (queryClient: QueryClient & BankExtension) => Promise<T>
): Promise<T> {
  const cometClient = await Tendermint34Client.connect(testConfig.seiRpcEndpoint);
  try {
    const queryClient = QueryClient.withExtensions(cometClient, setupBankExtension);
    return await callback(queryClient);
  } finally {
    cometClient.disconnect();
  }
}

describe('Sei Bank Module Tests', function () {
  this.timeout(5 * 60 * 1000);
  let admin: SeiUser;
  let alice: SeiUser;
  let unassociatedUser: SeiUser;
  let userWithBalanceOnEvm: SeiUser;
  let userWithBalanceOnSei: SeiUser;
  let bankSei: BankSei;
  let expect: Chai.ExpectStatic;
  let blockMaxGasAmount: string;
  let overMaxGasFee: { amount: ReturnType<typeof coins>; gas: string };
  let maxAllowedGasFee: { amount: ReturnType<typeof coins>; gas: string };

  before('Initialize users', async () => {
    expect = await returnExpect();
    admin = await UserFactory.createAdminUser();
    alice = await UserFactory.createSeiUser(admin, 'alice');
    unassociatedUser = await UserFactory.createUnassociatedUsers(admin, 'random');
    userWithBalanceOnEvm = await UserFactory.createUnassociatedUsers(admin, 'random1');
    userWithBalanceOnSei = await UserFactory.createUnassociatedUsers(admin, 'random2');
    bankSei = new BankSei();
    const currentBlockMaxGas = await getCurrentBlockMaxGas(testConfig.seiRpcEndpoint);
    blockMaxGasAmount = String(currentBlockMaxGas);
    overMaxGasFee = {
      amount: coins(21000, 'usei'),
      gas: String(currentBlockMaxGas + 1),
    };
    maxAllowedGasFee = {
      amount: coins(Math.ceil(currentBlockMaxGas / 10), 'usei'),
      gas: blockMaxGasAmount,
    };
  });

  after('Removes generated tx artifacts', () => {
    for (const file of GENERATED_TX_FILES) {
      fs.rmSync(file, { force: true });
    }
  });

  describe('Bank balance tests', function () {
    afterEach(() => {
      alice.seiWallet.fee = { ...STANDARD_SIGN_AND_SEND_FEE };
    });

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

    it('Alice cant send txs with over block max gas fee', async () => {
      const senderPreBalance = await alice.seiWallet.queryBalance();
      alice.seiWallet.fee = overMaxGasFee;
      const sendMessage = bankSei.coinSendMessage(
        alice.seiAddress,
        unassociatedUser.seiAddress,
        SEND_AMOUNT,
        'usei'
      );
      await expectFailure(
        alice.seiWallet.signAndSend(sendMessage),
        `exceeds block max gas limit ${blockMaxGasAmount}: out of gas`,
        'over-max-gas send'
      );
      const gasPaid = getPaidGasFee(senderPreBalance, await alice.seiWallet.queryBalance(), '0');
      expect(gasPaid).to.be.eq(0);
    });

    it('Alice can send txs with max allowed gas limit', async () => {
      const senderPreBalance = await alice.seiWallet.queryBalance();
      alice.seiWallet.fee = maxAllowedGasFee;
      const sendMessage = bankSei.coinSendMessage(
        alice.seiAddress,
        unassociatedUser.seiAddress,
        SEND_AMOUNT,
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expect(tx.code).to.be.eq(0);
      const gasPaid = getPaidGasFee(senderPreBalance, await alice.seiWallet.queryBalance(), SEND_AMOUNT);
      expect(gasPaid).to.be.eq(Number(maxAllowedGasFee.amount[0].amount));
    });

    it('Alice cant send amounts with signs', async () => {
      const command = `seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} +${SEND_AMOUNT}usei --fees ${CLI_FEE} --from ${alice.seiAddress} -y`;
      await expectFailure(exec(command), 'invalid decimal coin expression', 'send with signed amount');
    });

    it('Alice can only pay fees with usei', async () => {
      await waitFor(1);
      const command = `seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} ${SEND_AMOUNT}usei --fees 24200factory/sei13t0k7zszjxawg5ttp3d5dq3thny6hkfnw0krsk/mydenom --broadcast-mode block -y --output json`;
      const {stdout, stderr} = await exec(command);
      expect(JSON.parse(stdout).raw_log).to.contain('insufficient fees');
    });


    it('Not associated user can have vesting schedule on their addresses and can be correctly queried', async () => {
      const seiBalance = await userWithBalanceOnSei.seiWallet.queryBalance();
      const msg = bankSei.createVestingMessage(
        alice.seiAddress,
        userWithBalanceOnSei.seiAddress,
        VESTING_AMOUNT,
        'usei',
        60
      );
      const tx = await alice.seiWallet.signingClient.signAndBroadcast(
        alice.seiAddress,
        [msg],
        alice.seiWallet.fee,
        'vest'
      );
      expectTxSuccess(tx, 'vesting account creation');
      await waitFor(61);

      const seiBalanceAfter = await userWithBalanceOnSei.seiWallet.queryBalance();
      expectUseiCoin(seiBalanceAfter);
      expect(Number(seiBalanceAfter.amount) - Number(seiBalance.amount)).to.be.eq(Number(VESTING_AMOUNT));
    });

    it('User cant send negative amounts', async () => {
      const unsignedTx = await exec(`seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} ${SEND_AMOUNT}usei --fees 24200usei -y --from ${alice.seiAddress} --generate-only > unsignedNegative.json`);
      await waitFor(0.5);

      //Parses the json and updates the amount here
      const msg = JSON.parse(fs.readFileSync('unsignedNegative.json', 'utf8'));
      msg.body.messages[0].amount[0].amount = `-${SEND_AMOUNT}`;
      fs.writeFileSync('unsignedNegative.json', JSON.stringify(msg, null, 2));

      await waitFor(1);
      const signTx = await exec(`seid tx sign unsignedNegative.json --from ${alice.seiAddress} --chain-id sei-chain > signed_tx.json`);
      await waitFor(0.5);
      const broadcastTX = await execCommandAndReturnJson(`seid tx broadcast signed_tx.json --from ${alice.seiAddress} --broadcast-mode block`);
      expect(broadcastTX.raw_log).to.contain('invalid coins');
    });

    it('Alice cant send transactions with amount zero', async () => {
      const unsignedTx = await exec(`seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} ${SEND_AMOUNT}usei --fees 24200usei -y --from ${alice.seiAddress} --generate-only > zeroAmount.json`);
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
      const sendAmount = (balanceAmount + Number(SEND_AMOUNT)).toString();
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        sendAmount,
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expectTxFailure(tx, 'insufficient funds');
    });

    it('Alice cant send to invalid address', async () => {
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        'invalid_address',
        SEND_AMOUNT,
        'usei'
      );
      await expectFailure(
        alice.seiWallet.signAndSend(sendMessage),
        'Invalid recipient address',
        'send to invalid address'
      );
    });

    it('Alice can perform valid multi-send with inputs equal to outputs', async () => {
      const inputAddress = alice.seiWallet.walletAddress;
      const outputAddress1 = userWithBalanceOnSei.seiWallet.walletAddress;
      const outputAddress2 = unassociatedUser.seiWallet.walletAddress;

      const balance = await userWithBalanceOnSei.seiWallet.queryBalance();
      const balance_1 = await unassociatedUser.seiWallet.queryBalance();

      const inputs = [
        {address: inputAddress, amount: [{amount: '200000', denom: 'usei'}]},
      ];

      const outputs = [
        {address: outputAddress1, amount: [{amount: '100000', denom: 'usei'}]},
        {address: outputAddress2, amount: [{amount: '100000', denom: 'usei'}]},
      ];

      const sendMessage = bankSei.coinMultiSendMessage(inputs, outputs);
      const tx = await alice.seiWallet.signAndSend(sendMessage);

      const balance1 = await userWithBalanceOnSei.seiWallet.queryBalance();
      const balance2 = await unassociatedUser.seiWallet.queryBalance();
      expectTxSuccess(tx, 'valid multisend');
      expectUseiBalanceDelta(balance, balance1, 100000, 'first multisend recipient');
      expectUseiBalanceDelta(balance_1, balance2, 100000, 'second multisend recipient');
    });

    it('Alice cannot perform multi-send with mismatched inputs and outputs', async () => {
      const inputAddress = alice.seiAddress;
      const outputAddress1 = userWithBalanceOnSei.seiAddress;
      const outputAddress2 = unassociatedUser.seiAddress;
      const outputAddress1PreBalance = await userWithBalanceOnSei.seiWallet.queryBalance();
      const outputAddress2PreBalance = await unassociatedUser.seiWallet.queryBalance();
      const inputPreBalance = await alice.seiWallet.queryBalance();
      const inputs = [
        {address: inputAddress, amount: [{amount: '100000', denom: 'usei'}]},
      ];

      const outputs = [
        {address: outputAddress1, amount: [{amount: '100000', denom: 'usei'}]},
        {address: outputAddress2, amount: [{amount: '100000', denom: 'usei'}]},
      ];

      const sendMessage = bankSei.coinMultiSendMessage(inputs, outputs);
      await expectFailure(
        alice.seiWallet.signAndSend(sendMessage),
        'sum inputs != sum outputs',
        'mismatched multisend'
      );
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
        SEND_AMOUNT,
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
        SEND_AMOUNT,
        'invalidDenom'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expectTxFailure(tx, 'insufficient funds');
    });

    it('Alice cannot send amount with fractions', async () => {
      // The CLI normalizes decimal amounts, so build the fractional amount by
      // editing a generate-only tx: the flow must fail at sign or broadcast.
      const alicePreBalance = await alice.seiWallet.queryBalance();
      await exec(`seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} ${SEND_AMOUNT}usei --fees 24200usei -y --from ${alice.seiAddress} --generate-only > fractionAmount.json`);
      await waitFor(0.5);

      const msg = JSON.parse(fs.readFileSync('fractionAmount.json', 'utf8'));
      msg.body.messages[0].amount[0].amount = '10000.5';
      fs.writeFileSync('fractionAmount.json', JSON.stringify(msg, null, 2));

      await expectFailure(
        (async () => {
          await exec(`seid tx sign fractionAmount.json --from ${alice.seiAddress} --chain-id sei-chain > signed_fraction_tx.json`);
          return execCommandAndReturnJson(`seid tx broadcast signed_fraction_tx.json --from ${alice.seiAddress} --broadcast-mode block`);
        })(),
        undefined,
        'send with fractional amount'
      );

      const alicePostBalance = await alice.seiWallet.queryBalance();
      expect(alicePostBalance.amount).to.be.eq(alicePreBalance.amount);
    });

    it('Alice cannot send txs with empty amounts', async () => {
      await expectFailure(
        execCommandAndReturnJson(`seid tx bank send ${alice.seiAddress} ${userWithBalanceOnSei.seiAddress} --fees 24200usei -y --from ${alice.seiAddress} --broadcast-mode block`),
        'Command failed',
        'send with empty amount'
      );
    });

    it('Ferdie with no available balance cannot send tokens', async () => {
      const noBalanceUser = await UserFactory.createUnassociatedUsers(admin, 'ferdie');

      const sendMessage = bankSei.coinSendMessage(
        noBalanceUser.seiWallet.walletAddress,
        alice.seiWallet.walletAddress,
        SEND_AMOUNT,
        'usei'
      );
      await expectFailure(
        noBalanceUser.seiWallet.signAndSend(sendMessage),
        'does not exist on chain',
        'send from unfunded account'
      );
    });

    it('Alice can send tokens with specifying very high fee', async () => {
      const preBalance = await alice.seiWallet.queryBalance();
      // Set a high fee
      alice.seiWallet.fee = VERY_HIGH_BUT_VALID_FEE;

      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        '100000',
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      const afterBalance = await alice.seiWallet.queryBalance();

      const feeAmount = parseInt(alice.seiWallet.fee.amount[0].amount);
      assert.strictEqual(
        parseInt(preBalance.amount) - parseInt(afterBalance.amount),
        100000 + feeAmount,
        'Balance should have decreased by amount plus fee'
      );

      // Reset fee to default
      alice.seiWallet.fee = { ...STANDARD_SIGN_AND_SEND_FEE };
    });

    it('Alice cant send funds with fees smaller than min fee', async () => {
      alice.seiWallet.fee = {amount: coins(1, 'usei'), gas: '500000'};

      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        SEND_AMOUNT,
        'usei'
      );
      await expectFailure(
        alice.seiWallet.signAndSend(sendMessage),
        'insufficient fees',
        'send with below-minimum fee'
      );

      // Reset fee to default
      alice.seiWallet.fee = { ...STANDARD_SIGN_AND_SEND_FEE };
    });

    it('A low-funded user can send all available balance minus fees', async () => {
      const maxSendUser = await UserFactory.createUnassociatedUsers(admin, 'maxSendUser', true);
      await UserFactory.fundAddressOnSei(maxSendUser.seiAddress, 'usei', '150000');
      await waitFor(1);
      const balance = await maxSendUser.seiWallet.queryBalance();
      const feeAmount = parseInt(maxSendUser.seiWallet.fee.amount[0].amount);
      const sendAmount = (parseInt(balance.amount) - feeAmount).toString();
      expect(Number(sendAmount)).to.be.gt(0);

      const sendMessage = bankSei.coinSendMessage(
        maxSendUser.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        sendAmount,
        'usei'
      );
      const tx = await maxSendUser.seiWallet.signAndSend(sendMessage);
      expectTxSuccess(tx, 'send all available balance');
      const afterBalance = await maxSendUser.seiWallet.queryBalance();

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
        SEND_AMOUNT,
        'usei'
      );
      const memo = 'Test memo field';
      const tx = await alice.seiWallet.signAndSend(sendMessage, memo);
      expectTxSuccess(tx, 'memo bank send');
    });

    it('Alice can add long memo fields with different characters', async () => {
      const sendMessage = bankSei.coinSendMessage(
        alice.seiWallet.walletAddress,
        userWithBalanceOnSei.seiWallet.walletAddress,
        SEND_AMOUNT,
        'usei'
      );
      const memo = 'Test memo field with crazy field 12121??????şlşşşşaççöçöşğüüğü';
      const tx = await alice.seiWallet.signAndSend(sendMessage, memo);
      expect(tx.code).to.be.eq(0);
    });

    it('Alice can call multisend with 100 input and outputs', async () => {
      alice.seiWallet.fee = { ...HIGH_MULTISEND_FEE };
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
      alice.seiWallet.fee = { ...STANDARD_SIGN_AND_SEND_FEE };
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
      await expectFailure(
        alice.seiWallet.signAndSend(sendMessage, memo),
        'maximum number of characters is 256 but received 257 characters: memo too large',
        'send with over-max memo'
      );

      const command = await exec(`seid tx bank send ${alice.seiAddress} ${userWithBalanceOnSei.seiAddress} ${SEND_AMOUNT}usei --fees 24200usei -y  --from ${alice.seiAddress} --note ${memo} --generate-only > overMaxMemo.json`);
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

      const command = await exec(`seid tx bank send ${alice.seiAddress} ${userWithBalanceOnSei.seiAddress} ${SEND_AMOUNT}usei --fees 24200usei -y  --from ${alice.seiAddress} --note ${memo} --generate-only > unsupportedChars.json`);
      await waitFor(0.5);
      const signTx = await exec(`seid tx sign unsupportedChars.json --from ${alice.seiAddress} --chain-id sei-chain > unsupported_signed_tx.json`);
      await waitFor(0.5);

      const broadcastTx = await exec(`seid tx broadcast unsupported_signed_tx.json --from ${alice.seiAddress} --broadcast-mode block`);

      const alicePostBalance = await alice.seiWallet.queryBalance();
      const userPostBalance = await userWithBalanceOnSei.seiWallet.queryBalance();

      expect((BigInt(alicePreBalance.amount) - BigInt(alicePostBalance.amount)).toString()).to.be.eq('0');
      expect((BigInt(userPostBalance.amount) - BigInt(userPreBalance.amount)).toString()).to.be.eq('0');
    });

    it('Alice cannot perform multi-send with no outputs', async () => {
      const inputs = [
        {address: alice.seiWallet.walletAddress, amount: [{amount: '1000', denom: 'usei'}]},
      ];
      const outputs: any[] = [];
      const sendMessage = bankSei.coinMultiSendMessage(inputs, outputs);
      await expectFailure(
        alice.seiWallet.signAndSend(sendMessage),
        'Broadcasting transaction failed',
        'multisend with no outputs'
      );
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
      expect(tokenFactoryDenom).to.contain(alice.seiAddress);
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
      expect(found).to.not.be.undefined;
      expect(found!.amount).to.be.eq(TOKENFACTORY_MINT_AMOUNT);
    });
  });

  describe('Users can query through CLI and RPC', function () {
    let tokenFactoryDenom: string;

    it('Alice can query her balance through RPC for new tokenfactory denom', async () =>{
      tokenFactoryDenom = `factory/${alice.seiAddress}/mydenom`;
      const response = await withBankQueryClient((queryClient) =>
        queryClient.bank.balance(alice.seiAddress, tokenFactoryDenom)
      );
      expect(response.amount).to.be.eq(TOKENFACTORY_MINT_AMOUNT);
      expect(response.denom).to.be.eq(tokenFactoryDenom);
    })

    it('RPC denom metadata query for usei reports missing metadata', async () =>{
      await expectFailure(
        withBankQueryClient((queryClient) =>
          queryClient.bank.denomMetadata('usei')
        ),
        'key not found',
        'denom metadata query for usei'
      );
    });

    it('Alice can query all total supplies through RPC', async () =>{
      const response = await withBankQueryClient((queryClient) =>
        queryClient.bank.totalSupply()
      );
      expect(response.supply).to.have.length.gt(3);
    });

    it('Alice can query all her available balances through RPC', async () =>{
      const response = await withBankQueryClient((queryClient) =>
        queryClient.bank.allBalances(alice.seiAddress)
      );
      expect(response).to.have.length.gte(2);
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('seid bank balance matches RPC balance for alice', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q bank balances ${alice.seiAddress} --denom usei`
      );
      const rpcResult = await withBankQueryClient((queryClient) =>
        queryClient.bank.balance(alice.seiAddress, 'usei')
      );
      expect(cliResult.amount).to.be.eq(rpcResult.amount);
      expect(cliResult.denom).to.be.eq(rpcResult.denom);
    });

    it('seid total supply matches RPC supplyOf for usei', async () => {
      const cliResult = await execCommandAndReturnJson('seid q bank total --denom usei');
      const querierResult = await withBankQueryClient((queryClient) =>
        queryClient.bank.supplyOf('usei')
      );
      const cliAmount = Number(cliResult.amount);
      const querierAmount = Number(querierResult.amount);
      expect(Math.abs(cliAmount - querierAmount)).to.be.lt(cliAmount * 0.01);
    });

    it('All balances via seid match RPC all balances count', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q bank balances ${alice.seiAddress}`
      );
      const querierResult = await withBankQueryClient((queryClient) =>
        queryClient.bank.allBalances(alice.seiAddress)
      );
      expect(cliResult.balances.length).to.be.eq(querierResult.length);
      for (const cliBal of cliResult.balances) {
        const querierBal = querierResult.find((b) => b.denom === cliBal.denom);
        expect(querierBal).to.not.be.undefined;
        expect(cliBal.amount).to.be.eq(querierBal!.amount);
      }
    });

    it('Denom metadata via seid and RPC both report missing usei metadata', async () => {
      let cliError = '';
      let rpcError = '';

      try {
        await execCommandAndReturnJson('seid q bank denom-metadata --denom usei');
      } catch (e: any) {
        cliError = e.message;
      }

      try {
        await withBankQueryClient((queryClient) =>
          queryClient.bank.denomMetadata('usei')
        );
      } catch (e: any) {
        rpcError = e.message;
      }

      expect(cliError).to.contain('key not found');
      expect(rpcError).to.contain('key not found');
    });
  });


  describe('Edge Cases', function () {
    it('Querying balance of non-existent address returns zero', async () => {
      const validUnfundedUser = await UserFactory.createUnassociatedUsers(admin, 'bankZeroBal');
      const response = await withBankQueryClient((queryClient) =>
        queryClient.bank.balance(validUnfundedUser.seiAddress, 'usei')
      );
      expect(response.amount).to.be.eq('0');
    });

    it('Querying balance of non-existent denom returns zero', async () => {
      const response = await withBankQueryClient((queryClient) =>
        queryClient.bank.balance(alice.seiAddress, 'unonexistent999')
      );
      expect(response.amount).to.be.eq('0');
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
        rapidUser.seiWallet.fee = { ...STANDARD_SIGN_AND_SEND_FEE };
        const tx = await rapidUser.seiWallet.signAndSend(msg);
        expect(tx.code).to.be.eq(0);
      }

      const postBalance = await rapidUser.seiWallet.queryBalance();
      const expectedDecrease = (1000 + Number(STANDARD_SIGN_AND_SEND_FEE.amount[0].amount)) * 3;
      expect(Number(preBalance.amount) - Number(postBalance.amount)).to.be.eq(expectedDecrease);
    });

    it('Send to self deducts only fees, balance net change equals negative fee', async () => {
      const selfUser = await UserFactory.createSeiUser(admin, 'bankSelfSend');
      selfUser.seiWallet.fee = { ...STANDARD_SIGN_AND_SEND_FEE };
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
      expect(Number(preBalance.amount) - Number(postBalance.amount)).to.be.eq(Number(STANDARD_SIGN_AND_SEND_FEE.amount[0].amount));
    });

    it('Rebroadcasting the same signed tx is rejected and does not execute twice', async () => {
      // Unlike the expected-failure sign flows above, this tx must actually
      // land, so it needs the node's real chain id rather than a placeholder.
      const chainId = await alice.seiWallet.signingClient.getChainId();
      await exec(`seid tx bank send ${alice.seiAddress} ${unassociatedUser.seiAddress} 1000usei --fees ${CLI_FEE} -y --from ${alice.seiAddress} --generate-only > duplicateUnsigned.json`);
      await waitFor(0.5);
      await exec(`seid tx sign duplicateUnsigned.json --from ${alice.seiAddress} --chain-id ${chainId} > duplicateSigned.json`);
      await waitFor(0.5);

      const first = await execCommandAndReturnJson('seid tx broadcast duplicateSigned.json --broadcast-mode block');
      expect(first.code).to.be.eq(0);

      // Replaying the exact same bytes must fail. The node rejects it from
      // the mempool cache (sdk code 19, "tx already in cache", empty raw_log);
      // if the cache were evicted it would fail sequence verification
      // (sdk code 32) instead. Either way the tx must not execute twice.
      const second = await execCommandAndReturnJson('seid tx broadcast duplicateSigned.json --broadcast-mode block');
      expectTxFailure(second);
      expect(second.code).to.be.oneOf([19, 32]);
      expect(second.codespace).to.be.eq('sdk');
    });

    it('Send of an astronomically large amount fails without overflow issues', async () => {
      const preBalance = await alice.seiWallet.queryBalance();
      const sendMessage = bankSei.coinSendMessage(
        alice.seiAddress,
        userWithBalanceOnSei.seiAddress,
        '1000000000000000000000000000000', // 10^30 usei, far beyond total supply
        'usei'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expectTxFailure(tx, 'insufficient funds');

      const postBalance = await alice.seiWallet.queryBalance();
      // Only the fee may have been deducted; the principal must be untouched.
      const deducted = BigInt(preBalance.amount) - BigInt(postBalance.amount);
      expect(deducted <= BigInt(alice.seiWallet.fee.amount[0].amount)).to.be.true;
    });

    it('Multi-send with the same recipient listed twice credits the sum', async () => {
      const recipient = await UserFactory.createUnassociatedUsers(admin, 'bankDupOutput');
      const preBalance = await recipient.seiWallet.queryBalance();

      const inputs = [
        {address: alice.seiAddress, amount: [{amount: '3000', denom: 'usei'}]},
      ];
      const outputs = [
        {address: recipient.seiAddress, amount: [{amount: '1000', denom: 'usei'}]},
        {address: recipient.seiAddress, amount: [{amount: '2000', denom: 'usei'}]},
      ];
      const tx = await alice.seiWallet.signAndSend(bankSei.coinMultiSendMessage(inputs, outputs));
      expectTxSuccess(tx, 'multisend with duplicate outputs');

      const postBalance = await recipient.seiWallet.queryBalance();
      expectUseiBalanceDelta(preBalance, postBalance, 3000, 'duplicate-output recipient');
    });

    it('Denoms are case sensitive: sending USEI fails despite holding usei', async () => {
      const sendMessage = bankSei.coinSendMessage(
        alice.seiAddress,
        userWithBalanceOnSei.seiAddress,
        '1000',
        'USEI'
      );
      const tx = await alice.seiWallet.signAndSend(sendMessage);
      expectTxFailure(tx, 'insufficient funds');
    });
  });
});
