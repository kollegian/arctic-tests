// Per-worker seid keyring isolation.
//
// Mocha --parallel forks N worker processes that share $HOME. seid's keyring
// lives at ${HOME}/.sei/keyring-test by default, so every worker's `seid keys
// add admin --recover` writes the same path concurrently and the loser gets
// "account already exists in keyring". Setting SEID_KEYRING_DIR per process
// gives each worker its own keyring directory and eliminates the race.
//
// Loaded via mocha --require so it runs at every worker's startup before any
// `seid` invocation. In serial mode the single process just gets one isolated
// directory — no behavioral change.

import * as fs from 'fs';

const dir = `/tmp/sei-keyring-${process.pid}`;
fs.mkdirSync(dir, { recursive: true });
process.env.SEID_KEYRING_DIR = dir;
