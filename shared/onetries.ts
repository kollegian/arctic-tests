import {UserFactory} from './User';
import testConfig from '../config/testConfig.json'
import {ethers} from 'ethers';
import ERC20_ARTIFACT from '../artifacts/contracts/TestERC20.sol/TestERC20.json';

const main = async () => {
  const admin = await UserFactory.createAdminUser(testConfig);
  const contractAddress = '0x3894085ef7ff0f0aedf52e2a2704928d1ec074f1';

  const contract = new ethers.Contract(contractAddress, ERC20_ARTIFACT.abi, admin.evmWallet.wallet);
  const contractName = await contract.name();
  console.log(contractName);
}

main();