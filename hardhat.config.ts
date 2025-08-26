import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: "0.8.28",
  networks: {
    seiTestnet: {
      url: "https://evm-rpc-testnet.sei-apis.com",
      accounts: ["0x2bd96f4b341d7e26afbfabafdaae89b6c67cdd8076517181d11b30faa2412f8e"],
      chainId: 1328,
      gasPrice: 2000000000, // 2 gwei
      gas: 210000,
    },
  },
};

export default config;
