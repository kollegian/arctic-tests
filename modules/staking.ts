import {DirectSecp256k1HdWallet} from '@cosmjs/proto-signing';
import {SigningStargateClient} from '@cosmjs/stargate';
import {generateValidAddress, waitFor} from './tokenfactory/helpers';
import {createSeiProvider} from './utils/utils';
import {rpcEndpoint} from './constants';

describe('Governance Queries', function () {
  this.timeout(4 * 60 * 1000);
  let seiWallet: DirectSecp256k1HdWallet;
  let signingClient: SigningStargateClient;
  let seiAddress: string;
  let proposalId: string;

  before('', async () => {
    seiWallet = await generateValidAddress();
    await waitFor(1);
    seiAddress = (await seiWallet.getAccounts())[0].address;
    signingClient = await createSeiProvider(rpcEndpoint, seiWallet);
    const sClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, seiWallet);
  });

});