// Opt-in switch for the tests that exercise the legacy sei_* / sei2_* JSON-RPC
// components.
//
// Those components are deprecated and being removed. sei-chain took most of
// them off main in #3924, #3927 and #3945, and the three that remain
// (sei_getSeiAddress, sei_getEVMAddress, sei_getCosmosTx) carry the same
// deprecation notice. A node also has to opt in per method through [evm]
// enabled_legacy_sei_apis in app.toml, and a removed method answers exactly
// like a disabled one — so a chain that serves them is now the exception.
//
// The suite therefore leaves these tests off. SEI_LEGACY_COMPONENTS=true turns
// them on, for a build known to serve the components: a release-line image, or
// a local node with the allowlist widened. They then assert rather than skip,
// so a missing component fails the run instead of passing quietly.
//
// Consumers call requireLegacyComponents(this) from a gated it(), or from a
// gated describe's before(). Mocha binds `this` only in a non-arrow function,
// so a gated block is written `function ()` or `async function ()`, never
// `() =>`.

const flag = 'SEI_LEGACY_COMPONENTS';

let logged = false;

/**
 * legacyComponentsEnabled reports whether this run exercises the legacy sei_*
 * components. Off unless SEI_LEGACY_COMPONENTS is set to true.
 */
export function legacyComponentsEnabled(): boolean {
    const raw = process.env[flag];
    const enabled = raw === 'true';
    if (raw !== undefined && raw !== '' && raw !== 'true' && raw !== 'false') {
        throw new Error(`${flag} must be 'true' or 'false', got '${raw}'.`);
    }
    if (!logged) {
        logged = true;
        console.log(`[sei-legacy-components] enabled=${enabled}`);
    }
    return enabled;
}

/**
 * requireLegacyComponents skips the calling mocha block unless this run
 * exercises the legacy sei_* components.
 */
export function requireLegacyComponents(ctx: Mocha.Context): void {
    if (!legacyComponentsEnabled()) ctx.skip();
}
