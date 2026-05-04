import {
  Coin,
  coin,
  DirectSecp256k1HdWallet,
  encodePubkey,
  makeAuthInfoBytes,
  makeSignDoc,
  Registry, TxBodyEncodeObject
} from '@cosmjs/proto-signing';
import {seiProtoRegistry} from '@sei-js/cosmos/encoding';
import {SigningStargateClient, StargateClient} from '@cosmjs/stargate';

import {MsgDelegate} from 'cosmjs-types/cosmos/staking/v1beta1/tx';
import {coins} from '@cosmjs/amino';
import {Querier} from '@sei-js/cosmos/rest';

const fee = { amount: coins(50000, 'usei'), gas: '500000' };
import {TxBody, TxRaw} from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import {fromBase64, toBase64} from '@cosmjs/encoding';
import {execCommandAndReturnJson} from '../../../shared/utils/cliUtils';
import {SeiUser} from '../../../shared/User';
import {getRpcQueryClient, toSnakeCase, withRestFallback} from '../utils/rpcQueryClient';



export default class Staking {
  stargateClient!: SigningStargateClient;
  signer!: DirectSecp256k1HdWallet;
  rpcEndpoint!: string;
  signerAddress!: string;
  restEndpoint!: string;
  
  async initialize(signer: DirectSecp256k1HdWallet, rpcEndpoint: string, restEndpoint: string){
    const registry = new Registry(seiProtoRegistry);
    this.stargateClient = await SigningStargateClient.connectWithSigner(
      rpcEndpoint,
      signer,
      { registry },
    );
    this.rpcEndpoint = rpcEndpoint;
    this.signer = signer;
    this.signerAddress = (await signer.getAccounts())[0].address;
    this.restEndpoint = restEndpoint;
  }

  async setSigner(signer: DirectSecp256k1HdWallet){
    if((await signer.getAccounts())[0].address !== (await this.signer.getAccounts())[0].address){
      this.signer = signer;
      this.signerAddress = (await signer.getAccounts())[0].address;
      const registry = new Registry(seiProtoRegistry);
      this.stargateClient = await SigningStargateClient.connectWithSigner(
        this.rpcEndpoint,
        signer,
        { registry },
      );
    }
  }

  async delegateTx(seiUser: SeiUser, validatorAddress: string, amount: Coin){
    const msg = {
      typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
      value: {
        delegatorAddress: seiUser.seiAddress,
        validatorAddress: validatorAddress,
        amount: amount,
      },
    }
    return await seiUser.seiWallet.signingClient.signAndBroadcast(seiUser.seiAddress, [msg], fee, "stake");
  }

  async sendRawTransaction(validatorAddress: string) {
    const client = await StargateClient.connect(this.rpcEndpoint);
    const account = await withRestFallback(
      'auth.account',
      async () => toSnakeCase({ account: await (await getRpcQueryClient()).auth.account(this.signerAddress) }),
      () =>
        Querier.cosmos.auth.v1beta1.Account(
          { address: this.signerAddress },
          { pathPrefix: this.restEndpoint },
        ),
    );
    // // @ts-ignore
    // const sequence = account.account!.sequence;
    // // @ts-ignore
    // const accountNumber = account.account!.account_number;
    const msg = {
      typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
      value: {
        delegatorAddress: this.signerAddress,
        validatorAddress: validatorAddress,
        amount: {
          denom: 'usei',
          amount: '-10'
        },
    }
    };
    const registry = new Registry([
      ["/cosmos.staking.v1beta1.MsgDelegate", MsgDelegate],
    ]);    const [{ address: walletAddress, pubkey: pubkeyBytes }] = await this.signer.getAccounts();
    const pubkey = encodePubkey({
      type: "tendermint/PubKeySecp256k1",
      value: toBase64(pubkeyBytes),
    });
    const txBodyFields: TxBodyEncodeObject = {
      typeUrl: "/cosmos.tx.v1beta1.TxBody",
      value: {
        messages: [
          msg
        ],
        memo: 'memo',
      },
    };
    const txBodyBytes = registry.encode(txBodyFields);
    const { accountNumber, sequence } = (await client.getSequence(walletAddress))!;
    const feeAmount = [
      {
        amount: "24000",
        denom: "usei",
      },
    ];
    const gasLimit = 200000;
    const feeGranter = undefined;
    const feePayer = undefined;
    const authInfoBytes = makeAuthInfoBytes([{ pubkey, sequence }], feeAmount, gasLimit, feeGranter, feePayer);

    const chainId = await client.getChainId();
    const signDoc = makeSignDoc(txBodyBytes, authInfoBytes, chainId, accountNumber);
    const { signature } = await this.signer.signDirect(walletAddress, signDoc);
    const txRaw = TxRaw.fromPartial({
      bodyBytes: txBodyBytes,
      authInfoBytes: authInfoBytes,
      signatures: [fromBase64(signature.signature)],
    });
    const txRawBytes = Uint8Array.from(TxRaw.encode(txRaw).finish());
    const broadcastResponse = await client.broadcastTx(
      txRawBytes,
    );
    console.log(broadcastResponse);
  }

  async undelegateTx(user: SeiUser, validatorAddress: string, amount: Coin){
    const msg = {
      typeUrl: '/cosmos.staking.v1beta1.MsgUndelegate',
      value: {
        delegatorAddress: user.seiAddress,
        validatorAddress: validatorAddress,
        amount: amount,
      },
    }
    return await user.seiWallet.signingClient.signAndBroadcast(user.seiAddress, [msg], fee, "undelegate");
  }

  async redelegateTx(sender: SeiUser, validatorDstAddress: string, amount: Coin, validatorSrcAddress: string){
    const msg = {
      typeUrl: '/cosmos.staking.v1beta1.MsgBeginRedelegate',
      value: {
        delegatorAddress: sender.seiAddress,
        validatorSrcAddress: validatorSrcAddress,
        validatorDstAddress: validatorDstAddress,
        amount: amount,
      },
    }
    return await sender.seiWallet.signingClient.signAndBroadcast(sender.seiAddress, [msg], fee, "redelegate");
  }
  
  async queryDelegations(validatorAddress: string){
    return withRestFallback(
      'staking.delegation',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.delegation(this.signerAddress, validatorAddress)),
      () =>
        Querier.cosmos.staking.v1beta1.Delegation(
          { delegator_addr: this.signerAddress, validator_addr: validatorAddress },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }


  async queryValidators(status: string = 'BOND_STATUS_BONDED') {
    return withRestFallback(
      'staking.validators',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.validators(status as any)),
      () => Querier.cosmos.staking.v1beta1.Validators({ status }, { pathPrefix: this.restEndpoint }),
    );
  }

  async queryValidator(validatorAddress: string) {
    return withRestFallback(
      'staking.validator',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.validator(validatorAddress)),
      () =>
        Querier.cosmos.staking.v1beta1.Validator(
          { validator_addr: validatorAddress },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }

  async queryDelegatorDelegations() {
    return withRestFallback(
      'staking.delegatorDelegations',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.delegatorDelegations(this.signerAddress)),
      () =>
        Querier.cosmos.staking.v1beta1.DelegatorDelegations(
          { delegator_addr: this.signerAddress },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }

  async queryDelegatorUnbondingDelegations() {
    return withRestFallback(
      'staking.delegatorUnbondingDelegations',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.delegatorUnbondingDelegations(this.signerAddress)),
      () =>
        Querier.cosmos.staking.v1beta1.DelegatorUnbondingDelegations(
          { delegator_addr: this.signerAddress },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }

  async queryRedelegations(srcValidatorAddr: string, dstValidatorAddr: string) {
    return withRestFallback(
      'staking.redelegations',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.redelegations(this.signerAddress, srcValidatorAddr, dstValidatorAddr)),
      () =>
        Querier.cosmos.staking.v1beta1.Redelegations(
          {
            delegator_addr: this.signerAddress,
            src_validator_addr: srcValidatorAddr,
            dst_validator_addr: dstValidatorAddr,
          },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }

  async queryValidatorDelegations(validatorAddress: string) {
    return withRestFallback(
      'staking.validatorDelegations',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.validatorDelegations(validatorAddress)),
      () =>
        Querier.cosmos.staking.v1beta1.ValidatorDelegations(
          { validator_addr: validatorAddress },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }

  async queryValidatorRedelegations(validatorAddress: string) {
    // NOTE: this method historically aliased validatorDelegations; preserve
    // that behaviour while moving over to RPC-with-fallback.
    return this.queryValidatorDelegations(validatorAddress);
  }

  async queryValidatorUnbondingDelegations(validatorAddress: string) {
    return withRestFallback(
      'staking.validatorUnbondingDelegations',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.validatorUnbondingDelegations(validatorAddress)),
      () =>
        Querier.cosmos.staking.v1beta1.ValidatorUnbondingDelegations(
          { validator_addr: validatorAddress },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }

  async queryDelegation(validatorAddr: string) {
    return withRestFallback(
      'staking.delegation',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.delegation(this.signerAddress, validatorAddr)),
      () =>
        Querier.cosmos.staking.v1beta1.Delegation(
          { delegator_addr: this.signerAddress, validator_addr: validatorAddr },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }

  async queryUnbondingDelegation(validatorAddr: string) {
    return withRestFallback(
      'staking.unbondingDelegation',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.unbondingDelegation(this.signerAddress, validatorAddr)),
      () =>
        Querier.cosmos.staking.v1beta1.UnbondingDelegation(
          { delegator_addr: this.signerAddress, validator_addr: validatorAddr },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }

  async queryDelegatorValidators() {
    return withRestFallback(
      'staking.delegatorValidators',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.delegatorValidators(this.signerAddress)),
      () =>
        Querier.cosmos.staking.v1beta1.DelegatorValidators(
          { delegator_addr: this.signerAddress },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }

  async queryDelegatorValidator(validatorAddr: string) {
    return withRestFallback(
      'staking.delegatorValidator',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.delegatorValidator(this.signerAddress, validatorAddr)),
      () =>
        Querier.cosmos.staking.v1beta1.DelegatorValidator(
          { delegator_addr: this.signerAddress, validator_addr: validatorAddr },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }

  async queryPool() {
    return withRestFallback(
      'staking.pool',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.pool()),
      () => Querier.cosmos.staking.v1beta1.Pool({}, { pathPrefix: this.restEndpoint }),
    );
  }

  async queryParameters() {
    return withRestFallback(
      'staking.params',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.params()),
      () => Querier.cosmos.staking.v1beta1.Params({}, { pathPrefix: this.restEndpoint }),
    );
  }

  async queryHistoricalInfo(height: number) {
    return withRestFallback(
      'staking.historicalInfo',
      async () => toSnakeCase(await (await getRpcQueryClient()).staking.historicalInfo(height)),
      () =>
        Querier.cosmos.staking.v1beta1.HistoricalInfo(
          { height },
          { pathPrefix: this.restEndpoint },
        ),
    );
  }

  async cmdQueryDelegationsTo(validatorAddress: string){
    const delegations = await execCommandAndReturnJson(`seid q staking delegations-to ${validatorAddress}`);
    return delegations.delegation_responses ?? [];
  }

  async cmdDelegation(delegatorAddress: string, validatorAddress: string) {
    const delegation = await execCommandAndReturnJson(`seid q staking delegation ${delegatorAddress} ${validatorAddress}`);
    return delegation.delegation;
  }

  async cmdDelegations(delegatorAddress: string) {
    const delegations = await execCommandAndReturnJson(`seid q staking delegations ${delegatorAddress}`);
    return delegations.delegation_responses ?? [];
  }


  async cmdHexAddress(tendermintHexAddress: string) {
    const validator = await execCommandAndReturnJson(`seid q staking hex-address ${tendermintHexAddress}`);
    return validator;
  }

  async cmdHistoricalInfo(height: number) {
    const historicalInfo = await execCommandAndReturnJson(`seid q staking historical-info ${height}`);
    return historicalInfo;
  }

  async cmdParams() {
    const params = await execCommandAndReturnJson(`seid q staking params`);
    return params;
  }

  async cmdPool() {
    const pool = await execCommandAndReturnJson(`seid q staking pool`);
    return pool;
  }

  async cmdRedelegation(delegatorAddress: string, srcValidatorAddress: string, dstValidatorAddress: string) {
    const redelegation = await execCommandAndReturnJson(`seid q staking redelegation ${delegatorAddress} ${srcValidatorAddress} ${dstValidatorAddress}`);
    return redelegation.redelegation_response;
  }

  async cmdRedelegations(delegatorAddress: string) {
    const redelegations = await execCommandAndReturnJson(`seid q staking redelegations ${delegatorAddress}`);
    return redelegations.redelegation_responses ?? [];
  }

  async cmdRedelegationsFrom(validatorAddress: string) {
    const redelegations = await execCommandAndReturnJson(`seid q staking redelegations-from ${validatorAddress}`);
    return redelegations.redelegation_responses ?? [];
  }

  async cmdUnbondingDelegation(delegatorAddress: string, validatorAddress: string) {
    const unbondingDelegation = await execCommandAndReturnJson(`seid q staking unbonding-delegation ${delegatorAddress} ${validatorAddress}`);
    return unbondingDelegation.unbond;
  }

  async cmdUnbondingDelegations(delegatorAddress: string) {
    const unbondingDelegations = await execCommandAndReturnJson(`seid q staking unbonding-delegations ${delegatorAddress}`);
    return unbondingDelegations.unbonding_delegation_responses ?? unbondingDelegations.unbonding_responses ?? [];
  }

  async cmdUnbondingDelegationsFrom(validatorAddress: string) {
    const unbondingDelegations = await execCommandAndReturnJson(`seid q staking unbonding-delegations-from ${validatorAddress}`);
    return unbondingDelegations.unbonding_delegation_responses ?? unbondingDelegations.unbonding_responses ?? [];
  }

  async cmdValidator(validatorAddress: string) {
    const validator = await execCommandAndReturnJson(`seid q staking validator ${validatorAddress}`);
    return validator.validator;
  }

  async cmdValidators() {
    const validators = await execCommandAndReturnJson(`seid q staking validators`);
    return validators.validators;
  }

  async cmdRewards(validatorAddress: string, delegatorAddress: string) {
    const rewards = await execCommandAndReturnJson(`seid q distribution rewards ${delegatorAddress} ${validatorAddress}`);
    return rewards.rewards;
  }

  findUserLastDelegation(delegatorAddress: string, validatorAddress: string, allDelegations: any[] = []){
    return allDelegations.filter((delegation) => {
      return delegation.delegation?.delegator_address === delegatorAddress && delegation.delegation?.validator_address === validatorAddress;
    }).pop();
  }

  createvalidateTxRaw(){

  }
}