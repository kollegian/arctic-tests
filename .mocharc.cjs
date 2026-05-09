module.exports = {
    extension: ['ts'],
    require: ['ts-node/register/transpile-only', './bin/keyring-isolation.ts'],
    'global-setup': ['./bin/global-setup.ts'],
};
