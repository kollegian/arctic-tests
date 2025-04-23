import util from "node:util";
import {exec as execCallback} from "node:child_process";
import {waitFor} from "./helpers";
const exec = util.promisify(execCallback);

export async function execCommandAndReturnJson(command: string): Promise<any> {
    const { stdout } = await exec(`${command} --output json`);
    await waitFor(0.8);
    return JSON.parse(stdout);
}


