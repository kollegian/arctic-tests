import { ethers } from 'ethers';

const privateKey = process.argv[2] || '0x2bd96f4b341d7e26afbfabafdaae89b6c67cdd8076517181d11b30faa2412f8e';

const wallet = new ethers.Wallet(privateKey);
console.log(wallet.address);
