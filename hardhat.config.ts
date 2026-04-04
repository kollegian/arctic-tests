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
      accounts: ["0x2bd96f4b341d7e26afbfabafdaae89b6c67cdd8076517181d11b30faa2412f8e"],
      chainId: 1328,
      gasPrice: 2000000000, // 2 gwei
      gas: 210000,
    },
    local: {
        url: "http://127.0.0.1:8545",
        accounts: ["0x2bd96f4b341d7e26afbfabafdaae89b6c67cdd8076517181d11b30faa2412f8e"],
        chainId: 1337,
    }
  },
};

export default config;
