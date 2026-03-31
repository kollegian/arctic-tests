import {SeiUser, UserFactory} from "../../../shared/User";
import {ethers} from "ethers";
import {waitFor} from "../../../shared/utils/helpers";
import {Erc20Token} from "../../../shared/Token";
import {setCodeWithoutChecks} from "./utils";

describe('Sepolia tests', async () =>{
    const privKey = '0x77bd86ebe09b1bf9824c04c2d70128bd550b49b232b3f3e4fc2b5feee67da0e5';
    const rpcUrl = 'https://sepolia.infura.io/v3/7385403357dc4a5db6401f095a34d4f1';
    const accountImplementationAddress = '0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9';
    const erc20Address = '0x16AaB5ce8E7121C1FA31798F96414F792D16c649';
    let alice: SeiUser;
    let provider: ethers.JsonRpcProvider;
    let erc20: Erc20Token;
    before('Deploys evm stuff', async () => {
        provider = new ethers.JsonRpcProvider(rpcUrl);
        alice = await UserFactory.createAdminUser();
        alice.evmWallet.wallet = new ethers.Wallet(privKey, provider);
        alice.evmWallet.signingClient = provider;
        erc20 = new Erc20Token(alice, erc20Address);
    });
    it('Alice sets code for authorization', async function (){
        const { chainId } = await provider.getNetwork();
        const nonce = await provider.getTransactionCount(alice.evmWallet.wallet.address, 'pending');
        erc20 = new Erc20Token(alice, erc20Address);
        const authorization = await alice.evmWallet.wallet.authorize({
            address: accountImplementationAddress,
            chainId,
            nonce,
        });
        const code = await provider.getCode(alice.evmWallet.wallet.address);
        console.log(code);
        await setCodeWithoutChecks(alice, authorization)
        await waitFor(2);

        const setCode = await provider.getCode(alice.evmWallet.wallet.address);
        console.log(setCode);
    })
})
