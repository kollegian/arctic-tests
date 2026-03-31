import testConfig from '../../config/testConfig.json';
import { ethers } from 'ethers';

const adminWallet = ethers.HDNodeWallet.fromPhrase(testConfig.adminMnemonic, '', "m/44'/118'/0'/0/0");

export const config = {
  local: {
    url: testConfig.evmRpcEndpoint,
    accounts: [adminWallet.privateKey],
  },
  seiTestnet: {
    url: testConfig.evmRpcEndpoint,
    accounts: [adminWallet.privateKey],
  },
};

export const getNetwork = (network: 'local' | 'seiTestnet' = 'local') => config[network];
