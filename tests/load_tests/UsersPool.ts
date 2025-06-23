import { SeiUser, UserFactory } from "../../shared/User";
import { Erc20Token } from "../../shared/Token";
import { waitFor } from "../../shared/utils/helpers";
import { CONFIG } from "./config";

export class UsersPool {
    private users: SeiUser[] = [];

    async init(admin: SeiUser) {
        this.users = await UserFactory.createSeiUsers(admin, CONFIG.TOTAL_USERS, true);
    }
    all() { return this.users; }

    async fundAll(erc20: Erc20Token) {
        let remaining = [...this.users];
        while (remaining.length) {
            await erc20.mintToUsers(remaining.splice(0, 50));
            await waitFor(1);
            console.log(`Minted to next batch (remaining: ${remaining.length})`);
        }
    }
}
