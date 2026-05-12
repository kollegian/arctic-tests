import { ethers } from 'ethers';
import { getTestConfig } from '../../shared/testConfig';

export const getNetwork = (_network: 'local' | 'seiTestnet' = 'local') => {
  const cfg = getTestConfig();
  const adminWallet = ethers.HDNodeWallet.fromPhrase(cfg.adminMnemonic, '', "m/44'/118'/0'/0/0");
  return {
    url: cfg.evmRpcEndpoint,
    accounts: [adminWallet.privateKey],
  };
};
