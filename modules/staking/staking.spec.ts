import {coin} from '@cosmjs/proto-signing';
import {execCommandAndReturnJson, waitFor} from '../../whitelist_tests/helpers';
import util from 'node:util';
import {SeiUser} from '../utils/User';
import testConfig from '../testConfig.json';
import {Funder} from '../utils/Funder';
import Staking from './Staking';
import fs from 'fs';
import ExpectStatic = Chai.ExpectStatic;

const exec = util.promisify(require('node:child_process').exec);

let expect: ExpectStatic;
describe('Staking Tests', function () {
  this.timeout(4 * 60 * 1000);
  let alice: SeiUser;
  let funder = new Funder(testConfig.adminAddress);
  let eve: SeiUser;
  let staking: Staking;
  let validatorAddress: string;
  let allValidators: any;

  before('', async () => {
    const chai = await import('chai');
    ({expect} = chai);
    await waitFor(1);
    const val = await execCommandAndReturnJson(`seid query staking validators`);
    allValidators = val.validators;
    validatorAddress = allValidators[0].operator_address;
    alice = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
    eve = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
    await funder.fundAdminOnSei();
    await waitFor(1);
    await alice.initialize('', 'alice', true);
    await eve.initialize('', 'eve', true);
    await funder.fundAddressOnSei(alice.seiAddress);
    await funder.fundAddressOnSei(eve.seiAddress);

    await waitFor(1);
    staking = new Staking();
    await staking.initialize(eve.seiWallet.wallet, testConfig.seiRpcEndpoint, testConfig.restEndpoint);
  });

  describe('Delegation Tests', function () {

    it.only('Eve can delegate tokens to a validator and see her stake on validator delegations', async () => {
      const stakingPool = await staking.cmdPool();
      const validatorPreDelegations = await staking.cmdQueryDelegationsTo(validatorAddress);
      const preBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const tx = await staking.delegateTx(eve, validatorAddress, coin('10', 'usei'));
      expect(tx.code).to.be.eq(0);
      // Validate user balances
      const balance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const expectedBalance = Number(preBalance.amount) - (10 + 24000);
      expect(Number(balance.amount)).to.be.eq(expectedBalance);

      // Validate through queries
      const eveDelegations = await staking.cmdDelegations(eve.seiAddress);
      expect(eveDelegations.length).to.be.eq(1);
      expect(eveDelegations[0].balance!.amount).to.be.eq('10');
      expect(eveDelegations[0].balance!.denom).to.be.eq('usei');
      expect(eveDelegations[0].delegation!.delegator_address).to.be.eq(eve.seiAddress);
      expect(eveDelegations[0].delegation!.validator_address).to.be.eq(validatorAddress);
      expect(eveDelegations[0].delegation!.shares).to.contain('10.000');

      const validatorDelegations = await staking.cmdQueryDelegationsTo(validatorAddress);
      expect(validatorDelegations.length).to.be.eq(validatorPreDelegations.length + 1);
      const lastStake = staking.findUserLastDelegation(eve.seiAddress, validatorAddress, validatorDelegations);
      expect(lastStake.balance!.amount).to.be.eq('10');
      expect(lastStake.delegation!.shares).to.contain('10.000');
      expect(lastStake.delegation!.validator_address).to.be.eq(validatorAddress);

      const afterStakingPool = await staking.cmdPool();
      expect(afterStakingPool.bonded_tokens).to.be.eq((BigInt(stakingPool.bonded_tokens) + BigInt(10)).toString());
    });

    it.only('Eve cant stake usdt into validator', async () => {
      await funder.fundAddressOnSei(eve.seiAddress, 'uusdt');
      const tx = await staking.delegateTx(eve, validatorAddress, coin('100000', 'uusdt'));
      expect(tx.rawLog).to.contain('invalid coin denomination');
    });

    it.only('Eve cant stake 0 into validator', async () => {
      //generate only tx
      const tx = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block --generate-only > ./staking/zeroAmountUnsigned.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/zeroAmountUnsigned.json', 'utf8'));
      msg.body.messages[0].amount.amount = '0';
      fs.writeFileSync('./staking/zeroAmountUnsigned.json', JSON.stringify(msg, null, 2));
      await waitFor(1);
      const signTx = await exec(`seid tx sign ./staking/zeroAmountUnsigned.json --from ${eve.seiAddress} --chain-id sei-chain > ./staking/zeroAmountSigned.json`);
      await waitFor(0.5);
      const broadcastTX = await execCommandAndReturnJson(`seid tx broadcast ./staking/zeroAmountSigned.json --from ${eve.seiAddress} --broadcast-mode block`);
      expect(broadcastTX.raw_log).to.contain('invalid delegation amount');
    });

    it.only('Eve cant stake more than she has', async () => {
      const preBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const stakeAmount = Number(preBalance.amount) + 10;
      const tx = await staking.delegateTx(eve, validatorAddress, coin(stakeAmount.toString(), 'usei'));
      expect(tx.rawLog).to.contain('insufficient funds');
    });

    it.only('Eve cant stake minus coins', async () => {
      const tx = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block --generate-only > ./staking/minusAmountUnsigned.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/minusAmountUnsigned.json', 'utf8'));
      msg.body.messages[0].amount.amount = '-10000';
      fs.writeFileSync('./staking/minusAmountUnsigned.json', JSON.stringify(msg, null, 2));


      await waitFor(1);
      const signTx = await exec(`seid tx sign ./staking/minusAmountUnsigned.json --from ${eve.seiAddress} --chain-id sei-chain > ./staking/minusAmountSigned.json`);
      await waitFor(0.5);
      const broadcastTX = await execCommandAndReturnJson(`seid tx broadcast ./staking/minusAmountSigned.json --from ${eve.seiAddress} --broadcast-mode block`);
      expect(broadcastTX.raw_log).to.contain('invalid delegation amount');
    });

    it.only('Eve cant stake to empty addresses', async () => {
      const tx = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block --generate-only > ./staking/emptyAccountUnsigned.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/emptyAccountUnsigned.json', 'utf8'));
      msg.body.messages[0].amount.amount = '-10000';
      fs.writeFileSync('./staking/emptyAccountUnsigned.json', JSON.stringify(msg, null, 2));


      await waitFor(1);
      const signTx = await exec(`seid tx sign ./staking/emptyAccountUnsigned.json --from ${eve.seiAddress} --chain-id sei-chain > ./staking/emptyAccountSigned.json`);
      await waitFor(0.5);
      const broadcastTX = await execCommandAndReturnJson(`seid tx broadcast ./staking/emptyAccountSigned.json --from ${eve.seiAddress} --broadcast-mode block`);
      expect(broadcastTX.raw_log).to.contain('invalid delegation amount');
    });

    it.only('Eve cant stake invalid addresses', async () => {
      const tx = await staking.delegateTx(eve, 'invalid', coin('10', 'usei'));
      expect(tx.rawLog).to.contain('invalid bech32 string length');
    });

    it.only('Eve cant stake to unexisting validator address', async () => {
      const unexistingValidatorAddress = 'seivaloper1ykls6dhh2mjqk9x0d3ee29873stf7wwvedcjmh';
      const tx = await staking.delegateTx(eve, unexistingValidatorAddress, coin('10', 'usei'));
      expect(tx.rawLog).to.contain('validator does not exist');
    });

    it.only('Unassociated Ferdie can stake to a validator on cosmos runtime', async () => {
      const ferdie = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
      await ferdie.initialize('', 'ferdie', false);
      await funder.fundAddressOnSei(ferdie.seiAddress);
      const tx = await staking.delegateTx(ferdie, validatorAddress, coin('1', 'usei'));
      const ferdieDelegation = await staking.cmdDelegations(ferdie.seiAddress);
      expect(ferdieDelegation.length).to.be.eq(1);
      expect(ferdieDelegation[0].balance!.amount).to.be.eq('1');
      expect(ferdieDelegation[0].balance!.denom).to.be.eq('usei');
      expect(ferdieDelegation[0].delegation!.delegator_address).to.be.eq(ferdie.seiAddress);
      expect(ferdieDelegation[0].delegation!.validator_address).to.be.eq(validatorAddress);
      expect(ferdieDelegation[0].delegation!.shares).to.contain('1.000');
    });

    it.only('Eve can query rewards for her stake', async () => {
      const rewards = await staking.cmdRewards(validatorAddress, eve.seiAddress);
      expect(rewards.length).to.be.eq(1);
      expect(parseFloat(rewards[0].amount)).to.be.gt(0);
    });

    it.only('Eve can stake and increase her position to the same validator', async () => {
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

    it.only('Eve tries to send multiple delegations to the same validator in the same block without updating the sequence', async () => {
      const evePreBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const eveSequencePre = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const preDelegations = await staking.cmdDelegations(eve.seiAddress);
      const firstDelegationTx = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block --generate-only > ./staking/firstValidTx.json`);
      const secondDelegationTx = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block --generate-only > ./staking/secondValidTx.json`);
      const signTx = await exec(`seid tx sign ./staking/firstValidTx.json --from ${eve.seiAddress} --chain-id sei > ./staking/firstValidTxSigned.json`);
      await waitFor(1);
      const sign2Tx = await exec(`seid tx sign ./staking/secondValidTx.json --from ${eve.seiAddress} --chain-id sei > ./staking/secondValidTxSigned.json`);
      await waitFor(1);
      const results = await Promise.all([
        execCommandAndReturnJson(`seid tx broadcast ./staking/firstValidTxSigned.json --broadcast-mode block`),
        execCommandAndReturnJson(`seid tx broadcast ./staking/secondValidTxSigned.json --broadcast-mode block`),
      ]);
      const eveAfterBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const eveSequenceAfter = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const delegations = await staking.cmdDelegations(eve.seiAddress);
      expect(delegations.length).to.be.eq(preDelegations.length);
      expect(parseFloat(delegations[0].delegation.shares)).to.be.eq(parseFloat(preDelegations[0].delegation.shares) + 10000);

      //validate sequence not increased twice
      expect(Number(eveSequencePre.sequence)).to.be.eq(Number(eveSequenceAfter.sequence) - 1);

      //validate that eve balance only decreased for one tx and two gas fees
      expect(Number(eveAfterBalance.amount)).to.be.eq(Number(evePreBalance.amount) - 10000 - 24200);
    });

    it.only('Eve tries to send multiple delegations to the same validator in the same block with updating the sequence', async () => {
      const preDelegations = await staking.cmdDelegations(eve.seiAddress);
      const evePreBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const evePreSequence = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const firstDelegationTx = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block --generate-only > ./staking/firstValidTx.json`);
      const secondDelegationTx = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block --generate-only > ./staking/secondValidTx.json`)
      const sign1Tx = await exec(`seid tx sign ./staking/firstValidTx.json --from ${eve.seiAddress} --chain-id sei > ./staking/firstValidTxSigned.json`);
      const sign2Tx = await exec(`seid tx sign ./staking/secondValidTx.json --from ${eve.seiAddress} --chain-id sei --sequence ${Number(evePreSequence.sequence) + 1} --offline --account-number ${evePreSequence.account_number} > ./staking/secondValidTxSigned.json`);

      const broadcast1 = exec(`seid tx broadcast ./staking/firstValidTxSigned.json --output json`);
      await waitFor(0.05);
      const broadcast2 = exec(`seid tx broadcast ./staking/secondValidTxSigned.json --output json`);
      const results = await Promise.all([broadcast1, broadcast2]);

      expect(JSON.parse(results[0].stdout).code).to.be.eq(0);
      expect(JSON.parse(results[1].stdout).code).to.be.eq(0);
      await waitFor(1);
      console.log(JSON.parse(results[0].stdout));
      console.log(JSON.parse(results[1].stdout));
      const afterDelegations = await staking.cmdDelegations(eve.seiAddress);
      expect(preDelegations.length).to.be.eq(afterDelegations.length);
      const eveAfterBalance = await execCommandAndReturnJson(`seid q bank balances ${eve.seiAddress} --denom usei`);
      const eveSequenceAfter = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      console.log(eveAfterBalance);
      console.log(evePreBalance);
      console.log(evePreSequence);
      console.log(eveSequenceAfter);

      //Validate shares
      expect(parseFloat(afterDelegations[0].delegation.shares)).to.be.eq(parseFloat(preDelegations[0].delegation.shares) + 20000);

      const balanceLowLimit = Number(evePreBalance.amount) - 20000 - 48400;
      const balanceHighLimit = Number(evePreBalance.amount) - 20000 - 48400 + 20;
      //Balance checks
      expect(Number(eveAfterBalance.amount)).to.be.within(balanceLowLimit, balanceHighLimit);

      //Sequence checks
      expect(Number(eveSequenceAfter.sequence)).to.be.eq(Number(evePreSequence.sequence) + 2);
    });

    it.only('Eve can initiate a failing tx with a low gas limit and send a regular tx', async () =>{
      const evePreBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const evePreDelegations = await staking.cmdDelegations(eve.seiAddress);
      const evePreSequence = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);

      const tx1 = await exec(`seid tx staking delegate ${validatorAddress} 50000usei --from ${eve.seiAddress} --fees 24200usei --gas 1000 -y --broadcast-mode block --generate-only > ./staking/lowGasLimitTx.json`);
      const tx2 = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block --generate-only > ./staking/regularTx.json`);
      const signTx1 = await exec(`seid tx sign ./staking/lowGasLimitTx.json --from ${eve.seiAddress} --chain-id sei > ./staking/lowGasLimitTxSigned.json`);
      const signTx2 = await exec(`seid tx sign ./staking/regularTx.json --from ${eve.seiAddress} --chain-id sei > ./staking/regularTxSigned.json`);
      await waitFor(1);
      const results = await Promise.all([
        exec(`seid tx broadcast ./staking/lowGasLimitTxSigned.json --broadcast-mode block`),
        exec(`seid tx broadcast ./staking/regularTxSigned.json --broadcast-mode block`)
      ]);
      await waitFor(1);
      const eveAfterBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const eveAfterDelegations = await staking.cmdDelegations(eve.seiAddress);
      const eveSequenceAfter = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const balanceLowLimit = Number(evePreBalance.amount) - 10000 - 24200;
      const balanceHighLimit = Number(evePreBalance.amount) - 10000 - 24200 + 60;
      //Validations
      expect(Number(eveAfterBalance.amount)).to.be.within(balanceLowLimit, balanceHighLimit);
      expect(eveAfterDelegations.length).to.be.eq(evePreDelegations.length);
      expect(Number(eveSequenceAfter.sequence)).to.be.eq(Number(evePreSequence.sequence) + 1);

      expect(parseFloat(eveAfterDelegations[0].delegation.shares)).to.be.eq(parseFloat(evePreDelegations[0].delegation.shares) + 10000);
    });

  });

  describe('Redelegation Tests', function () {
    let allStakes: any[];
    let validator2Address: string;

    it.only('Eve can redelegate one of her existing stakes into another validator', async () => {
      allStakes = await staking.cmdDelegations(eve.seiAddress);
      const evePreBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, allStakes);
      validator2Address = allValidators[1].operator_address;
      const redelegateTx = await staking.redelegateTx(eve, validator2Address, coin(5000, "usei"), validatorAddress);
      expect(redelegateTx.code).to.be.eq(0);

      const eveAfterBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);
      const balanceLowLimit = Number(evePreBalance.amount) - 1000 - 24200;
      const balanceHighLimit = Number(evePreBalance.amount) - 1000 - 24200 + 2000;
      expect(Number(eveAfterBalance.amount)).to.be.within(balanceLowLimit, balanceHighLimit);

      allStakes = await staking.cmdDelegations(eve.seiAddress);
      const eveLastStake = await staking.findUserLastDelegation(eve.seiAddress, validator2Address, allStakes);
      expect(eveLastStake.balance!.amount).to.be.eq('5000');
      expect(eveLastStake.delegation!.shares).to.contain('5000.000');
      expect(eveLastStake.delegation!.validator_address).to.be.eq(validator2Address);
    });

    it.only('Eve cant redelegate more than her balance to another validator', async () => {
      allStakes = await staking.cmdDelegations(eve.seiAddress);
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, allStakes);
      const moreThanBalance = Number(eveStake.balance!.amount) + 1000;

      const redelegateTx = await staking.redelegateTx(eve, validator2Address, coin(moreThanBalance, 'usei'), validatorAddress);
      expect(redelegateTx.rawLog).to.contain('failed to execute message');
    });

    it.only('Eve cant redelegate to an unexisting validator', async () => {
      const unexistingValidatorAddress = 'seivaloper1xyzinvalidaddress000000';
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, allStakes);

      const redelegateTx = await staking.redelegateTx(eve, unexistingValidatorAddress, coin(1000, 'usei'), validatorAddress);
      expect(redelegateTx.rawLog).to.contain('failed to execute message');
    });

    it.only('Eve cant redelegate to invalid validator address', async () => {
      const invalidValidatorAddress = 'invalidaddress123';
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, allStakes);

      const redelegateTx = await staking.redelegateTx(eve, invalidValidatorAddress, coin(1000, 'usei'), validatorAddress);
      expect(redelegateTx.rawLog).to.contain('failed to execute message');
    });

    it.only('Eve cant redelegate to her own validator', async () => {

      const redelegateTx = await staking.redelegateTx(eve, validatorAddress, coin(100, 'usei'), validatorAddress);
      expect(redelegateTx.rawLog).to.contain('failed to execute message');
    });

    it.only('Eve can redelegate to the same validator twice', async () => {
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validator2Address, allStakes);

      const firstRedelegateTx = await staking.redelegateTx(eve, validator2Address, coin(500, 'usei'), validatorAddress);
      expect(firstRedelegateTx.code).to.be.eq(0);

      const secondRedelegateTx = await staking.redelegateTx(eve, validator2Address, coin(300, 'usei'), validatorAddress);
      expect(secondRedelegateTx.code).to.be.eq(0);

      const updatedStakes = await staking.cmdDelegations(eve.seiAddress);
      const foundStake = await staking.findUserLastDelegation(eve.seiAddress, validator2Address, updatedStakes);

      expect(foundStake.balance!.amount).to.be.eq('1800');
    });

    it.only('Eve cant redelegate from a validator she doesnt have a stake in', async () => {
      const nonStakedValidatorAddress = allValidators[2].operator_address;

      const redelegateTx = await staking.redelegateTx(eve, validator2Address, coin(1000, 'usei'), nonStakedValidatorAddress);
      expect(redelegateTx.rawLog).to.contain('failed to execute message');
    });

    it('Eve can delegate and redelegate in the same block', async () => {
      const eveSequence = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const evePreDelegation = await staking.cmdDelegation(eve.seiAddress, validatorAddress);
      const delegateTx = await exec(`seid tx staking delegate ${validatorAddress} 10000usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --generate-only > ./staking/firstValidTx.json`);
      const signTx = await exec(`seid tx sign ./staking/firstValidTx.json --from ${eve.seiAddress} --chain-id sei > ./staking/firstValidTxSigned.json`);
      const redelegateTxJson = await exec(`seid tx staking redelegate ${validatorAddress} ${validator2Address} 1000usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --generate-only > ./staking/firstValidRedelegateTx.json`)
      const sign2Tx = await exec(`seid tx sign ./staking/firstValidRedelegateTx.json --from ${eve.seiAddress} --chain-id sei --sequence ${Number(eveSequence.sequence) + 1} --offline --account-number ${eveSequence.account_number} > ./staking/firstValidRedelegateTxSigned.json`);
      const results = await Promise.all([
        execCommandAndReturnJson(`seid tx broadcast ./staking/firstValidTxSigned.json --broadcast-mode block`),
        execCommandAndReturnJson(`seid tx broadcast ./staking/firstValidRedelegateTxSigned.json --broadcast-mode block`),
      ]);

      const eveSequenceAfter = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const eveAfterDelegation = await staking.cmdDelegation(eve.seiAddress, validatorAddress);

      //Now should reduce 1000 sei to redelegation and 10000 new delegation
      expect(parseFloat(eveAfterDelegation.delegation.shares)).to.be.eq(parseFloat(evePreDelegation.delegation.shares) + 9000);


      const updatedStakes = await staking.cmdDelegations(eve.seiAddress);
      const foundStake = await staking.findUserLastDelegation(eve.seiAddress, validator2Address, updatedStakes);
      expect(foundStake.balance!.amount).to.be.eq('2800');

      //Validate sequence
      expect(Number(eveSequenceAfter.sequence)).to.be.eq(Number(eveSequence.sequence) + 2);
    });

    it.only('Eve can redelegate max amount of shares to a different validator', async () => {
      const evePreStakes = await staking.cmdDelegation(eve.seiAddress, validator2Address);
      allStakes = await staking.cmdDelegations(eve.seiAddress);
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, allStakes);
      const redelegateTx = await staking.redelegateTx(eve, validator2Address, coin(Number(eveStake.balance!.amount), 'usei'), validatorAddress);
      expect(redelegateTx.code).to.be.eq(0);

      const updatedStakes = await staking.cmdDelegations(eve.seiAddress);
      const foundStake = await staking.findUserLastDelegation(eve.seiAddress, validator2Address, updatedStakes);

      expect(parseFloat(foundStake.delegation!.shares)).to.be.eq(parseFloat(eveStake.delegation!.shares) + parseFloat(evePreStakes.delegation!.shares));
    });

    it.only('Eve cant redelegate zero amount of shares', async () => {
      const zeroAmountRedelegation = await exec(`seid tx staking redelegate ${validatorAddress} ${validator2Address} 10usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --generate-only > ./staking/zeroAmountRedelegateTx.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/zeroAmountRedelegateTx.json', 'utf8'));
      msg.body.messages[0].amount.amount = '0';
      fs.writeFileSync('./staking/zeroAmountRedelegateTx.json', JSON.stringify(msg, null, 2));
      const signTx = await exec(`seid tx sign ./staking/zeroAmountRedelegateTx.json --from ${eve.seiAddress} --chain-id sei > ./staking/zeroAmountRedelegateTxSigned.json`);
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast ./staking/zeroAmountRedelegateTxSigned.json --broadcast-mode block`);
      console.log(broadcastTx);
    });

    it.only('Eve cant redelegate minus amounts into another validator', async () => {
      await staking.delegateTx(eve, validatorAddress, coin(10000, 'usei'));
      const preStateValidator1 = await staking.cmdDelegation(eve.seiAddress, validatorAddress);
      const preStateValidator2 = await staking.cmdDelegation(eve.seiAddress, validator2Address);
      const minusAmountRedelegation = await exec(`seid tx staking redelegate ${validatorAddress} ${validator2Address} 10usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --generate-only > ./staking/minusAmountRedelegateTx.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/minusAmountRedelegateTx.json', 'utf8'));
      msg.body.messages[0].amount.amount = '-1000';
      fs.writeFileSync('./staking/minusAmountRedelegateTx.json', JSON.stringify(msg, null, 2));
      const signedTx = await exec(`seid tx sign ./staking/minusAmountRedelegateTx.json --from ${eve.seiAddress} --chain-id sei > ./staking/minusAmountRedelegateTxSigned.json`);
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast ./staking/minusAmountRedelegateTxSigned.json --broadcast-mode block`);
      console.log(broadcastTx);

      const afterStateValidator1 = await staking.cmdDelegation(eve.seiAddress, validatorAddress);
      const afterStateValidator2 = await staking.cmdDelegation(eve.seiAddress, validator2Address);

      expect(JSON.stringify(afterStateValidator1)).to.be.eq(JSON.stringify(preStateValidator1));
      expect(JSON.stringify(afterStateValidator2)).to.be.eq(JSON.stringify(preStateValidator2));
    });
  });

  describe('Unbonding Tests', function () {
    let validator2Address: string;

    it.only('Eve can unbond a valid amount of shares', async () => {
      validator2Address = allValidators[1].operator_address;
      const evePreDelegations = await staking.cmdDelegations(eve.seiAddress);
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, evePreDelegations);

      const unbondTx = await staking.undelegateTx(eve, validatorAddress, coin(1000, 'usei'));
      expect(unbondTx.code).to.be.eq(0);

      const evePostDelegations = await staking.cmdDelegations(eve.seiAddress);
      const postStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, evePostDelegations);

      // Validate reduced shares
      expect(parseFloat(postStake.delegation!.shares)).to.be.eq(parseFloat(eveStake.delegation!.shares) - 1000);

      const unbondDelegations = await staking.cmdUnbondingDelegations(eve.seiAddress);
      console.log(unbondDelegations);
      const unbondStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, unbondDelegations);
      expect(unbondStake.balance!.amount).to.be.eq('1000');
    });

    it.only('Eve cannot unbond more shares than she holds', async () => {
      const eveDelegations = await staking.cmdDelegations(eve.seiAddress);
      const eveStake = await staking.findUserLastDelegation(eve.seiAddress, validatorAddress, eveDelegations);
      const overBalance = Number(eveStake.delegation!.shares) + 1000;

      const unbondTx = await staking.undelegateTx(eve, validatorAddress, coin(overBalance, 'usei'));
      expect(unbondTx.rawLog).to.contain('failed to execute message');
    });

    it.only('Eve cannot unbond zero shares', async () => {
      const zeroAmountUnbondingTx = await exec(`seid tx staking unbond ${validatorAddress} 10usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --generate-only > ./staking/zeroUnbondTx.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/zeroUnbondTx.json', 'utf8'));
      msg.body.messages[0].amount.amount = '0';
      fs.writeFileSync('./staking/zeroUnbondTx.json', JSON.stringify(msg, null, 2));
      const signTx = await exec(`seid tx sign ./staking/zeroUnbondTx.json --from ${eve.seiAddress} --chain-id sei > ./staking/zeroUnbondTxSigned.json`);
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast ./staking/zeroUnbondTxSigned.json --broadcast-mode block`);
      expect(broadcastTx.raw_log).to.contain('invalid shares amount');
    });

    it.only('Eve cannot unbond a negative amount of shares', async () => {
      const preStateDelegations = await staking.cmdDelegations(eve.seiAddress);

      const minusAmountUnbondingTx = await exec(`seid tx staking unbond ${validatorAddress} 10usei --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --generate-only > ./staking/minusUnbondTx.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/minusUnbondTx.json', 'utf8'));
      msg.body.messages[0].amount.amount = '-1000';
      fs.writeFileSync('./staking/minusUnbondTx.json', JSON.stringify(msg, null, 2));
      const signedTx = await exec(`seid tx sign ./staking/minusUnbondTx.json --from ${eve.seiAddress} --chain-id sei > ./staking/minusUnbondTxSigned.json`);
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast ./staking/minusUnbondTxSigned.json --broadcast-mode block`);

      const postStateDelegations = await staking.cmdDelegations(eve.seiAddress);

      expect(broadcastTx.raw_log).to.contain('invalid shares amount');
      expect(JSON.stringify(preStateDelegations)).to.be.eq(JSON.stringify(postStateDelegations));
    });

    it.only('Eve cannot unbond from a non-staked validator', async () => {
      const nonStakedValidatorAddress = allValidators[2].operator_address;

      const unbondTx = await staking.undelegateTx(eve, nonStakedValidatorAddress, coin(1000, 'usei'));
      expect(unbondTx.rawLog).to.contain('failed to execute message');
    });

    it.only('Eve cannot unbond from a validator she doesnt have a stake in', async () => {

    });

    it.only('Eve cannot unbond from an invalid address validator', async () =>{

    });

    it.only('Eve by sending multiple txs in a single block cant unbond more than she has ', async () => {

    });

    it.only('After unbond eve cant stake into validator again', async () =>{

    });

    it.skip('Eve can delegate to multiple validators in one block by signing multiple tx with updated sequence', async () => {
      // Prepare multiple delegation txs for validator1 and validator2
      const evePreSeq = await execCommandAndReturnJson(`seid query account ${eve.seiAddress} --output json`);
      const evePreBalance = await execCommandAndReturnJson(`seid query bank balances ${eve.seiAddress} --denom usei`);

      // Generate delegation TX for validator1
      await exec(`seid tx staking delegate ${validatorAddress} 5000usei \
    --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block \
    --generate-only > ./staking/delegateMultiVal1.json`);

      // Generate delegation TX for validator2
      const validator2 = allValidators.length > 1 ? allValidators[1].operator_address : validatorAddress;
      await exec(`seid tx staking delegate ${validator2} 3000usei \
    --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block \
    --generate-only > ./staking/delegateMultiVal2.json`);

      // Sign first TX (sequence is evePreSeq.sequence)
      await exec(`seid tx sign ./staking/delegateMultiVal1.json \
    --from ${eve.seiAddress} --chain-id sei \
    --sequence ${evePreSeq.sequence} --offline --account-number ${evePreSeq.account_number} \
    > ./staking/delegateMultiVal1Signed.json`);

      // Sign second TX (sequence = evePreSeq.sequence + 1)
      await exec(`seid tx sign ./staking/delegateMultiVal2.json \
    --from ${eve.seiAddress} --chain-id sei \
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
      const expectedLowerBound = Number(evePreBalance.amount) - 8000 - 2 * 24200; // both delegations + two fees
      expect(Number(eveAfterBalance.amount)).to.be.gte(expectedLowerBound);
    });

    it.skip('Eve tries to delegate with a floating number for shares', async () => {
      // We'll simulate by generating a normal TX and editing the JSON to use a float
      await exec(`seid tx staking delegate ${validatorAddress} 10000usei \
    --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block \
    --generate-only > ./staking/floatingDelegationUnsigned.json`);
      const msg = JSON.parse(fs.readFileSync('./staking/floatingDelegationUnsigned.json', 'utf8'));
      // Modify the amount to something invalid like '1000.5'
      msg.body.messages[0].amount.amount = '1000.5';
      fs.writeFileSync('./staking/floatingDelegationUnsigned.json', JSON.stringify(msg, null, 2));

      // Sign & broadcast
      await exec(`seid tx sign ./staking/floatingDelegationUnsigned.json \
    --from ${eve.seiAddress} --chain-id sei \
    > ./staking/floatingDelegationSigned.json`);
      const broadcastTx = await execCommandAndReturnJson(`seid tx broadcast ./staking/floatingDelegationSigned.json --broadcast-mode block`);

      // Should fail with an invalid amount error
      expect(broadcastTx.raw_log).to.contain('invalid delegation amount');
    });

    it.skip('Eve tries to delegate using an invalid chain ID', async () => {
      // Generate a valid TX
      await exec(`seid tx staking delegate ${validatorAddress} 5000usei \
    --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block \
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
    --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block \
    --generate-only > ./staking/redelegateMultiVal1.json`);

      // 2. Generate second redelegation TX to validator3
      const validator3 = allValidators.length > 2 ? allValidators[2].operator_address : validator2Address;
      await exec(`seid tx staking redelegate ${validatorAddress} ${validator3} 300usei \
    --from ${eve.seiAddress} --fees 24200usei --gas 500000 -y --broadcast-mode block \
    --generate-only > ./staking/redelegateMultiVal2.json`);

      // Sign them with incremented sequence
      await exec(`seid tx sign ./staking/redelegateMultiVal1.json \
    --from ${eve.seiAddress} --chain-id sei --sequence ${eveSeq.sequence} --offline \
    --account-number ${eveSeq.account_number} > ./staking/redelegateMultiVal1Signed.json`);

      await exec(`seid tx sign ./staking/redelegateMultiVal2.json \
    --from ${eve.seiAddress} --chain-id sei --sequence ${Number(eveSeq.sequence) + 1} --offline \
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
      expect(tx.rawLog.toLowerCase()).to.contain('invalid coin denomination');

      // Confirm no delegation changes
      const postStakes = await staking.cmdDelegations(eve.seiAddress);
      expect(JSON.stringify(postStakes)).to.be.eq(JSON.stringify(preStakes));
    });
  });
});
