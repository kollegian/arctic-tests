import {DirectSecp256k1HdWallet} from '@cosmjs/proto-signing';
import {SigningStargateClient} from '@cosmjs/stargate';
import {generateValidAddress, waitFor} from '../tokenfactory/helpers';
import {createSeiProvider} from '../utils/utils';
import {restEndpoint, rpcEndpoint} from '../constants';
import { Querier } from '@sei-js/cosmos/rest';

describe('Mint Queries', function () {
  this.timeout(4 * 60 * 1000);
  let seiWallet: DirectSecp256k1HdWallet;

  before('Initializes clients', async () => {
    seiWallet = await generateValidAddress();
    await waitFor(1);
  })

  it('Queries annual provisions', async () =>{
    const response = await Querier.cosmos.mint.v1beta1.AnnualProvisions({}, {pathPrefix: restEndpoint});
    console.log(response);
  });

  it('Queries inflation', async () =>{
    const response = await Querier.cosmos.mint.v1beta1.Inflation({}, {pathPrefix: restEndpoint});
    console.log(response);
  });

  it('Queries Minter', async () =>{
    const response = await Querier.mint.v1beta1.Minter({}, {pathPrefix: restEndpoint});
    console.log(response);
  })

  it('Queries params', async () =>{
    const response = await Querier.mint.v1beta1.Params({}, {pathPrefix: restEndpoint});
    console.log(response.params!.token_release_schedule);
  })
});