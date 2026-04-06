import {DirectSecp256k1HdWallet} from '@cosmjs/proto-signing';
import {
  deployPointer,
  generateValidAddresses,
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
  const denomAllowed = 'createdWithAllowList';
  let fullDenom: string;
  let wallets: Wallets;
  let creatorAddress: string;

  before('', async () =>{
    const chai = await import('chai');
    expect = chai.expect;
    wallets = await generateValidAddresses();
    creatorAddress = await getAddress(wallets.creatorWallet);
    fullDenom = `factory/${creatorAddress}/${denomAllowed}`;
    await waitFor(1);
  });

  describe('Token creation tests with setting allowlist', function () {

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

      //Multiple send test
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
    let newAdmin: DirectSecp256k1HdWallet;
    let pointerAddress: string;
    let evmProvider: ethers.JsonRpcProvider;

    before('Initialize', async () => {
      wallets = await generateValidAddresses();
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
