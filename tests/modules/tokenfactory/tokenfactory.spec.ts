import {SeiUser, UserFactory} from '../../../shared/User';
import {
  deployPointer,
  execCommandAndReturnJson,
  generateTokenMetadata,
  generateValidAddressWithoutFunds,
  getAddress,
  getQueryClient,
  queryBankBalance,
  queryPointerAddress,
  rpcEndpoint,
  waitFor
} from './helpers';
import {SigningStargateClient} from '@cosmjs/stargate';
import {
  bankTransfer,
  burnTokens,
  createNewDenom,
  fee,
  mintTokens,
  setAdmin,
  updateDenomMessage,
  Wallets
} from './types';
import {queryAllowlist} from './grpc';
import {Coin, seiprotocol} from '@sei-js/proto';
import {createProvider, createWalletWithMnemonic, queryEvmBalance, querySupplyOnEvm, sendERC20} from './evmUtils';
import {ethers} from 'ethers';


describe('Token factory extension tests', function () {
  this.timeout(5 * 60 * 1000);
  let expect: Chai.ExpectStatic;
  let admin: SeiUser;
  const CLI_FEE = '24200usei';
  const CLI_MINT_AMOUNT = 1000000;
  const CLI_BURN_AMOUNT = 100;

  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
    admin = await UserFactory.createAdminUser();
  });

  describe('seid CLI Tests', function () {
    let cliCreator: SeiUser;
    let cliNewAdmin: SeiUser;
    const cliSubdenom = 'cliTestDenom';
    let cliFullDenom: string;

    before(async () => {
      cliCreator = await UserFactory.createSeiUser(admin, 'tfCliCreator');
      cliNewAdmin = await UserFactory.createSeiUser(admin, 'tfCliNewAdmin');
      cliFullDenom = `factory/${cliCreator.seiAddress}/${cliSubdenom}`;
    });

    it('Create denom via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx tokenfactory create-denom ${cliSubdenom} --from tfCliCreator --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.equal(0);
    });

    it('Mint tokens via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx tokenfactory mint ${CLI_MINT_AMOUNT}${cliFullDenom} --from tfCliCreator --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.equal(0);
    });

    it('Burn tokens via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx tokenfactory burn ${CLI_BURN_AMOUNT}${cliFullDenom} --from tfCliCreator --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.equal(0);
    });

    it('Query denoms from creator via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q tokenfactory denoms-from-creator ${cliCreator.seiAddress}`
      );
      expect(result.denoms).to.contain(cliFullDenom);
    });

    it('Query denom authority metadata via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q tokenfactory denom-authority-metadata ${cliFullDenom}`
      );
      expect(result.authority_metadata.admin).to.equal(cliCreator.seiAddress);
    });

    it('Set metadata via seid CLI', async () => {
      const metadataFile = generateTokenMetadata(cliFullDenom);
      const result = await execCommandAndReturnJson(
        `seid tx tokenfactory set-denom-metadata ${metadataFile} --from tfCliCreator --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.equal(0);
    });

    it('Change admin via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx tokenfactory change-admin ${cliFullDenom} ${cliNewAdmin.seiAddress} --from tfCliCreator --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.equal(0);

      const metadata = await execCommandAndReturnJson(
        `seid q tokenfactory denom-authority-metadata ${cliFullDenom}`
      );
      expect(metadata.authority_metadata.admin).to.equal(cliNewAdmin.seiAddress);
    });
  });

  describe('CosmJS Tests', function () {

    describe('Token creation tests with setting allowlist', function () {
      const denomAllowed = 'createdWithAllowList';
      let fullDenom: string;
      let wallets: Wallets;
      let creatorAddress: string;

      before(async () => {
        const creator = await UserFactory.createSeiUser(admin, 'tfAlCreator');
        const whitelisted = await UserFactory.createSeiUser(admin, 'tfAlWhitelisted');
        const unwhitelisted = await UserFactory.createSeiUser(admin, 'tfAlUnwhitelisted');
        const tobeWhitelisted = await UserFactory.createSeiUser(admin, 'tfAlTobeWhitelisted');
        const newAdmin = await UserFactory.createSeiUser(admin, 'tfAlNewAdmin');
        const toBeRemoved = await UserFactory.createSeiUser(admin, 'tfAlToBeRemoved');
        wallets = {
          creatorWallet: creator.seiWallet.wallet,
          whitelistedWallet: whitelisted.seiWallet.wallet,
          unwhitelistedWallet: unwhitelisted.seiWallet.wallet,
          tobeWhitelistedWallet: tobeWhitelisted.seiWallet.wallet,
          newAdminWallet: newAdmin.seiWallet.wallet,
          toBeRemovedUser: toBeRemoved.seiWallet.wallet,
        };
        creatorAddress = await getAddress(wallets.creatorWallet);
        fullDenom = `factory/${creatorAddress}/${denomAllowed}`;
        await waitFor(1);
      });

      it('Alice can create token with allow list', async () => {
        const whitelistedAddress = await getAddress(wallets.whitelistedWallet);
        const toBeRemovedAddress = await getAddress(wallets.toBeRemovedUser);
        await createNewDenom(creatorAddress, denomAllowed, wallets.creatorWallet, [whitelistedAddress, creatorAddress, toBeRemovedAddress]);
        const seiq = await getQueryClient();
        const denom = await seiq.seiprotocol.seichain.tokenfactory.denomsFromCreator({creator: creatorAddress});

        expect(denom.denoms).to.contain(fullDenom);

        const allowList = await queryAllowlist(fullDenom);
        expect(allowList.allow_list.addresses).to.have.length(3);
        expect(allowList.allow_list.addresses).to.contain(whitelistedAddress);
        expect(allowList.allow_list.addresses).to.contain(creatorAddress);
      });

      it('If created with allowlist, Alice can mint new tokens', async () => {
        await mintTokens(fullDenom, wallets.creatorWallet);
        const userBalance = await queryBankBalance(wallets.creatorWallet, fullDenom);
        expect(userBalance?.toString()).to.be.eq('10000000');
      });

      it('If created with allowlist, Eve cant mint tokens to addresses', async () => {
        const preBalance = await queryBankBalance(wallets.unwhitelistedWallet, fullDenom);
        const mintTx = await mintTokens(fullDenom, wallets.unwhitelistedWallet);
        const afterBalance = await queryBankBalance(wallets.unwhitelistedWallet, fullDenom);
        expect(mintTx.rawLog).to.contain('failed to execute message; message index: 0: unauthorized account');
        expect(preBalance.toString()).to.be.eq(afterBalance?.toString());
      });


      it('Alice can fund whitelisted address', async () => {
        const seiq = await getQueryClient();
        const totalSupply = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});

        const whitelistedAddress = await getAddress(wallets.whitelistedWallet);
        const preBalance = await queryBankBalance(wallets.whitelistedWallet, fullDenom);
        await bankTransfer(wallets.creatorWallet, fullDenom, 1000000, whitelistedAddress);
        const afterBalance = await queryBankBalance(wallets.whitelistedWallet, fullDenom);

        expect(Number(afterBalance)).to.be.eq(Number(preBalance) + 1000000);
        expect(afterBalance).to.be.eq('1000000');

        const totalSupplyAfter = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});
        expect(Number(totalSupply.amount?.amount)).to.be.eq(Number(totalSupplyAfter.amount?.amount));
      });

      it('Alice can fund whitelisted address -2', async () => {
        const toBeRemovedAddress = await getAddress(wallets.toBeRemovedUser);
        const preBalance = await queryBankBalance(wallets.toBeRemovedUser, fullDenom);
        await bankTransfer(wallets.creatorWallet, fullDenom, 1000000, toBeRemovedAddress);
        const afterBalance = await queryBankBalance(wallets.toBeRemovedUser, fullDenom);

        expect(Number(afterBalance)).to.be.eq(Number(preBalance) + 1000000);
        expect(afterBalance).to.be.eq('1000000');
      });

      it('Alice cant send tokens to unwhitelisted Eve', async () => {
        const unwhitelistedAddress = await getAddress(wallets.unwhitelistedWallet);
        const prevBalance = await queryBankBalance(wallets.unwhitelistedWallet, fullDenom);
        const transferCall = await bankTransfer(wallets.creatorWallet, fullDenom, 1000, unwhitelistedAddress);

        expect(transferCall.rawLog).to.contain('is not allowed to receive funds: unauthorized');
        const afterBalance = await queryBankBalance(wallets.unwhitelistedWallet, fullDenom);
        expect(prevBalance).to.be.eq(afterBalance);
      });

      it('Alice can burn tokens and total issuance changes', async () => {
        const seiq = await getQueryClient();
        const totalSupply = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});
        await burnTokens(wallets.creatorWallet, fullDenom, 1000);
        const afterTotalSupply = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});

        expect(Number(totalSupply.amount?.amount)).to.be.eq(Number(afterTotalSupply.amount?.amount) + 1000);
      });

      it('Whitelisted Dave cant burn tokens', async () => {
        const burnTx = await burnTokens(wallets.whitelistedWallet, fullDenom, 1000);
        expect(burnTx.rawLog).to.contain('failed to execute message; message index: 0: unauthorized account');
      });

      it('Unwhitelisted Eve cant burn tokens', async () => {
        const burnTx = await burnTokens(wallets.unwhitelistedWallet, fullDenom, 1000);
        expect(burnTx.rawLog).to.contain('failed to execute message; message index: 0: unauthorized account');
      });

      it('Alice can update whitelist', async () => {
        const tobeWhitelistedAddress = await getAddress(wallets.tobeWhitelistedWallet);
        const whitelistedAddress = await getAddress(wallets.whitelistedWallet);
        const newAdminAddress = await getAddress(wallets.newAdminWallet);
        await updateDenomMessage(fullDenom, wallets.creatorWallet, [whitelistedAddress, tobeWhitelistedAddress, creatorAddress, newAdminAddress]);

        const allowListAfter = await queryAllowlist(fullDenom);
        expect(allowListAfter.allow_list.addresses).to.have.length(4);
      });

      it('Whitelisted Dave can send tokens to newly added Eve', async () => {
        const newlyWhitelistedAddress = await getAddress(wallets.tobeWhitelistedWallet);
        const prevBalance = await queryBankBalance(wallets.tobeWhitelistedWallet, fullDenom);
        await bankTransfer(wallets.creatorWallet, fullDenom, 1000, newlyWhitelistedAddress);

        const afterBalance = await queryBankBalance(wallets.tobeWhitelistedWallet, fullDenom);
        expect(Number(afterBalance)).to.be.eq(Number(prevBalance) + 1000);
      });

      it('Whitelisted Dave cant send tokens to newly unwhitelisted Eve', async () => {
        const newlyRemovedAddress = await getAddress(wallets.toBeRemovedUser);
        const prevBalance = await queryBankBalance(wallets.toBeRemovedUser, fullDenom);
        const transferCall = await bankTransfer(wallets.whitelistedWallet, fullDenom, 1000, newlyRemovedAddress);

        const afterBalance = await queryBankBalance(wallets.toBeRemovedUser, fullDenom);

        expect(afterBalance).to.be.eq(prevBalance);
        expect(transferCall.rawLog).to.contain('is not allowed to receive funds: unauthorized');
      });

      it('Newly unwhitelisted Eve cant send tokens back to another unwhitelisted Ferdie', async () => {
        const unwhitelistedAddress = await getAddress(wallets.unwhitelistedWallet);
        const prevBalance = await queryBankBalance(wallets.unwhitelistedWallet, fullDenom);
        const transferCall = await bankTransfer(wallets.toBeRemovedUser, fullDenom, 1000, unwhitelistedAddress);
        const afterBalance = await queryBankBalance(wallets.unwhitelistedWallet, fullDenom);

        expect(transferCall.rawLog).to.contain('is not allowed to send funds: unauthorized');
        expect(prevBalance).to.be.eq(afterBalance);
      });

      it('Alice can change admin to Bob', async () => {
        const seiq = await getQueryClient();
        await setAdmin(wallets.creatorWallet, wallets.newAdminWallet, fullDenom);
        const newAdminAddress = await getAddress(wallets.newAdminWallet);
        const metadata = await seiq.seiprotocol.seichain.tokenfactory.denomAuthorityMetadata({denom: fullDenom});

        expect(metadata.authorityMetadata?.admin).to.be.eq(newAdminAddress);
      });

      it('After change admin, Alice cant mint tokens', async () => {
        const mintTx = await mintTokens(fullDenom, wallets.creatorWallet);
        expect(mintTx.rawLog).to.contain('unauthorized account');
      });

      it('New admin Bob can mint tokens', async () => {
        const prevBalance = await queryBankBalance(wallets.newAdminWallet, fullDenom);
        await mintTokens(fullDenom, wallets.newAdminWallet);
        const afterBalance = await queryBankBalance(wallets.newAdminWallet, fullDenom);

        expect(Number(afterBalance)).to.be.eq(Number(prevBalance) + 10000000);
      });

      it('New admin Bob can update whitelist', async () => {
        const whitelistedAddress = await getAddress(wallets.whitelistedWallet);
        const newAdminAddress = await getAddress(wallets.newAdminWallet);
        await updateDenomMessage(fullDenom, wallets.newAdminWallet, [whitelistedAddress, creatorAddress, newAdminAddress]);
        const allowListAfter = await queryAllowlist(fullDenom);

        expect(allowListAfter.allow_list.addresses).to.have.length(3);
        expect(allowListAfter.allow_list.addresses).to.contain(whitelistedAddress);
        expect(allowListAfter.allow_list.addresses).to.contain(creatorAddress);
        expect(allowListAfter.allow_list.addresses).to.contain(newAdminAddress);
      });

      it('If there are multiple tokens on user balance and user is whitelisted one and not on the other, user cant send on unwhitelisted one', async () => {
        const denom1 = 'whitelistedDenom';
        const denom2 = 'unwhitelistedDenom';
        const whitelistedAddress = await getAddress(wallets.whitelistedWallet);
        const unwhitelistedAddress = await getAddress(wallets.unwhitelistedWallet);
        const fullDenom1 = `factory/${creatorAddress}/${denom1}`;
        const fullDenom2 = `factory/${creatorAddress}/${denom2}`;

        await createNewDenom(creatorAddress, denom1, wallets.creatorWallet, [creatorAddress, whitelistedAddress, unwhitelistedAddress]);
        await createNewDenom(creatorAddress, denom2, wallets.creatorWallet, [creatorAddress, whitelistedAddress]);

        await mintTokens(fullDenom1, wallets.creatorWallet);
        await mintTokens(fullDenom2, wallets.creatorWallet);

        await bankTransfer(wallets.creatorWallet, fullDenom1, 100000, whitelistedAddress);
        await bankTransfer(wallets.creatorWallet, fullDenom2, 100000, whitelistedAddress);

        const transferDenom1Tx = await bankTransfer(wallets.whitelistedWallet, fullDenom1, 1000, unwhitelistedAddress);
        const transferDenom2Tx = await bankTransfer(wallets.whitelistedWallet, fullDenom2, 1000, unwhitelistedAddress);
        expect(transferDenom1Tx.rawLog).to.not.contain('is not allowed to receive funds: unauthorized');
        expect(transferDenom2Tx.rawLog).to.contain('is not allowed to receive funds: unauthorized');

        const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallets.whitelistedWallet);
        const senderAddress = await getAddress(wallets.whitelistedWallet);
        const sendCoin: Coin = {
          denom: fullDenom1,
          amount: `1000`
        };

        const sendCoinToFail: Coin = {
          denom: fullDenom2,
          amount: `1000`
        };

        const msgSend1 = {
          typeUrl: '/cosmos.bank.v1beta1.MsgSend',
          value: {
            fromAddress: senderAddress,
            toAddress: unwhitelistedAddress,
            amount: [sendCoin],
          },
        };

        const msgSend2 = {
          typeUrl: '/cosmos.bank.v1beta1.MsgSend',
          value: {
            fromAddress: senderAddress,
            toAddress: unwhitelistedAddress,
            amount: [sendCoinToFail],
          },
        };

        const txs = await client.signAndBroadcast(senderAddress, [msgSend1, msgSend2], fee);

        expect(txs.rawLog).to.contain('is not allowed to receive funds: unauthorized');
      });
    });


    describe('Token creation without allowlist', function () {
      let wallets: Wallets;
      const denom = 'myTestDenom';
      let creatorAddress: string;
      let fullDenom: string;
      let pointerAddress: string;
      let evmProvider: ethers.JsonRpcProvider;

      before('Initialize', async () => {
        const creator = await UserFactory.createSeiUser(admin, 'tfNaCreator');
        const whitelisted = await UserFactory.createSeiUser(admin, 'tfNaWhitelisted');
        const unwhitelisted = await UserFactory.createSeiUser(admin, 'tfNaUnwhitelisted');
        const tobeWhitelisted = await UserFactory.createSeiUser(admin, 'tfNaTobeWhitelisted');
        const newAdmin = await UserFactory.createSeiUser(admin, 'tfNaNewAdmin');
        const toBeRemoved = await UserFactory.createSeiUser(admin, 'tfNaToBeRemoved');
        wallets = {
          creatorWallet: creator.seiWallet.wallet,
          whitelistedWallet: whitelisted.seiWallet.wallet,
          unwhitelistedWallet: unwhitelisted.seiWallet.wallet,
          tobeWhitelistedWallet: tobeWhitelisted.seiWallet.wallet,
          newAdminWallet: newAdmin.seiWallet.wallet,
          toBeRemovedUser: toBeRemoved.seiWallet.wallet,
        };
        creatorAddress = await getAddress(wallets.creatorWallet);
        fullDenom = `factory/${creatorAddress}/${denom}`;
        evmProvider = await createProvider();
      });

      it('Alice can create a token without allowlist', async () => {
        await createNewDenom(creatorAddress, denom, wallets.creatorWallet);
        const seiq = await getQueryClient();
        const createdDenom = await seiq.seiprotocol.seichain.tokenfactory.denomsFromCreator({creator: creatorAddress});
        expect(createdDenom.denoms).to.have.length(1);

        const admin = await seiq.seiprotocol.seichain.tokenfactory.denomAuthorityMetadata({denom: fullDenom});
        expect(admin.authorityMetadata?.admin).to.be.eq(creatorAddress);

        const whiteList = await queryAllowlist(fullDenom);
        expect(whiteList.allow_list.addresses).to.have.length(0);
      });

      it('Alice can mint tokens', async () => {
        const seiq = await getQueryClient();
        const prevTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});
        await mintTokens(fullDenom, wallets.creatorWallet);
        const afterTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});

        expect(Number(prevTotalIssuance.amount?.amount)).to.be.eq(0);
        expect(Number(afterTotalIssuance.amount?.amount)).to.be.eq(Number(prevTotalIssuance.amount?.amount) + 10000000);
      });

      it('Eve cant mint tokens', async () => {
        const seiq = await seiprotocol.ClientFactory.createRPCQueryClient({rpcEndpoint});
        const prevTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});
        const mintTx = await mintTokens(fullDenom, wallets.unwhitelistedWallet);
        const afterTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});

        expect(mintTx.rawLog).to.contain('unauthorized account');
        expect(Number(afterTotalIssuance.amount?.amount)).to.be.eq(Number(prevTotalIssuance.amount?.amount));
      });


      it('Alice can send tokens to anyone address', async () => {
        const seiq = await getQueryClient();
        const receiverAddr = await getAddress(wallets.unwhitelistedWallet);
        const prevBalance = await queryBankBalance(wallets.unwhitelistedWallet, fullDenom);
        const senderBalance = await queryBankBalance(wallets.creatorWallet, fullDenom);
        const prevTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});
        await bankTransfer(wallets.creatorWallet, fullDenom, 2000, receiverAddr);

        const afterBalance = await queryBankBalance(wallets.unwhitelistedWallet, fullDenom);
        const senderBalanceAfter = await queryBankBalance(wallets.creatorWallet, fullDenom);
        const prevTotalIssuanceAfter = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});

        expect(Number(afterBalance)).to.be.eq(Number(prevBalance) + 2000);
        expect(prevTotalIssuance.amount?.amount).to.be.eq(prevTotalIssuanceAfter.amount?.amount);
        expect(Number(senderBalance)).to.be.eq(Number(senderBalanceAfter) + 2000);
      });


      it('Alice can burn tokens', async () => {
        const seiq = await getQueryClient();
        const prevTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});
        const prevBalance = await queryBankBalance(wallets.creatorWallet, fullDenom);

        await burnTokens(wallets.creatorWallet, fullDenom, 1000);

        const afterTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});
        const afterBalance = await queryBankBalance(wallets.creatorWallet, fullDenom);

        expect(Number(prevTotalIssuance.amount?.amount)).to.be.eq(Number(afterTotalIssuance.amount?.amount) + 1000);
        expect(Number(prevBalance)).to.be.eq(Number(afterBalance) + 1000);
      });

      it('Eve cant burn tokens', async () => {
        const seiq = await seiprotocol.ClientFactory.createRPCQueryClient({rpcEndpoint});
        const prevTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});
        const burnTx = await burnTokens(wallets.unwhitelistedWallet, fullDenom, 1000);
        const afterTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});

        expect(burnTx.rawLog).to.contain('unauthorized account');
        expect(prevTotalIssuance.amount?.amount).to.be.eq(afterTotalIssuance.amount?.amount);
      });

      it('Different users can receive funds on tokenfactory denoms', async () => {
        const whitelistedAddress = await getAddress(wallets.whitelistedWallet);
        const toBeRemovedAddress = await getAddress(wallets.toBeRemovedUser);
        await bankTransfer(wallets.creatorWallet, fullDenom, 1000000, whitelistedAddress);
        await bankTransfer(wallets.creatorWallet, fullDenom, 1000000, toBeRemovedAddress);
      });

      it('Unauthorized Eve cant update whitelist list', async () => {
        const receiverAddr = await getAddress(wallets.whitelistedWallet);
        const updateTx = await updateDenomMessage(fullDenom, wallets.whitelistedWallet, [receiverAddr, creatorAddress]);
        const allowList = await queryAllowlist(fullDenom);

        expect(allowList.allow_list.addresses).to.have.length(0);
        expect(updateTx.rawLog).to.contain('unauthorized account');
      });


      it('Alice can set whitelist', async () => {
        const whitelistedAddress = await getAddress(wallets.whitelistedWallet);
        const seiq = await seiprotocol.ClientFactory.createRPCQueryClient({rpcEndpoint});
        const prevTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});
        await updateDenomMessage(fullDenom, wallets.creatorWallet, [whitelistedAddress, creatorAddress]);
        const allowList = await queryAllowlist(fullDenom);
        const afterTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});

        expect(afterTotalIssuance.amount?.amount).to.be.eq(prevTotalIssuance.amount?.amount);
        expect(allowList.allow_list.addresses).to.have.length(2);
      });

      it('Whitelisted Dave cant update whitelist', async () => {
        const whitelistedAddress = await getAddress(wallets.whitelistedWallet);
        const thirdAddress = await getAddress(wallets.unwhitelistedWallet);
        const seiq = await getQueryClient();
        const prevTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});

        await updateDenomMessage(fullDenom, wallets.whitelistedWallet, [whitelistedAddress, creatorAddress, thirdAddress]);
        const allowList = await queryAllowlist(fullDenom);
        const afterTotalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});

        expect(afterTotalIssuance.amount?.amount).to.be.eq(prevTotalIssuance.amount?.amount);
        expect(allowList.allow_list.addresses).to.have.length(2);
        expect(allowList.allow_list.addresses).to.not.contain(thirdAddress);
      });

      it('Newly removed user Eve cant send tokens', async () => {
        const prevBalance = await queryBankBalance(wallets.toBeRemovedUser, fullDenom);
        const transferTx = await bankTransfer(wallets.toBeRemovedUser, fullDenom, 10000, creatorAddress);
        const afterBalance = await queryBankBalance(wallets.toBeRemovedUser, fullDenom);

        expect(transferTx.rawLog).to.contain('is not allowed to send funds: unauthorized');
        expect(prevBalance).to.be.eq(afterBalance);
      });

      it('After being dewhitelisted from tokenfactory token, Eve can send sei', async () => {
        const prevBalance = await queryBankBalance(wallets.toBeRemovedUser, 'usei');
        const transferTx = await bankTransfer(wallets.toBeRemovedUser, 'usei', 10000, creatorAddress);
        const afterBalance = await queryBankBalance(wallets.toBeRemovedUser, 'usei');
        const expectedDiff = Number(prevBalance) - Number(afterBalance);

        expect(expectedDiff).to.be.gt(10000);
      });

      it('Whitelisted Dave can send to whitelisted Bob', async () => {
        const prevBalance = await queryBankBalance(wallets.creatorWallet, fullDenom);
        const tx = await bankTransfer(wallets.whitelistedWallet, fullDenom, 10000, creatorAddress);
        const afterBalance = await queryBankBalance(wallets.creatorWallet, fullDenom);

        expect(Number(prevBalance)).to.be.eq(Number(afterBalance) - 10000);
      });

      it('Whitelisted Dave cant send to unwhitelisted Eve', async () => {
        const unwhitelistedAddress = await getAddress(wallets.unwhitelistedWallet);
        const prevBalance = await queryBankBalance(wallets.unwhitelistedWallet, fullDenom);
        const transferTx = await bankTransfer(wallets.whitelistedWallet, fullDenom, 10000, unwhitelistedAddress);
        const afterBalance = await queryBankBalance(wallets.unwhitelistedWallet, fullDenom);

        expect(transferTx.rawLog).to.contain('is not allowed to receive funds: unauthorized');
        expect(prevBalance).to.be.eq(afterBalance);
      });

      it('Given that 2000 is set as max whitelist address limit, Alice can set 2000 addresses in the whitelist', async () => {
        const whitelistAddresses = [];
        for (let i = 0; i < 1000; i++) {
          whitelistAddresses.push(await generateValidAddressWithoutFunds());
        }
        for (let i = 0; i < 998; i++) {
          whitelistAddresses.push(await generateValidAddressWithoutFunds());
        }
        whitelistAddresses.push(await getAddress(wallets.creatorWallet));
        whitelistAddresses.push(await getAddress(wallets.whitelistedWallet));
        const updateTx = await updateDenomMessage(fullDenom, wallets.creatorWallet, whitelistAddresses);
        const allowList = await queryAllowlist(fullDenom);
        expect(allowList.allow_list.addresses).to.have.length(2000);
      });

      it('Alice can deploy pointer for token with allowlist feature on', async () => {
        await deployPointer(fullDenom);
        await waitFor(1);
        const pointerRaw = await queryPointerAddress(fullDenom);
        pointerAddress = pointerRaw.pointer;
      });

      it('Whitelisted Alice can send tokens on evm to whitelisted Dave', async () => {
        const senderWallet = createWalletWithMnemonic(wallets.whitelistedWallet.mnemonic);
        const creatorEvmWallet = createWalletWithMnemonic(wallets.creatorWallet.mnemonic);
        senderWallet.connect(evmProvider);

        const balance = await queryEvmBalance(senderWallet, evmProvider, pointerAddress);

        const seiq = await getQueryClient();
        const totalIssuance = await seiq.cosmos.bank.v1beta1.supplyOf({denom: fullDenom});
        const evmTotalSupply = await querySupplyOnEvm(senderWallet, evmProvider, pointerAddress);

        expect(totalIssuance.amount?.amount.toString()).to.be.eq(evmTotalSupply.toString());

        await sendERC20(senderWallet, pointerAddress, creatorEvmWallet.address, 1000, evmProvider);
        const balanceAfter = await queryEvmBalance(senderWallet, evmProvider, pointerAddress);

        expect(Number(balanceAfter)).to.be.eq(Number(balance) - 1000);
      });

      it('Whitelisted Alice cant send tokens on evm to unwhitelisted Eve', async () => {
        const senderWallet = createWalletWithMnemonic(wallets.whitelistedWallet.mnemonic);
        const thirdWalletAddr = createWalletWithMnemonic(wallets.unwhitelistedWallet.mnemonic);
        senderWallet.connect(evmProvider);
        const balance = await queryEvmBalance(senderWallet, evmProvider, pointerAddress);
        let balanceAfter = '';
        try {
          await sendERC20(senderWallet, pointerAddress, thirdWalletAddr.address, 1000, evmProvider);
        } catch (e: any) {
          balanceAfter = await queryEvmBalance(senderWallet, evmProvider, pointerAddress);
        }

        expect(balance.toString()).to.be.eq(balanceAfter.toString());
      });


      it('Given that 2000 is set as max list size, Alice cant set 2001 whitelisted users', async () => {
        const whitelistAddresses = [];
        const preWhitelistAddr = await queryAllowlist(fullDenom);
        for (let i = 0; i < 2001; i++) {
          whitelistAddresses.push(await generateValidAddressWithoutFunds());
        }
        const updateTx = await updateDenomMessage(fullDenom, wallets.creatorWallet, whitelistAddresses);
        await waitFor(1);
        const afterWhitelistAddr = await queryAllowlist(fullDenom);

        expect(afterWhitelistAddr.allow_list.addresses).to.be.deep.eq(preWhitelistAddr.allow_list.addresses);
        expect(updateTx.rawLog).to.contain('allowlist too large');
      });


      it('Newly removed Dave cant send tokens on evm', async () => {
        const recentlyRemovedWallet = createWalletWithMnemonic(wallets.toBeRemovedUser.mnemonic);
        const whitelistedReceiverWallet = createWalletWithMnemonic(wallets.whitelistedWallet.mnemonic);
        const whitelistedAddress = await getAddress(wallets.whitelistedWallet);
        const recentlyRemovedAddress = await getAddress(wallets.toBeRemovedUser);
        const updateTxToInclude = await updateDenomMessage(fullDenom, wallets.creatorWallet, [creatorAddress, whitelistedAddress, recentlyRemovedAddress]);
        let whitelist = await queryAllowlist(fullDenom);
        expect(whitelist.allow_list.addresses).to.contain(recentlyRemovedAddress);

        const updateTx = await updateDenomMessage(fullDenom, wallets.creatorWallet, [creatorAddress, whitelistedAddress]);
        whitelist = await queryAllowlist(fullDenom);
        expect(whitelist.allow_list.addresses).not.to.contain(recentlyRemovedAddress);

        let isFailed = false;
        try {
          await sendERC20(recentlyRemovedWallet, pointerAddress, whitelistedReceiverWallet.address, 100, evmProvider);
        } catch (e: any) {
          isFailed = true;
        }
        expect(isFailed).to.be.true;
      });

      it('After setting new admin, Dave can send tx', async () => {
        const seiq = await getQueryClient();
        await setAdmin(wallets.creatorWallet, wallets.newAdminWallet, fullDenom);
        const newAdminAddress = await getAddress(wallets.newAdminWallet);

        const adminAuth = await seiq.seiprotocol.seichain.tokenfactory.denomAuthorityMetadata({denom: fullDenom});
        expect(adminAuth.authorityMetadata?.admin).to.be.eq(newAdminAddress);

        const senderWallet = createWalletWithMnemonic(wallets.creatorWallet.mnemonic);
        const receiverWallet = createWalletWithMnemonic(wallets.whitelistedWallet.mnemonic);
        const prevBalance = await queryEvmBalance(receiverWallet, evmProvider, pointerAddress);
        await waitFor(1);
        const tx = await sendERC20(senderWallet, pointerAddress, receiverWallet.address, 100, evmProvider);

        const afterBalance = await queryEvmBalance(receiverWallet, evmProvider, pointerAddress);
        expect(Number(afterBalance)).to.be.eq(Number(prevBalance) + 100);
      });


      it('After admin change, Dave send to an unwhitelisted Eve on evm', async () => {
        const whitelistedWallet = createWalletWithMnemonic(wallets.whitelistedWallet.mnemonic);
        const receiverWallet = createWalletWithMnemonic(wallets.unwhitelistedWallet.mnemonic);

        let isFailed = false;
        try {
          await sendERC20(whitelistedWallet, pointerAddress, receiverWallet.address, 100, evmProvider);
        } catch (e: any) {
          isFailed = true;
        }
        expect(isFailed).to.be.true;
      });
    });
  });

  describe('Error Cases', function () {
    let errorCreator: SeiUser;
    let errorCreatorAddress: string;
    let errorWallet: any;

    before(async () => {
      errorCreator = await UserFactory.createSeiUser(admin, 'tfErrCreator');
      errorCreatorAddress = errorCreator.seiAddress;
      errorWallet = errorCreator.seiWallet.wallet;
    });

    it('Cannot create denom with empty subdenom', async () => {
      try {
        const result = await execCommandAndReturnJson(
          `seid tx tokenfactory create-denom "" --from tfErrCreator --fees ${CLI_FEE} -y --broadcast-mode block`
        );
        expect(result.code).to.not.be.eq(0);
      } catch (e: any) {
        expect(e.message).to.be.a('string');
        expect(e.message.length).to.be.gt(0);
      }
    });

    it('Cannot mint on a denom you do not own', async () => {
      const otherCreator = await UserFactory.createSeiUser(admin, 'tfOtherCreator');
      const subdenom = 'otherDenom';
      await execCommandAndReturnJson(
        `seid tx tokenfactory create-denom ${subdenom} --from tfOtherCreator --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      const fullDenom = `factory/${otherCreator.seiAddress}/${subdenom}`;

      const mintResult = await mintTokens(fullDenom, errorWallet);
      expect(mintResult.rawLog).to.contain('unauthorized account');
    });

    it('Cannot burn more tokens than supply', async () => {
      const subdenom = 'burnTest';
      await createNewDenom(errorCreatorAddress, subdenom, errorWallet);
      const fullDenom = `factory/${errorCreatorAddress}/${subdenom}`;
      await mintTokens(fullDenom, errorWallet);

      const burnResult = await burnTokens(errorWallet, fullDenom, 99999999);
      expect(burnResult.rawLog).to.contain('insufficient funds');
    });

    it('Cannot change admin to invalid address', async () => {
      const subdenom = 'adminTest';
      await createNewDenom(errorCreatorAddress, subdenom, errorWallet);
      const fullDenom = `factory/${errorCreatorAddress}/${subdenom}`;

      const result = await execCommandAndReturnJson(
        `seid tx tokenfactory change-admin ${fullDenom} invalidaddress --from tfErrCreator --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.not.be.eq(0);
    });

    it('After admin change, old admin cannot mint', async () => {
      const subdenom = 'adminChange';
      await createNewDenom(errorCreatorAddress, subdenom, errorWallet);
      const fullDenom = `factory/${errorCreatorAddress}/${subdenom}`;

      const newAdmin = await UserFactory.createSeiUser(admin, 'tfNewAdmin2');
      await setAdmin(errorWallet, newAdmin.seiWallet.wallet, fullDenom);

      const mintResult = await mintTokens(fullDenom, errorWallet);
      expect(mintResult.rawLog).to.contain('unauthorized account');
    });

    it('Cannot create duplicate subdenom from same creator', async () => {
      const subdenom = 'dupeDenom';
      const result1 = await execCommandAndReturnJson(
        `seid tx tokenfactory create-denom ${subdenom} --from tfErrCreator --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result1.code).to.be.eq(0);

      const result2 = await execCommandAndReturnJson(
        `seid tx tokenfactory create-denom ${subdenom} --from tfErrCreator --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result2.code).to.not.be.eq(0);
    });
  });

  describe('Cross-Runtime Consistency', function () {
    let crCreator: SeiUser;
    let crAddress: string;
    let crFullDenom: string;
    let crWallet: any;

    before(async () => {
      crCreator = await UserFactory.createSeiUser(admin, 'tfCrCreator');
      crAddress = crCreator.seiAddress;
      crWallet = crCreator.seiWallet.wallet;
      const subdenom = 'crossRuntime';
      await createNewDenom(crAddress, subdenom, crWallet);
      crFullDenom = `factory/${crAddress}/${subdenom}`;
      await mintTokens(crFullDenom, crWallet);
    });

    it('Balance via seid matches CosmJS queryBankBalance', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q bank balances ${crAddress} --denom ${crFullDenom}`
      );
      const cosmjsBalance = await queryBankBalance(crWallet, crFullDenom);
      expect(cliResult.amount).to.be.eq(cosmjsBalance?.toString());
    });

    it('Total supply via seid matches RPC query', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q bank total --denom ${crFullDenom}`
      );
      const seiq = await getQueryClient();
      const rpcSupply = await seiq.cosmos.bank.v1beta1.supplyOf({ denom: crFullDenom });
      expect(cliResult.amount).to.be.eq(rpcSupply.amount?.amount);
    });

    it('Denoms from creator via seid matches RPC query', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q tokenfactory denoms-from-creator ${crAddress}`
      );
      const seiq = await getQueryClient();
      const rpcResult = await seiq.seiprotocol.seichain.tokenfactory.denomsFromCreator({ creator: crAddress });
      expect(cliResult.denoms.length).to.be.eq(rpcResult.denoms.length);
      expect(cliResult.denoms).to.include(crFullDenom);
      expect(rpcResult.denoms).to.include(crFullDenom);
    });

    it('Denom authority metadata via seid matches RPC query', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q tokenfactory denom-authority-metadata ${crFullDenom}`
      );
      const seiq = await getQueryClient();
      const rpcResult = await seiq.seiprotocol.seichain.tokenfactory.denomAuthorityMetadata({ denom: crFullDenom });
      expect(cliResult.authority_metadata.admin).to.be.eq(rpcResult.authorityMetadata?.admin);
    });
  });

  describe('Full Lifecycle', function () {
    it('Create -> Mint -> Transfer -> Burn -> Verify supply chain', async () => {
      const lcCreator = await UserFactory.createSeiUser(admin, 'tfLifecycle');
      const lcReceiver = await UserFactory.createSeiUser(admin, 'tfLcReceiver');
      const lcAddress = lcCreator.seiAddress;
      const lcWallet = lcCreator.seiWallet.wallet;
      const subdenom = 'lifecycle';
      const fullDenom = `factory/${lcAddress}/${subdenom}`;

      // 1. Create
      await createNewDenom(lcAddress, subdenom, lcWallet);
      const seiq = await getQueryClient();
      const denoms = await seiq.seiprotocol.seichain.tokenfactory.denomsFromCreator({ creator: lcAddress });
      expect(denoms.denoms).to.include(fullDenom);

      // 2. Mint
      await mintTokens(fullDenom, lcWallet);
      const creatorBal = await queryBankBalance(lcWallet, fullDenom);
      expect(creatorBal).to.be.eq('10000000');

      // 3. Transfer
      const receiverAddress = await getAddress(lcReceiver.seiWallet.wallet);
      await bankTransfer(lcWallet, fullDenom, 3000000, receiverAddress);
      const receiverBal = await queryBankBalance(lcReceiver.seiWallet.wallet, fullDenom);
      expect(receiverBal).to.be.eq('3000000');

      const creatorBalAfterTransfer = await queryBankBalance(lcWallet, fullDenom);
      expect(creatorBalAfterTransfer).to.be.eq('7000000');

      // 4. Verify total supply unchanged
      const supplyAfterTransfer = await seiq.cosmos.bank.v1beta1.supplyOf({ denom: fullDenom });
      expect(supplyAfterTransfer.amount?.amount).to.be.eq('10000000');

      // 5. Burn
      await burnTokens(lcWallet, fullDenom, 2000000);
      const supplyAfterBurn = await seiq.cosmos.bank.v1beta1.supplyOf({ denom: fullDenom });
      expect(supplyAfterBurn.amount?.amount).to.be.eq('8000000');

      // 6. Final balances
      const finalCreatorBal = await queryBankBalance(lcWallet, fullDenom);
      expect(finalCreatorBal).to.be.eq('5000000');
      const finalReceiverBal = await queryBankBalance(lcReceiver.seiWallet.wallet, fullDenom);
      expect(finalReceiverBal).to.be.eq('3000000');
    });

    it('Create with allowlist -> Add/remove members -> Verify transfer restrictions change', async () => {
      const lcCreator = await UserFactory.createSeiUser(admin, 'tfAlLifecycle');
      const allowedUser = await UserFactory.createSeiUser(admin, 'tfAlAllowed');
      const blockedUser = await UserFactory.createSeiUser(admin, 'tfAlBlocked');
      const lcAddress = lcCreator.seiAddress;
      const lcWallet = lcCreator.seiWallet.wallet;
      const allowedAddress = await getAddress(allowedUser.seiWallet.wallet);
      const blockedAddress = await getAddress(blockedUser.seiWallet.wallet);
      const subdenom = 'alLifecycle';
      const fullDenom = `factory/${lcAddress}/${subdenom}`;

      // 1. Create with allowlist
      await createNewDenom(lcAddress, subdenom, lcWallet, [lcAddress, allowedAddress]);

      // 2. Mint
      await mintTokens(fullDenom, lcWallet);

      // 3. Transfer to allowed user succeeds
      const tx1 = await bankTransfer(lcWallet, fullDenom, 100000, allowedAddress);
      expect(tx1.rawLog).to.not.contain('unauthorized');

      // 4. Transfer to blocked user fails
      const tx2 = await bankTransfer(lcWallet, fullDenom, 100000, blockedAddress);
      expect(tx2.rawLog).to.contain('is not allowed to receive funds: unauthorized');

      // 5. Add blocked user to allowlist
      await updateDenomMessage(fullDenom, lcWallet, [lcAddress, allowedAddress, blockedAddress]);
      const updatedList = await queryAllowlist(fullDenom);
      expect(updatedList.allow_list.addresses).to.have.length(3);

      // 6. Now transfer to previously-blocked user succeeds
      const tx3 = await bankTransfer(lcWallet, fullDenom, 100000, blockedAddress);
      expect(tx3.rawLog).to.not.contain('unauthorized');

      // 7. Remove allowed user
      await updateDenomMessage(fullDenom, lcWallet, [lcAddress, blockedAddress]);

      // 8. Now previously-allowed user can't receive
      const tx4 = await bankTransfer(lcWallet, fullDenom, 100000, allowedAddress);
      expect(tx4.rawLog).to.contain('is not allowed to receive funds: unauthorized');
    });
  });
});
