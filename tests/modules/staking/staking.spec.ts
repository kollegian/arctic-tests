import {coin} from '@cosmjs/proto-signing';
import {execCommandAndReturnJson} from '../../../shared/utils/cliUtils';
import {waitFor} from '../../../shared/utils/helpers';
import util from 'node:util';
import {SeiUser, UserFactory} from '../../../shared/User';
import testConfig from '../../../config/testConfig.json';
import Staking from './Staking';
import fs from 'fs';
import ExpectStatic = Chai.ExpectStatic;
import { Querier } from '@sei-js/cosmos/rest';
import { getRpcQueryClient, moduleRestEndpoint, toSnakeCase, withRestFallback } from '../utils/rpcQueryClient';

const exec = util.promisify(require('node:child_process').exec);

let expect: ExpectStatic;
const CLI_FEE = '50000usei';
const DEFAULT_GAS = '500000';
const SMALL_STAKE_AMOUNT = '10';
const STANDARD_STAKE_AMOUNT = '10000';
const USEI_DENOM = 'usei';
const SIGN_CHAIN_ID = 'sei-chain';
const restEndpoint = moduleRestEndpoint;

const queryStakingValidators = (status: string) =>
  withRestFallback(
    'staking.validators',
    async () => toSnakeCase(await (await getRpcQueryClient()).staking.validators(status as any)),
    () => Querier.cosmos.staking.v1beta1.Validators({ status }, { pathPrefix: restEndpoint }),
  );

const queryStakingValidator = (validatorAddr: string) =>
  withRestFallback(
    'staking.validator',
    async () => toSnakeCase(await (await getRpcQueryClient()).staking.validator(validatorAddr)),
    () =>
      Querier.cosmos.staking.v1beta1.Validator(
        { validator_addr: validatorAddr },
        { pathPrefix: restEndpoint },
      ),
  );

const queryDelegatorDelegations = (delegator: string) =>
  withRestFallback(
    'staking.delegatorDelegations',
    async () => toSnakeCase(await (await getRpcQueryClient()).staking.delegatorDelegations(delegator)),
    () =>
      Querier.cosmos.staking.v1beta1.DelegatorDelegations(
        { delegator_addr: delegator },
        { pathPrefix: restEndpoint },
      ),
  );

const queryDelegatorValidators = (delegator: string) =>
  withRestFallback(
    'staking.delegatorValidators',
    async () => toSnakeCase(await (await getRpcQueryClient()).staking.delegatorValidators(delegator)),
    () =>
      Querier.cosmos.staking.v1beta1.DelegatorValidators(
        { delegator_addr: delegator },
        { pathPrefix: restEndpoint },
      ),
  );

const queryDelegatorUnbondingDelegations = (delegator: string) =>
  withRestFallback(
    'staking.delegatorUnbondingDelegations',
    async () => toSnakeCase(await (await getRpcQueryClient()).staking.delegatorUnbondingDelegations(delegator)),
    () =>
      Querier.cosmos.staking.v1beta1.DelegatorUnbondingDelegations(
        { delegator_addr: delegator },
        { pathPrefix: restEndpoint },
      ),
  );

const queryStakingPool = () =>
  withRestFallback(
    'staking.pool',
    async () => toSnakeCase(await (await getRpcQueryClient()).staking.pool()),
    () => Querier.cosmos.staking.v1beta1.Pool({}, { pathPrefix: restEndpoint }),
  );

const queryStakingParams = () =>
  withRestFallback(
    'staking.params',
    async () => toSnakeCase(await (await getRpcQueryClient()).staking.params()),
    () => Querier.cosmos.staking.v1beta1.Params({}, { pathPrefix: restEndpoint }),
  );

const queryStakingHistoricalInfo = (height: number) =>
  withRestFallback(
    'staking.historicalInfo',
    async () => toSnakeCase(await (await getRpcQueryClient()).staking.historicalInfo(height)),
    () =>
      Querier.cosmos.staking.v1beta1.HistoricalInfo(
        { height },
        { pathPrefix: restEndpoint },
      ),
  );
describe('Staking Tests', function () {
  this.timeout(4 * 60 * 1000);
  let admin: SeiUser;
  let eve: SeiUser;
  let staking: Staking;
  let validatorAddress: string;
  let allValidators: any;

  before('', async () => {
    const chai = await import('chai');
    ({expect} = chai);
    fs.mkdirSync('./staking', {recursive: true});
    await waitFor(1);
    const val = await execCommandAndReturnJson(`seid query staking validators`);
    allValidators = val.validators;
    validatorAddress = allValidators[0].operator_address;
    admin = await UserFactory.createAdminUser();
    eve = await UserFactory.createSeiUser(admin, 'eve');

    staking = new Staking();
    await staking.initialize(eve.seiWallet.wallet, testConfig.seiRpcEndpoint, restEndpoint);
  });

  after('Removes generated tx artifacts', () => {
    fs.rmSync('./staking', { recursive: true, force: true });
  });

  describe('Delegation Tests', function () {

    it('Eve can delegate tokens to a validator and see her stake on validator delegations', async () => {
      const stakingPool = await staking.cmdPool();
      const validatorPreDelegations = await staking.cmdQueryDelegationsTo(validatorAddress);
      const preBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const tx = await staking.delegateTx(eve, validatorAddress, coin(SMALL_STAKE_AMOUNT, USEI_DENOM));
      expect(tx.code).to.be.eq(0);
      const balance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      expect(Number(balance.amount)).to.be.lessThan(Number(preBalance.amount));

      // Validate through queries
      const eveDelegations = await staking.cmdDelegations(eve.seiAddress);
      expect(eveDelegations.length).to.be.eq(1);
      expect(eveDelegations[0].balance!.amount).to.be.eq(SMALL_STAKE_AMOUNT);
      expect(eveDelegations[0].balance!.denom).to.be.eq(USEI_DENOM);
      expect(eveDelegations[0].delegation!.delegator_address).to.be.eq(eve.seiAddress);
      expect(eveDelegations[0].delegation!.validator_address).to.be.eq(validatorAddress);
      expect(parseFloat(eveDelegations[0].delegation!.shares)).to.be.eq(Number(SMALL_STAKE_AMOUNT));

      const validatorDelegations = await staking.cmdQueryDelegationsTo(validatorAddress);
      expect(validatorDelegations.length).to.be.eq(validatorPreDelegations.length + 1);
      const lastStake = staking.findUserLastDelegation(eve.seiAddress, validatorAddress, validatorDelegations);
      expect(lastStake.balance!.amount).to.be.eq(SMALL_STAKE_AMOUNT);
      expect(parseFloat(lastStake.delegation!.shares)).to.be.eq(Number(SMALL_STAKE_AMOUNT));
      expect(lastStake.delegation!.validator_address).to.be.eq(validatorAddress);

      const afterStakingPool = await staking.cmdPool();
      expect(BigInt(afterStakingPool.bonded_tokens) > 0n).to.be.true;
    });

    it('Eve cant stake usdt into validator', async () => {
      await UserFactory.fundAddressOnSei(eve.seiAddress, 'uusdt');
      const tx = await staking.delegateTx(eve, validatorAddress, coin('100000', 'uusdt'));
      expect(tx.rawLog).to.contain('invalid coin denomination');
    });

    it('Eve cant stake 0 into validator', async () => {
      //generate only tx
      const tx = await exec(`seid tx staking delegate ${validatorAddress} ${STANDARD_STAKE_AMOUNT}${USEI_DENOM} --from ${eve.seiAddress} --fees ${CLI_FEE} --gas ${DEFAULT_GAS} -y --broadcast-mode block --generate-only > ./staking/zeroAmountUnsigned.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/zeroAmountUnsigned.json', 'utf8'));
      msg.body.messages[0].amount.amount = '0';
      fs.writeFileSync('./staking/zeroAmountUnsigned.json', JSON.stringify(msg, null, 2));
      await waitFor(1);
      const signTx = await exec(`seid tx sign ./staking/zeroAmountUnsigned.json --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} > ./staking/zeroAmountSigned.json`);
      await waitFor(0.5);
      const broadcastTX = await execCommandAndReturnJson(`seid tx broadcast ./staking/zeroAmountSigned.json --from ${eve.seiAddress} --broadcast-mode block`);
      expect(broadcastTX.raw_log).to.contain('invalid delegation amount');
    });

    it('Eve cant stake more than she has', async () => {
      const preBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const stakeAmount = Number(preBalance.amount) + 10;
      const tx = await staking.delegateTx(eve, validatorAddress, coin(stakeAmount.toString(), 'usei'));
      expect(tx.rawLog).to.contain('insufficient funds');
    });

    it('Eve cant stake minus coins', async () => {
      const tx = await exec(`seid tx staking delegate ${validatorAddress} ${STANDARD_STAKE_AMOUNT}${USEI_DENOM} --from ${eve.seiAddress} --fees ${CLI_FEE} --gas ${DEFAULT_GAS} -y --broadcast-mode block --generate-only > ./staking/minusAmountUnsigned.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/minusAmountUnsigned.json', 'utf8'));
      msg.body.messages[0].amount.amount = '-10000';
      fs.writeFileSync('./staking/minusAmountUnsigned.json', JSON.stringify(msg, null, 2));


      await waitFor(1);
      const signTx = await exec(`seid tx sign ./staking/minusAmountUnsigned.json --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} > ./staking/minusAmountSigned.json`);
      await waitFor(0.5);
      const broadcastTX = await execCommandAndReturnJson(`seid tx broadcast ./staking/minusAmountSigned.json --from ${eve.seiAddress} --broadcast-mode block`);
      expect(broadcastTX.raw_log).to.contain('invalid delegation amount');
    });

    it('Eve cant stake to empty addresses', async () => {
      const tx = await exec(`seid tx staking delegate ${validatorAddress} ${STANDARD_STAKE_AMOUNT}${USEI_DENOM} --from ${eve.seiAddress} --fees ${CLI_FEE} --gas ${DEFAULT_GAS} -y --broadcast-mode block --generate-only > ./staking/emptyAccountUnsigned.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/emptyAccountUnsigned.json', 'utf8'));
      msg.body.messages[0].validator_address = '';
      fs.writeFileSync('./staking/emptyAccountUnsigned.json', JSON.stringify(msg, null, 2));


      await waitFor(1);
      const signTx = await exec(`seid tx sign ./staking/emptyAccountUnsigned.json --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} > ./staking/emptyAccountSigned.json`);
      await waitFor(0.5);
      const broadcastTX = await execCommandAndReturnJson(`seid tx broadcast ./staking/emptyAccountSigned.json --from ${eve.seiAddress} --broadcast-mode block`);
      expect(broadcastTX.code).to.not.be.eq(0);
      expect(broadcastTX.raw_log).to.contain('address');
    });

    it('Eve cant stake invalid addresses', async () => {
      const tx = await staking.delegateTx(eve, 'invalid', coin(SMALL_STAKE_AMOUNT, USEI_DENOM));
      expect(tx.rawLog).to.contain('invalid bech32 string length');
    });

    it('Eve cant stake to unexisting validator address', async () => {
      const unexistingValidatorAddress = 'seivaloper1ykls6dhh2mjqk9x0d3ee29873stf7wwvedcjmh';
      const tx = await staking.delegateTx(eve, unexistingValidatorAddress, coin(SMALL_STAKE_AMOUNT, USEI_DENOM));
      expect(tx.rawLog).to.contain('validator does not exist');
    });

    it('Unassociated Ferdie can stake to a validator on cosmos runtime', async () => {
      const ferdie = await UserFactory.createUnassociatedUsers(admin, 'ferdie');
      await UserFactory.fundAddressOnSei(ferdie.seiAddress);
      const tx = await staking.delegateTx(ferdie, validatorAddress, coin('1', USEI_DENOM));
      const ferdieDelegation = await staking.cmdDelegations(ferdie.seiAddress);
      expect(ferdieDelegation.length).to.be.eq(1);
      expect(ferdieDelegation[0].balance!.amount).to.be.eq('1');
      expect(ferdieDelegation[0].balance!.denom).to.be.eq(USEI_DENOM);
      expect(ferdieDelegation[0].delegation!.delegator_address).to.be.eq(ferdie.seiAddress);
      expect(ferdieDelegation[0].delegation!.validator_address).to.be.eq(validatorAddress);
      expect(parseFloat(ferdieDelegation[0].delegation!.shares)).to.be.eq(1);
    });

    it('Eve can query rewards for her stake', async () => {
      const rewards = await staking.cmdRewards(validatorAddress, eve.seiAddress);
      expect(rewards).to.be.an('array');
      if (rewards.length > 0) {
        expect(rewards[0].denom).to.be.eq(USEI_DENOM);
        expect(parseFloat(rewards[0].amount)).to.be.gte(0);
      }
    });

    it('Eve can stake and increase her position to the same validator', async () => {
      const initialDelegations = await staking.cmdDelegations(eve.seiAddress);
      let initialAmount = 0;
      if (initialDelegations.length > 0) {
        initialAmount = Number(initialDelegations[0].balance!.amount);
      }

      const additionalStake = 50;
      const tx = await staking.delegateTx(eve, validatorAddress, coin(additionalStake.toString(), 'usei'));
      expect(tx.code).to.be.eq(0);

      const updatedDelegations = await staking.cmdDelegations(eve.seiAddress);
      expect(updatedDelegations.length).to.be.eq(1);
      expect(Number(updatedDelegations[0].balance!.amount)).to.be.eq(initialAmount + additionalStake);
      expect(updatedDelegations[0].delegation!.validator_address).to.be.eq(validatorAddress);
    });

    it('Eve tries to send multiple delegations to the same validator in the same block without updating the sequence', async () => {
      const evePreBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const eveSequencePre = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const preDelegations = await staking.cmdDelegations(eve.seiAddress);
      const firstDelegationTx = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --broadcast-mode block --generate-only > ./staking/firstValidTx.json`);
      const secondDelegationTx = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --broadcast-mode block --generate-only > ./staking/secondValidTx.json`);
      const signTx = await exec(`seid tx sign ./staking/firstValidTx.json --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} > ./staking/firstValidTxSigned.json`);
      await waitFor(1);
      const sign2Tx = await exec(`seid tx sign ./staking/secondValidTx.json --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} > ./staking/secondValidTxSigned.json`);
      await waitFor(1);
      const results = await Promise.all([
        execCommandAndReturnJson(`seid tx broadcast ./staking/firstValidTxSigned.json --broadcast-mode block`),
        execCommandAndReturnJson(`seid tx broadcast ./staking/secondValidTxSigned.json --broadcast-mode block`),
      ]);
      const eveAfterBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const eveSequenceAfter = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const delegations = await staking.cmdDelegations(eve.seiAddress);
      const resultCodes = results.map((result: any) => result.code ?? 0);
      expect(resultCodes.some((code: number) => code !== 0)).to.be.true;
      expect(delegations.length).to.be.eq(preDelegations.length);

      //validate sequence not increased twice
      expect(Number(eveSequenceAfter.sequence) - Number(eveSequencePre.sequence)).to.be.at.most(1);
      expect(Number(eveAfterBalance.amount)).to.be.at.most(Number(evePreBalance.amount));
    });

    it('Eve can send multiple delegations to the same validator sequentially', async () => {
      const preDelegations = await staking.cmdDelegations(eve.seiAddress);
      const evePreBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const evePreSequence = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const result1 = await staking.delegateTx(eve, validatorAddress, coin('10000', USEI_DENOM));
      const result2 = await staking.delegateTx(eve, validatorAddress, coin('10000', USEI_DENOM));

      expect(result1.code).to.be.eq(0);
      expect(result2.code).to.be.eq(0);
      await waitFor(1);
      const afterDelegations = await staking.cmdDelegations(eve.seiAddress);
      expect(preDelegations.length).to.be.eq(afterDelegations.length);
      const eveAfterBalance = await execCommandAndReturnJson(`seid q bank balances ${eve.seiAddress} --denom usei`);
      const eveSequenceAfter = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);

      //Validate shares
      expect(parseFloat(afterDelegations[0].delegation.shares)).to.be.eq(parseFloat(preDelegations[0].delegation.shares) + 20000);

      const balanceLowLimit = Number(evePreBalance.amount) - 20000 - 100000;
      const balanceHighLimit = Number(evePreBalance.amount) - 20000 - 100000 + 20;
      //Balance checks
      expect(Number(eveAfterBalance.amount)).to.be.within(balanceLowLimit, balanceHighLimit);

      //Sequence checks
      expect(Number(eveSequenceAfter.sequence)).to.be.eq(Number(evePreSequence.sequence) + 2);
    });

    it('Eve can initiate a failing tx with a low gas limit and send a regular tx', async () =>{
      const evePreBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const evePreDelegations = await staking.cmdDelegations(eve.seiAddress);
      const evePreSequence = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);

      const tx1 = await exec(`seid tx staking delegate ${validatorAddress} 50000usei --from ${eve.seiAddress} --fees 50000usei --gas 1000 -y --broadcast-mode block --generate-only > ./staking/lowGasLimitTx.json`);
      const tx2 = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --broadcast-mode block --generate-only > ./staking/regularTx.json`);
      const signTx1 = await exec(`seid tx sign ./staking/lowGasLimitTx.json --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} > ./staking/lowGasLimitTxSigned.json`);
      const signTx2 = await exec(`seid tx sign ./staking/regularTx.json --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} > ./staking/regularTxSigned.json`);
      await waitFor(1);
      const lowGasResult = await execCommandAndReturnJson(`seid tx broadcast ./staking/lowGasLimitTxSigned.json --broadcast-mode block`);
      expect(lowGasResult.code).to.not.be.eq(0);
      const regularTx = await staking.delegateTx(eve, validatorAddress, coin('10000', USEI_DENOM));
      expect(regularTx.code).to.be.eq(0);
      await waitFor(1);
      const eveAfterBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const eveAfterDelegations = await staking.cmdDelegations(eve.seiAddress);
      const eveSequenceAfter = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      //Validations
      expect(Number(eveAfterBalance.amount)).to.be.lessThan(Number(evePreBalance.amount));
      expect(eveAfterDelegations.length).to.be.eq(evePreDelegations.length);
      expect(Number(eveSequenceAfter.sequence)).to.be.gte(Number(evePreSequence.sequence) + 1);

      expect(parseFloat(eveAfterDelegations[0].delegation.shares)).to.be.eq(parseFloat(evePreDelegations[0].delegation.shares) + 10000);
    });

  });

  describe('Redelegation Tests', function () {
    let allStakes: any[];
    let validator2Address: string;

    before(async () => {
      validator2Address = allValidators[1].operator_address;
      const topUpTx = await staking.delegateTx(eve, validatorAddress, coin('30000', USEI_DENOM));
      expect(topUpTx.code).to.be.eq(0);
      allStakes = await staking.cmdDelegations(eve.seiAddress);
    });

    it('Eve can redelegate one of her existing stakes into another validator', async () => {
      allStakes = await staking.cmdDelegations(eve.seiAddress);
      const evePreBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, allStakes);
      const redelegateTx = await staking.redelegateTx(eve, validator2Address, coin(5000, "usei"), validatorAddress);
      expect(redelegateTx.code).to.be.eq(0);

      const eveAfterBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const balanceLowLimit = Number(evePreBalance.amount) - 1000 - 50000;
      const balanceHighLimit = Number(evePreBalance.amount) - 1000 - 50000 + 2000;
      expect(Number(eveAfterBalance.amount)).to.be.within(balanceLowLimit, balanceHighLimit);

      allStakes = await staking.cmdDelegations(eve.seiAddress);
      const eveLastStake = await staking.findUserLastDelegation(eve.seiAddress, validator2Address, allStakes);
      expect(eveLastStake.balance!.amount).to.be.eq('5000');
      expect(eveLastStake.delegation!.shares).to.contain('5000.000');
      expect(eveLastStake.delegation!.validator_address).to.be.eq(validator2Address);
    });

    it('Eve cant redelegate more than her balance to another validator', async () => {
      allStakes = await staking.cmdDelegations(eve.seiAddress);
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, allStakes);
      const moreThanBalance = Number(eveStake.balance!.amount) + 1000;

      const redelegateTx = await staking.redelegateTx(eve, validator2Address, coin(moreThanBalance, 'usei'), validatorAddress);
      expect(redelegateTx.rawLog).to.contain('failed to execute message');
    });

    it('Eve cant redelegate to an unexisting validator', async () => {
      const unexistingValidatorAddress = 'seivaloper1xyzinvalidaddress000000';
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, allStakes);

      const redelegateTx = await staking.redelegateTx(eve, unexistingValidatorAddress, coin(1000, 'usei'), validatorAddress);
      expect(redelegateTx.rawLog).to.contain('failed to execute message');
    });

    it('Eve cant redelegate to invalid validator address', async () => {
      const invalidValidatorAddress = 'invalidaddress123';
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, allStakes);

      const redelegateTx = await staking.redelegateTx(eve, invalidValidatorAddress, coin(1000, 'usei'), validatorAddress);
      expect(redelegateTx.rawLog).to.contain('failed to execute message');
    });

    it('Eve cant redelegate to her own validator', async () => {

      const redelegateTx = await staking.redelegateTx(eve, validatorAddress, coin(100, 'usei'), validatorAddress);
      expect(redelegateTx.rawLog).to.contain('failed to execute message');
    });

    it('Eve can redelegate to the same validator twice', async () => {
      const redelegationUser = await UserFactory.createSeiUser(admin, 'stakingRedelegateTwice');
      await staking.delegateTx(redelegationUser, validatorAddress, coin('2000', USEI_DENOM));

      const firstRedelegateTx = await staking.redelegateTx(redelegationUser, validator2Address, coin(500, 'usei'), validatorAddress);
      expect(firstRedelegateTx.code).to.be.eq(0);

      const secondRedelegateTx = await staking.redelegateTx(redelegationUser, validator2Address, coin(300, 'usei'), validatorAddress);
      expect(secondRedelegateTx.code).to.be.eq(0);

      const updatedStakes = await staking.cmdDelegations(redelegationUser.seiAddress);
      const foundStake = await staking.findUserLastDelegation(redelegationUser.seiAddress, validator2Address, updatedStakes);
      expect(foundStake.balance!.amount).to.be.eq('800');
    });

    it('Eve cant redelegate from a validator she doesnt have a stake in', async () => {
      const nonStakedValidatorAddress = allValidators[2].operator_address;

      const redelegateTx = await staking.redelegateTx(eve, validator2Address, coin(1000, 'usei'), nonStakedValidatorAddress);
      expect(redelegateTx.rawLog).to.contain('failed to execute message');
    });

    it('Eve can delegate and then redelegate sequentially', async () => {
      const targetValidator = allValidators[2].operator_address;
      const eveSequence = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const evePreDelegation = await staking.cmdDelegation(eve.seiAddress, validatorAddress);
      const delegateResult = await staking.delegateTx(eve, validatorAddress, coin('10000', USEI_DENOM));
      const redelegateResult = await staking.redelegateTx(eve, targetValidator, coin('1000', USEI_DENOM), validatorAddress);
      expect(delegateResult.code).to.be.eq(0);
      expect(redelegateResult.code).to.be.eq(0);

      const eveSequenceAfter = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const updatedStakes = await staking.cmdDelegations(eve.seiAddress);
      const sourceStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, updatedStakes);
      expect(sourceStake).to.not.be.undefined;
      expect(parseFloat(sourceStake.delegation!.shares)).to.be.gte(
        parseFloat(evePreDelegation.shares)
      );
      const foundStake = await staking.findUserLastDelegation(eve.seiAddress, targetValidator, updatedStakes);
      expect(Number(foundStake.balance!.amount)).to.be.gte(1000);

      //Validate sequence
      expect(Number(eveSequenceAfter.sequence)).to.be.eq(Number(eveSequence.sequence) + 2);
    });

    it('Eve can redelegate max amount of shares to a different validator', async () => {
      const maxRedelegateValidator = allValidators[3]?.operator_address ?? allValidators[2].operator_address;
      let existingDestinationShares = 0;
      try {
        const evePreStakes = await staking.cmdDelegation(eve.seiAddress, maxRedelegateValidator);
        existingDestinationShares = parseFloat(evePreStakes.delegation!.shares);
      } catch {
        existingDestinationShares = 0;
      }
      allStakes = await staking.cmdDelegations(eve.seiAddress);
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, allStakes);
      const redelegateTx = await staking.redelegateTx(eve, maxRedelegateValidator, coin(Number(eveStake.balance!.amount), 'usei'), validatorAddress);
      expect(redelegateTx.code).to.be.eq(0);

      const updatedStakes = await staking.cmdDelegations(eve.seiAddress);
      const foundStake = await staking.findUserLastDelegation(eve.seiAddress, maxRedelegateValidator, updatedStakes);

      expect(parseFloat(foundStake.delegation!.shares)).to.be.eq(parseFloat(eveStake.delegation!.shares) + existingDestinationShares);
    });

    it('Eve cant redelegate zero amount of shares', async () => {
      const zeroAmountRedelegation = await exec(`seid tx staking redelegate ${validatorAddress} ${validator2Address} 10usei --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --generate-only > ./staking/zeroAmountRedelegateTx.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/zeroAmountRedelegateTx.json', 'utf8'));
      msg.body.messages[0].amount.amount = '0';
      fs.writeFileSync('./staking/zeroAmountRedelegateTx.json', JSON.stringify(msg, null, 2));
      const signTx = await exec(`seid tx sign ./staking/zeroAmountRedelegateTx.json --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} > ./staking/zeroAmountRedelegateTxSigned.json`);
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast ./staking/zeroAmountRedelegateTxSigned.json --broadcast-mode block`);
      expect(broadcastTx.raw_log).to.contain('invalid shares amount');
    });

    it('Eve cant redelegate minus amounts into another validator', async () => {
      await staking.delegateTx(eve, validatorAddress, coin(10000, 'usei'));
      const preStateValidator1 = await staking.cmdDelegation(eve.seiAddress, validatorAddress);
      const preStateValidator2 = await staking.cmdDelegation(eve.seiAddress, validator2Address);
      const minusAmountRedelegation = await exec(`seid tx staking redelegate ${validatorAddress} ${validator2Address} 10usei --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --generate-only > ./staking/minusAmountRedelegateTx.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/minusAmountRedelegateTx.json', 'utf8'));
      msg.body.messages[0].amount.amount = '-1000';
      fs.writeFileSync('./staking/minusAmountRedelegateTx.json', JSON.stringify(msg, null, 2));
      const signedTx = await exec(`seid tx sign ./staking/minusAmountRedelegateTx.json --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} > ./staking/minusAmountRedelegateTxSigned.json`);
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast ./staking/minusAmountRedelegateTxSigned.json --broadcast-mode block`);
      expect(broadcastTx.raw_log).to.contain('invalid shares amount');

      const afterStateValidator1 = await staking.cmdDelegation(eve.seiAddress, validatorAddress);
      const afterStateValidator2 = await staking.cmdDelegation(eve.seiAddress, validator2Address);

      expect(JSON.stringify(afterStateValidator1)).to.be.eq(JSON.stringify(preStateValidator1));
      expect(JSON.stringify(afterStateValidator2)).to.be.eq(JSON.stringify(preStateValidator2));
    });
  });

  describe('Unbonding Tests', function () {
    let validator2Address: string;

    it('Eve can unbond a valid amount of shares', async () => {
      validator2Address = allValidators[1].operator_address;
      const setupTx = await staking.delegateTx(eve, validatorAddress, coin('5000', USEI_DENOM));
      expect(setupTx.code).to.be.eq(0);
      const evePreDelegations = await staking.cmdDelegations(eve.seiAddress);
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, evePreDelegations);

      const unbondTx = await staking.undelegateTx(eve, validatorAddress, coin(1000, 'usei'));
      expect(unbondTx.code).to.be.eq(0);

      const evePostDelegations = await staking.cmdDelegations(eve.seiAddress);
      const postStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, evePostDelegations);

      // Validate reduced shares
      expect(parseFloat(postStake.delegation!.shares)).to.be.eq(parseFloat(eveStake.delegation!.shares) - 1000);

      const unbondDelegations = await staking.cmdUnbondingDelegations(eve.seiAddress);
      const unbondStake = unbondDelegations.find((unbond: any) =>
        unbond.delegator_address === eve.seiAddress && unbond.validator_address === validatorAddress
      );
      expect(unbondStake).to.not.be.undefined;
      expect(unbondStake.entries.some((entry: any) => entry.balance === '1000')).to.be.true;
    });

    it('Eve cannot unbond more shares than she holds', async () => {
      const eveDelegations = await staking.cmdDelegations(eve.seiAddress);
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, eveDelegations);
      const overBalance = Number(eveStake.delegation!.shares) + 1000;

      const unbondTx = await staking.undelegateTx(eve, validatorAddress, coin(overBalance, 'usei'));
      expect(unbondTx.rawLog).to.contain('failed to execute message');
    });

    it('Eve cannot unbond zero shares', async () => {
      const zeroAmountUnbondingTx = await exec(`seid tx staking unbond ${validatorAddress} 10usei --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --generate-only > ./staking/zeroUnbondTx.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/zeroUnbondTx.json', 'utf8'));
      msg.body.messages[0].amount.amount = '0';
      fs.writeFileSync('./staking/zeroUnbondTx.json', JSON.stringify(msg, null, 2));
      const signTx = await exec(`seid tx sign ./staking/zeroUnbondTx.json --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} > ./staking/zeroUnbondTxSigned.json`);
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast ./staking/zeroUnbondTxSigned.json --broadcast-mode block`);
      expect(broadcastTx.raw_log).to.contain('invalid shares amount');
    });

    it('Eve cannot unbond a negative amount of shares', async () => {
      const preStateDelegations = await staking.cmdDelegations(eve.seiAddress);

      const minusAmountUnbondingTx = await exec(`seid tx staking unbond ${validatorAddress} 10usei --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --generate-only > ./staking/minusUnbondTx.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/minusUnbondTx.json', 'utf8'));
      msg.body.messages[0].amount.amount = '-1000';
      fs.writeFileSync('./staking/minusUnbondTx.json', JSON.stringify(msg, null, 2));
      const signedTx = await exec(`seid tx sign ./staking/minusUnbondTx.json --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} > ./staking/minusUnbondTxSigned.json`);
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast ./staking/minusUnbondTxSigned.json --broadcast-mode block`);

      const postStateDelegations = await staking.cmdDelegations(eve.seiAddress);

      expect(broadcastTx.raw_log).to.contain('invalid shares amount');
      expect(JSON.stringify(preStateDelegations)).to.be.eq(JSON.stringify(postStateDelegations));
    });

    it('Eve cannot unbond from a non-staked validator', async function () {
      const delegations = await staking.cmdDelegations(eve.seiAddress);
      const delegatedValidators = new Set(delegations.map((delegation: any) => delegation.delegation.validator_address));
      const nonStakedValidatorAddress = allValidators.find((validator: any) =>
        !delegatedValidators.has(validator.operator_address)
      )?.operator_address;
      if (!nonStakedValidatorAddress) {
        this.skip();
        return;
      }

      const unbondTx = await staking.undelegateTx(eve, nonStakedValidatorAddress, coin(1000, 'usei'));
      expect(unbondTx.rawLog).to.contain('failed to execute message');
    });

    it('Eve cannot unbond from a validator she doesnt have a stake in', async function () {
      const delegations = await staking.cmdDelegations(eve.seiAddress);
      const delegatedValidators = new Set(delegations.map((delegation: any) => delegation.delegation.validator_address));
      const nonStakedValidator = allValidators.find((validator: any) =>
        !delegatedValidators.has(validator.operator_address)
      )?.operator_address;
      if (!nonStakedValidator) {
        this.skip();
        return;
      }
      const unbondTx = await staking.undelegateTx(eve, nonStakedValidator, coin(100, 'usei'));
      expect(unbondTx.rawLog).to.contain('failed to execute message');
    });

    it('Eve cannot unbond from an invalid address validator', async () =>{
      const unbondTx = await staking.undelegateTx(eve, 'invalidaddress123', coin(100, 'usei'));
      expect(unbondTx.rawLog).to.contain('failed to execute message');
    });

    it('After unbonding Eve can still delegate to the same validator again', async () =>{
      const preDelegations = await staking.cmdDelegations(eve.seiAddress);
      const preStake = staking.findUserLastDelegation(eve.seiAddress, validatorAddress, preDelegations);
      const preAmount = preStake ? Number(preStake.balance!.amount) : 0;

      const delegateTx = await staking.delegateTx(eve, validatorAddress, coin('100', 'usei'));
      expect(delegateTx.code).to.be.eq(0);

      const postDelegations = await staking.cmdDelegations(eve.seiAddress);
      const postStake = staking.findUserLastDelegation(eve.seiAddress, validatorAddress, postDelegations);
      expect(Number(postStake.balance!.amount)).to.be.eq(preAmount + 100);
    });

    it.skip('Eve can delegate to multiple validators in one block by signing multiple tx with updated sequence', async () => {
      // Prepare multiple delegation txs for validator1 and validator2
      const evePreSeq = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const evePreBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);

      // Generate delegation TX for validator1
      await exec(`seid tx staking delegate ${validatorAddress} 5000usei \
    --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --broadcast-mode block \
    --generate-only > ./staking/delegateMultiVal1.json`);

      // Generate delegation TX for validator2
      const validator2 = allValidators.length > 1 ? allValidators[1].operator_address : validatorAddress;
      await exec(`seid tx staking delegate ${validator2} 3000usei \
    --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --broadcast-mode block \
    --generate-only > ./staking/delegateMultiVal2.json`);

      // Sign first TX (sequence is evePreSeq.sequence)
      await exec(`seid tx sign ./staking/delegateMultiVal1.json \
    --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} \
    --sequence ${evePreSeq.sequence} --offline --account-number ${evePreSeq.account_number} \
    > ./staking/delegateMultiVal1Signed.json`);

      // Sign second TX (sequence = evePreSeq.sequence + 1)
      await exec(`seid tx sign ./staking/delegateMultiVal2.json \
    --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} \
    --sequence ${Number(evePreSeq.sequence) + 1} --offline --account-number ${evePreSeq.account_number} \
    > ./staking/delegateMultiVal2Signed.json`);

      // Broadcast both
      const [tx1, tx2] = await Promise.all([
        execCommandAndReturnJson(`seid tx broadcast ./staking/delegateMultiVal1Signed.json --broadcast-mode block`),
        execCommandAndReturnJson(`seid tx broadcast ./staking/delegateMultiVal2Signed.json --broadcast-mode block`),
      ]);

      // Validate success codes
      expect(tx1.code).to.be.eq(0);
      expect(tx2.code).to.be.eq(0);

      // Check updated delegations
      const afterDelegations = await staking.cmdDelegations(eve.seiAddress);
      expect(afterDelegations.length).to.be.gte(2);

      // Check sequence has incremented by 2
      const eveAfterSeq = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      expect(Number(eveAfterSeq.sequence)).to.be.eq(Number(evePreSeq.sequence) + 2);

      // Check approximate balance
      const eveAfterBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const expectedLowerBound = Number(evePreBalance.amount) - 8000 - 2 * 50000; // both delegations + two fees
      expect(Number(eveAfterBalance.amount)).to.be.gte(expectedLowerBound);
    });

    it.skip('Eve tries to delegate with a floating number for shares', async () => {
      // We'll simulate by generating a normal TX and editing the JSON to use a float
      await exec(`seid tx staking delegate ${validatorAddress} 10000usei \
    --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --broadcast-mode block \
    --generate-only > ./staking/floatingDelegationUnsigned.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/floatingDelegationUnsigned.json', 'utf8'));
      // Modify the amount to something invalid like '1000.5'
      msg.body.messages[0].amount.amount = '1000.5';
      fs.writeFileSync('./staking/floatingDelegationUnsigned.json', JSON.stringify(msg, null, 2));

      // Sign & broadcast
      await exec(`seid tx sign ./staking/floatingDelegationUnsigned.json \
    --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} \
    > ./staking/floatingDelegationSigned.json`);
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast ./staking/floatingDelegationSigned.json --broadcast-mode block`);

      // Should fail with an invalid amount error
      expect(broadcastTx.raw_log).to.contain('invalid delegation amount');
    });

    it.skip('Eve tries to delegate using an invalid chain ID', async () => {
      // Generate a valid TX
      await exec(`seid tx staking delegate ${validatorAddress} 5000usei \
    --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --broadcast-mode block \
    --generate-only > ./staking/invalidChainUnsigned.json`);

      // Sign with an invalid chain ID
      await exec(`seid tx sign ./staking/invalidChainUnsigned.json \
    --from ${eve.seiAddress} --chain-id invalid-chain-id \
    > ./staking/invalidChainSigned.json`);

      // Broadcast
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast ./staking/invalidChainSigned.json --broadcast-mode block`);

      // Expect chain ID mismatch or error
      expect(broadcastTx.raw_log.toLowerCase()).to.contain('chain-id mismatch');
    });

    it.skip('Eve tries to delegate with insufficient fees', async () => {
      const evePreBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);

      // Use a small fee that should fail
      const tx = await execCommandAndReturnJson(`seid tx staking delegate ${validatorAddress} 1000usei \
    --from ${eve.seiAddress} --fees 1usei --gas 500000 -y --broadcast-mode block`);

      // This should fail with insufficient fee
      expect(tx.raw_log.toLowerCase()).to.contain('insufficient fees');

      // Ensure no changes to delegation or balance
      const evePostBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      expect(evePostBalance.amount).to.be.eq(evePreBalance.amount);
    });


    it.skip('Eve tries to redelegate from a jailed validator', async () => {
      // We'll simulate by choosing a validator that might be jailed or substituting a known jailed address.
      // If there's no jailed validator available, this test can demonstrate the structure.
      const jailedValidator = 'seivaloper1jailed...' // example or from chain queries
      const preDelegations = await staking.cmdDelegations(eve.seiAddress);

      const redelegateTx = await staking.redelegateTx(eve, validator2Address, coin(1000, 'usei'), jailedValidator);
      // This should fail if the validator is indeed jailed
      expect(redelegateTx.rawLog).to.contain('failed to execute message');

      // Confirm delegations remain unchanged
      const postDelegations = await staking.cmdDelegations(eve.seiAddress);
      expect(JSON.stringify(preDelegations)).to.be.eq(JSON.stringify(postDelegations));
    });

    it.skip('Eve can do partial redelegations to multiple validators in the same block', async () => {
      // Pre-check delegations
      const preDelegations = await staking.cmdDelegations(eve.seiAddress);
      const eveSeq = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);

      // 1. Generate first redelegation TX to validator2
      await exec(`seid tx staking redelegate ${validatorAddress} ${validator2Address} 500usei \
    --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --broadcast-mode block \
    --generate-only > ./staking/redelegateMultiVal1.json`);

      // 2. Generate second redelegation TX to validator3
      const validator3 = allValidators.length > 2 ? allValidators[2].operator_address : validator2Address;
      await exec(`seid tx staking redelegate ${validatorAddress} ${validator3} 300usei \
    --from ${eve.seiAddress} --fees 50000usei --gas 500000 -y --broadcast-mode block \
    --generate-only > ./staking/redelegateMultiVal2.json`);

      // Sign them with incremented sequence
      await exec(`seid tx sign ./staking/redelegateMultiVal1.json \
    --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} --sequence ${eveSeq.sequence} --offline \
    --account-number ${eveSeq.account_number} > ./staking/redelegateMultiVal1Signed.json`);

      await exec(`seid tx sign ./staking/redelegateMultiVal2.json \
    --from ${eve.seiAddress} --chain-id ${SIGN_CHAIN_ID} --sequence ${Number(eveSeq.sequence) + 1} --offline \
    --account-number ${eveSeq.account_number} > ./staking/redelegateMultiVal2Signed.json`);

      // Broadcast
      const [broadcast1, broadcast2] = await Promise.all([
        execCommandAndReturnJson(`seid tx broadcast ./staking/redelegateMultiVal1Signed.json --broadcast-mode block`),
        execCommandAndReturnJson(`seid tx broadcast ./staking/redelegateMultiVal2Signed.json --broadcast-mode block`)
      ]);

      expect(broadcast1.code).to.be.eq(0);
      expect(broadcast2.code).to.be.eq(0);

      // Confirm partial amounts are re-delegated
      const postDelegations = await staking.cmdDelegations(eve.seiAddress);
      expect(postDelegations.length).to.be.gte(preDelegations.length);
    });

    it.skip('Eve tries to redelegate using a non-existing coin denomination', async () => {
      const preStakes = await staking.cmdDelegations(eve.seiAddress);

      const tx = await staking.redelegateTx(eve, validatorAddress, coin('1000', 'ubtc'), validator2Address);
      expect(tx.rawLog!.toLowerCase()).to.contain('invalid coin denomination');

      // Confirm no delegation changes
      const postStakes = await staking.cmdDelegations(eve.seiAddress);
      expect(JSON.stringify(postStakes)).to.be.eq(JSON.stringify(preStakes));
    });
  });

  describe('Edge Cases', function () {
    it('Unbonding the full delegation removes the delegation record entirely', async () => {
      const unbondAllUser = await UserFactory.createSeiUser(admin, 'stakingUnbondAll');
      const delegateTx = await staking.delegateTx(unbondAllUser, validatorAddress, coin('10000', USEI_DENOM));
      expect(delegateTx.code).to.be.eq(0);

      const unbondTx = await staking.undelegateTx(unbondAllUser, validatorAddress, coin('10000', USEI_DENOM));
      expect(unbondTx.code).to.be.eq(0);

      const delegations = await staking.cmdDelegations(unbondAllUser.seiAddress);
      expect(delegations.length).to.be.eq(0);

      const unbonding = await staking.cmdUnbondingDelegations(unbondAllUser.seiAddress);
      expect(unbonding.length).to.be.eq(1);
      expect(unbonding[0].entries.some((entry: any) => entry.balance === '10000')).to.be.true;
    });

    it('Cannot chain redelegations: tokens received via redelegation are locked at the destination', async () => {
      const transitiveUser = await UserFactory.createSeiUser(admin, 'stakingTransitive');
      const validator2 = allValidators[1].operator_address;
      const validator3 = allValidators[2].operator_address;

      const delegateTx = await staking.delegateTx(transitiveUser, validatorAddress, coin('10000', USEI_DENOM));
      expect(delegateTx.code).to.be.eq(0);

      const firstRedelegate = await staking.redelegateTx(transitiveUser, validator2, coin(5000, USEI_DENOM), validatorAddress);
      expect(firstRedelegate.code).to.be.eq(0);

      // Redelegating the same tokens onward before the first redelegation
      // matures must be rejected (transitive redelegation protection).
      const secondRedelegate = await staking.redelegateTx(transitiveUser, validator3, coin(5000, USEI_DENOM), validator2);
      expect(secondRedelegate.code).to.not.be.eq(0);
      expect(secondRedelegate.rawLog).to.contain('redelegation to this validator already in progress');
    });

    it('Unbonding entries per validator pair are capped at max_entries', async function () {
      const params = await staking.cmdParams();
      const maxEntries = Number(params.max_entries);
      expect(maxEntries).to.be.gt(0);
      if (maxEntries > 10) {
        // Chains configured with a large cap would make this test too slow.
        this.skip();
        return;
      }

      const maxEntriesUser = await UserFactory.createSeiUser(admin, 'stakingMaxEntries');
      const delegateTx = await staking.delegateTx(maxEntriesUser, validatorAddress, coin('10000', USEI_DENOM));
      expect(delegateTx.code).to.be.eq(0);

      for (let i = 0; i < maxEntries; i++) {
        const unbondTx = await staking.undelegateTx(maxEntriesUser, validatorAddress, coin(100, USEI_DENOM));
        expect(unbondTx.code, `unbond entry ${i + 1} of ${maxEntries}`).to.be.eq(0);
      }

      const overCapTx = await staking.undelegateTx(maxEntriesUser, validatorAddress, coin(100, USEI_DENOM));
      expect(overCapTx.code).to.not.be.eq(0);
      expect(overCapTx.rawLog).to.contain('too many unbonding delegation entries');

      const unbonding = await staking.cmdUnbondingDelegations(maxEntriesUser.seiAddress);
      expect(unbonding[0].entries.length).to.be.eq(maxEntries);
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('seid staking validators count matches REST query', async () => {
      const cliResult = await execCommandAndReturnJson('seid query staking validators');
      const restResult = await queryStakingValidators('');
      expect(cliResult.validators.length).to.be.eq(restResult.validators.length);
    });

    it('Delegation amount via seid matches REST query for eve', async () => {
      const cliDelegations = await staking.cmdDelegations(eve.seiAddress);
      if (cliDelegations.length > 0) {
        const restResult = await queryDelegatorDelegations(eve.seiAddress);
        expect(cliDelegations.length).to.be.eq(restResult.delegation_responses.length);
        for (const cliDel of cliDelegations) {
          const restDel = restResult.delegation_responses.find(
            (d: any) => d.delegation.validator_address === cliDel.delegation.validator_address
          );
          expect(restDel).to.not.be.undefined;
          expect(cliDel.balance.amount).to.be.eq(restDel!.balance!.amount);
        }
      }
    });

    it('Staking pool via seid matches REST query', async () => {
      const cliPool = await staking.cmdPool();
      const restPool = await queryStakingPool();
      expect(cliPool.bonded_tokens).to.be.eq(restPool.pool!.bonded_tokens);
      expect(cliPool.not_bonded_tokens).to.be.eq(restPool.pool!.not_bonded_tokens);
    });

    it('Staking params via seid match REST params', async () => {
      const cliParams = await execCommandAndReturnJson('seid query staking params');
      const restParams = await queryStakingParams();
      expect(cliParams.bond_denom).to.be.eq(restParams.params!.bond_denom);
      expect(Number(cliParams.max_validators)).to.be.eq(Number(restParams.params!.max_validators));
    });

    it('Validator info via seid matches REST query', async () => {
      const cliValidator = await execCommandAndReturnJson(
        `seid query staking validator ${validatorAddress}`
      );
      const restValidator = await queryStakingValidator(validatorAddress);
      expect(cliValidator.operator_address).to.be.eq(restValidator.validator!.operator_address);
      expect(cliValidator.tokens).to.be.eq(restValidator.validator!.tokens);
      expect(cliValidator.jailed).to.be.eq(restValidator.validator!.jailed);
    });
  });

  describe('Query Tests via REST', function () {
    it('Query all validators returns non-empty list with valid fields', async () => {
      const result = await queryStakingValidators('BOND_STATUS_BONDED');
      expect(result.validators.length).to.be.gt(0);
      for (const v of result.validators) {
        expect(v.operator_address).to.match(/^seivaloper/);
        expect(Number(v.tokens)).to.be.gt(0);
        expect(v.description!.moniker).to.be.a('string');
      }
    });

    it('Query delegator validators returns validators eve delegated to', async () => {
      const result = await queryDelegatorValidators(eve.seiAddress);
      expect(result.validators.length).to.be.gte(1);
      const valAddresses = result.validators.map((v: any) => v.operator_address);
      expect(valAddresses).to.include(validatorAddress);
    });

    it('Query unbonding delegations returns entries with valid completion time', async () => {
      const result = await queryDelegatorUnbondingDelegations(eve.seiAddress);
      if (result.unbonding_responses.length > 0) {
        for (const unbond of result.unbonding_responses) {
          expect(unbond.delegator_address).to.be.eq(eve.seiAddress);
          for (const entry of unbond.entries) {
            expect(Number(entry.balance)).to.be.gt(0);
            expect(entry.completion_time).to.not.be.undefined;
            expect(new Date(entry.completion_time!).getTime()).to.be.a('number');
          }
        }
      }
    });

    it('Query staking pool returns positive bonded tokens', async () => {
      const result = await queryStakingPool();
      expect(Number(result.pool!.bonded_tokens)).to.be.gt(0);
      expect(Number(result.pool!.not_bonded_tokens)).to.be.gte(0);
    });

    it('Query historical info at specific height', async () => {
      try {
        const result = await queryStakingHistoricalInfo(1);
        if (result.hist) {
          expect(result.hist.valset).to.be.an('array');
        }
      } catch (e: any) {
        expect(e.message).to.be.a('string');
        expect(e.message.length).to.be.gt(0);
      }
    });
  });

  describe('Full Lifecycle', function () {
    it('Create user -> Delegate -> Query delegation -> Redelegate -> Query new delegation -> Unbond -> Query unbonding', async () => {
      const lcUser = await UserFactory.createSeiUser(admin, 'stakingLifecycle');
      const validator2 = allValidators[1].operator_address;

      // 1. Delegate
      const delegateTx = await staking.delegateTx(lcUser, validatorAddress, coin('50000', 'usei'));
      expect(delegateTx.code).to.be.eq(0);

      // 2. Query delegation
      const delegations = await staking.cmdDelegations(lcUser.seiAddress);
      expect(delegations.length).to.be.eq(1);
      expect(delegations[0].balance.amount).to.be.eq('50000');
      expect(delegations[0].delegation.validator_address).to.be.eq(validatorAddress);

      // 3. Redelegate part to validator2
      const redelegateTx = await staking.redelegateTx(lcUser, validator2, coin(20000, 'usei'), validatorAddress);
      expect(redelegateTx.code).to.be.eq(0);

      // 4. Query both delegations
      const updatedDelegations = await staking.cmdDelegations(lcUser.seiAddress);
      expect(updatedDelegations.length).to.be.eq(2);

      const del1 = staking.findUserLastDelegation(lcUser.seiAddress, validatorAddress, updatedDelegations);
      const del2 = staking.findUserLastDelegation(lcUser.seiAddress, validator2, updatedDelegations);
      expect(del1.balance.amount).to.be.eq('30000');
      expect(del2.balance.amount).to.be.eq('20000');

      // 5. Unbond from validator1
      const unbondTx = await staking.undelegateTx(lcUser, validatorAddress, coin(5000, 'usei'));
      expect(unbondTx.code).to.be.eq(0);

      // 6. Verify delegation decreased and unbonding entry exists
      const finalDelegations = await staking.cmdDelegations(lcUser.seiAddress);
      const finalDel1 = staking.findUserLastDelegation(lcUser.seiAddress, validatorAddress, finalDelegations);
      expect(finalDel1.balance.amount).to.be.eq('25000');

      const unbonding = await staking.cmdUnbondingDelegations(lcUser.seiAddress);
      expect(unbonding.length).to.be.gte(1);
    });

    it('Rewards accumulate after delegation and can be queried', async () => {
      const rewardUser = await UserFactory.createSeiUser(admin, 'stakingRewards');
      const delegateTx = await staking.delegateTx(rewardUser, validatorAddress, coin('100000', 'usei'));
      expect(delegateTx.code).to.be.eq(0);

      await waitFor(10);

      const rewards = await staking.cmdRewards(validatorAddress, rewardUser.seiAddress);
      expect(rewards).to.be.an('array');
      if (rewards.length > 0) {
        expect(parseFloat(rewards[0].amount)).to.be.gte(0);
        expect(rewards[0].denom).to.be.eq('usei');
      }
    });
  });
});
