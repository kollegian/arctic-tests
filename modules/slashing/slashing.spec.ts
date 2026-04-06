import {DirectSecp256k1HdWallet} from '@cosmjs/proto-signing';
import {SigningStargateClient} from '@cosmjs/stargate';
import {generateValidAddress, waitFor} from '../tokenfactory/helpers';
import {createSeiProvider} from '../utils/utils';
import {restEndpoint, rpcEndpoint} from '../constants';
import { Encoder } from '@sei-js/cosmos/encoding';
import { Querier } from '@sei-js/cosmos/rest';
import {fee} from '../tokenfactory/types';
import { QueryValidatorResponse } from '@sei-js/cosmos/types/cosmos/staking/v1beta1';
import { fromBase64, toBech32 } from '@cosmjs/encoding';
import { sha256 } from '@cosmjs/crypto';

describe('Slashing Queries', function () {
  this.timeout(4 * 60 * 1000);
  let seiWallet: DirectSecp256k1HdWallet;
  let signingClient: SigningStargateClient;
  let seiAddress: string;
  let validatorAddr: string;
  let validatorInfo: QueryValidatorResponse;

  before('Initializes clients', async () => {
    seiWallet = await generateValidAddress();
    await waitFor(1);
    seiAddress = (await seiWallet.getAccounts())[0].address;
    signingClient = await createSeiProvider(rpcEndpoint, seiWallet);
    const validatorsInfo = await Querier.cosmos.staking.v1beta1.Validators({
      status: 'BOND_STATUS_BONDED'
    }, {pathPrefix: restEndpoint});
    validatorAddr = validatorsInfo.validators[0].operator_address;
    validatorInfo = await Querier.cosmos.staking.v1beta1.Validator({
      validator_addr: validatorAddr
    }, {pathPrefix: restEndpoint});
  })

  it('Can call unjail message', async () =>{
    const unjailMsg = {
      typeUrl: `/${Encoder.cosmos.slashing.v1beta1.MsgUnjail.$type}`,
      value: Encoder.cosmos.slashing.v1beta1.MsgUnjail.fromPartial({
        validator_addr: validatorAddr
      })
    }
    const response = await signingClient.signAndBroadcast(seiAddress, [unjailMsg], fee, 'unjail tx');
    console.log(response);
  });

  it('Queries sign info', async () =>{
    const ed25519PubkeyRaw = fromBase64(validatorInfo!.validator!.consensus_pubkey!.key);
    const addressData = sha256(ed25519PubkeyRaw).slice(0, 20);
    const bech32Address = toBech32("seivalcons", addressData);
    console.log(bech32Address);
    const response = await Querier.cosmos.slashing.v1beta1.SigningInfo({
      cons_address: bech32Address
    }, {pathPrefix: restEndpoint})
    console.log(response);
  });

  it('Queries signing infos', async () =>{
    const response = await Querier.cosmos.slashing.v1beta1.SigningInfos({}, {pathPrefix: restEndpoint});
    console.log(response);
  });

});