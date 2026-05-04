import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: "0.8.28",
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://sepolia.infura.io/v3/7385403357dc4a5db6401f095a34d4f1",
      accounts: process.env.SEPOLIA_PRIVATE_KEY ? [process.env.SEPOLIA_PRIVATE_KEY] : [],
      chainId: 11155111,
    },
    seiTestnet: {
      url: "https://evm-rpc-testnet.sei-apis.com",
      accounts: process.env.SEI_TESTNET_PRIVATE_KEY ? [process.env.SEI_TESTNET_PRIVATE_KEY] : [],
      chainId: 1328,
      gasPrice: 2000000000, // 2 gwei
      gas: 210000,
    },
    local: {
        url: "http://127.0.0.1:8545",
        accounts: process.env.LOCAL_PRIVATE_KEY ? [process.env.LOCAL_PRIVATE_KEY] : [],
        chainId: 1337,
    }
  },
};

export default config;
