'use strict';

const { jidDecode, jidNormalizedUser, isLidUser, isPnUser } = require('./jid-utils');

class LIDMappingStore {
    constructor(keys, logger, pnToLIDFunc) {
        this.cache = new Map();
        this.keys = keys;
        this.logger = logger || console;
        this.pnToLIDFunc = pnToLIDFunc || null;
    }

    async storeLIDPNMappings(pairs) {
        const pairMap = {};
        for (const { lid, pn } of pairs) {
            if (!((isLidUser(lid) && isPnUser(pn)) || (isPnUser(lid) && isLidUser(pn)))) {
                this.logger.warn?.(`Invalid LID-PN mapping: ${lid}, ${pn}`) ||
                    this.logger.log?.(`Invalid LID-PN mapping: ${lid}, ${pn}`);
                continue;
            }

            const lidDecoded = jidDecode(isLidUser(lid) ? lid : pn);
            const pnDecoded = jidDecode(isPnUser(pn) ? pn : lid);
            if (!lidDecoded || !pnDecoded) continue;

            const pnUser = pnDecoded.user;
            const lidUser = lidDecoded.user;

            let existingLidUser = this.cache.get(`pn:${pnUser}`);
            if (!existingLidUser) {
                const stored = await this.keys.get('lid-mapping', [pnUser]);
                existingLidUser = stored[pnUser];
                if (existingLidUser) {
                    this.cache.set(`pn:${pnUser}`, existingLidUser);
                    this.cache.set(`lid:${existingLidUser}`, pnUser);
                }
            }

            if (existingLidUser === lidUser) continue;

            pairMap[pnUser] = lidUser;
        }

        if (Object.keys(pairMap).length === 0) return;

        await this.keys.transaction(async () => {
            for (const [pnUser, lidUser] of Object.entries(pairMap)) {
                await this.keys.set({
                    'lid-mapping': {
                        [pnUser]: lidUser,
                        [`${lidUser}_reverse`]: pnUser
                    }
                });
                this.cache.set(`pn:${pnUser}`, lidUser);
                this.cache.set(`lid:${lidUser}`, pnUser);
            }
        }, 'lid-mapping');
    }

    async getLIDForPN(pn) {
        const results = await this.getLIDsForPNs([pn]);
        return results?.[0]?.lid || null;
    }

    async getLIDsForPNs(pns) {
        const usyncFetch = {};
        const successfulPairs = {};

        for (const pn of pns) {
            if (!isPnUser(pn)) continue;

            const decoded = jidDecode(pn);
            if (!decoded) continue;

            const pnUser = decoded.user;
            let lidUser = this.cache.get(`pn:${pnUser}`);

            if (!lidUser) {
                const stored = await this.keys.get('lid-mapping', [pnUser]);
                lidUser = stored[pnUser];
                if (lidUser) {
                    this.cache.set(`pn:${pnUser}`, lidUser);
                    this.cache.set(`lid:${lidUser}`, pnUser);
                } else {
                    const device = decoded.device || 0;
                    const normalizedPn = jidNormalizedUser(pn);
                    if (!usyncFetch[normalizedPn]) {
                        usyncFetch[normalizedPn] = [device];
                    } else {
                        usyncFetch[normalizedPn].push(device);
                    }
                    continue;
                }
            }

            lidUser = lidUser.toString();
            if (!lidUser) continue;

            const pnDevice = decoded.device !== undefined ? decoded.device : 0;
            const deviceSpecificLid = `${lidUser}${pnDevice ? `:${pnDevice}` : ''}@lid`;

            successfulPairs[pn] = { lid: deviceSpecificLid, pn };
        }

        if (Object.keys(usyncFetch).length > 0 && this.pnToLIDFunc) {
            const result = await this.pnToLIDFunc(Object.keys(usyncFetch));
            if (result && result.length > 0) {
                await this.storeLIDPNMappings(result);
                for (const pair of result) {
                    const pnDecoded = jidDecode(pair.pn);
                    const pnUser = pnDecoded?.user;
                    if (!pnUser) continue;

                    const lidUser = jidDecode(pair.lid)?.user;
                    if (!lidUser) continue;

                    for (const device of (usyncFetch[pair.pn] || [])) {
                        const deviceSpecificLid = `${lidUser}${device ? `:${device}` : ''}@lid`;
                        const deviceSpecificPn = `${pnUser}${device ? `:${device}` : ''}@s.whatsapp.net`;
                        successfulPairs[deviceSpecificPn] = { lid: deviceSpecificLid, pn: deviceSpecificPn };
                    }
                }
            } else {
                return null;
            }
        }

        return Object.values(successfulPairs);
    }

    async getPNForLID(lid) {
        if (!isLidUser(lid)) return null;

        const decoded = jidDecode(lid);
        if (!decoded) return null;

        const lidUser = decoded.user;
        let pnUser = this.cache.get(`lid:${lidUser}`);

        if (!pnUser) {
            const stored = await this.keys.get('lid-mapping', [`${lidUser}_reverse`]);
            pnUser = stored[`${lidUser}_reverse`];
            if (!pnUser) return null;
            this.cache.set(`lid:${lidUser}`, pnUser);
        }

        const lidDevice = decoded.device !== undefined ? decoded.device : 0;
        return `${pnUser}${lidDevice ? `:${lidDevice}` : ''}@s.whatsapp.net`;
    }
}

module.exports = {
    LIDMappingStore
};
