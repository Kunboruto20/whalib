'use strict';

const {
    getBinaryNodeChild,
    getBinaryNodeChildren,
    getBinaryNodeChildBuffer,
    assertNodeErrorFree
} = require('./binary-node');

function getBinaryNodeChildString(node, tag) {
    const child = getBinaryNodeChild(node, tag);
    if (!child) return undefined;
    if (typeof child.content === 'string') return child.content;
    if (Buffer.isBuffer(child.content)) return child.content.toString('utf-8');
    if (child.content instanceof Uint8Array) return Buffer.from(child.content).toString('utf-8');
    return undefined;
}

class USyncUser {
    withId(id) {
        this.id = id;
        return this;
    }

    withLid(lid) {
        this.lid = lid;
        return this;
    }

    withPhone(phone) {
        this.phone = phone;
        return this;
    }

    withType(type) {
        this.type = type;
        return this;
    }

    withPersonaId(personaId) {
        this.personaId = personaId;
        return this;
    }
}

class USyncContactProtocol {
    constructor() {
        this.name = 'contact';
    }

    getQueryElement() {
        return { tag: 'contact', attrs: {} };
    }

    getUserElement(user) {
        return { tag: 'contact', attrs: {}, content: user.phone };
    }

    parser(node) {
        if (node.tag === 'contact') {
            assertNodeErrorFree(node);
            return node?.attrs?.type === 'in';
        }
        return false;
    }
}

class USyncDeviceProtocol {
    constructor() {
        this.name = 'devices';
    }

    getQueryElement() {
        return { tag: 'devices', attrs: { version: '2' } };
    }

    getUserElement() {
        return null;
    }

    parser(node) {
        const deviceList = [];
        let keyIndex = undefined;
        if (node.tag === 'devices') {
            assertNodeErrorFree(node);
            const deviceListNode = getBinaryNodeChild(node, 'device-list');
            const keyIndexNode = getBinaryNodeChild(node, 'key-index-list');
            if (Array.isArray(deviceListNode?.content)) {
                for (const { tag, attrs } of deviceListNode.content) {
                    const id = +attrs.id;
                    const ki = +attrs['key-index'];
                    if (tag === 'device') {
                        deviceList.push({
                            id,
                            keyIndex: ki,
                            isHosted: !!(attrs['is_hosted'] && attrs['is_hosted'] === 'true')
                        });
                    }
                }
            }
            if (keyIndexNode?.tag === 'key-index-list') {
                keyIndex = {
                    timestamp: +keyIndexNode.attrs['ts'],
                    signedKeyIndex: keyIndexNode?.content,
                    expectedTimestamp: keyIndexNode.attrs['expected_ts'] ? +keyIndexNode.attrs['expected_ts'] : undefined
                };
            }
        }
        return { deviceList, keyIndex };
    }
}

class USyncStatusProtocol {
    constructor() {
        this.name = 'status';
    }

    getQueryElement() {
        return { tag: 'status', attrs: {} };
    }

    getUserElement() {
        return null;
    }

    parser(node) {
        if (node.tag === 'status') {
            assertNodeErrorFree(node);
            let status = node?.content?.toString() ?? null;
            const setAt = new Date(+(node?.attrs.t || 0) * 1000);
            if (!status) {
                if (node.attrs?.code && +node.attrs.code === 401) {
                    status = '';
                } else {
                    status = null;
                }
            } else if (typeof status === 'string' && status.length === 0) {
                status = null;
            }
            return { status, setAt };
        }
    }
}

class USyncDisappearingModeProtocol {
    constructor() {
        this.name = 'disappearing_mode';
    }

    getQueryElement() {
        return { tag: 'disappearing_mode', attrs: {} };
    }

    getUserElement() {
        return null;
    }

    parser(node) {
        if (node.tag === 'disappearing_mode') {
            assertNodeErrorFree(node);
            const duration = +node?.attrs.duration;
            const setAt = new Date(+(node?.attrs.t || 0) * 1000);
            return { duration, setAt };
        }
    }
}

class USyncLIDProtocol {
    constructor() {
        this.name = 'lid';
    }

    getQueryElement() {
        return { tag: 'lid', attrs: {} };
    }

    getUserElement(user) {
        if (user.lid) {
            return { tag: 'lid', attrs: { jid: user.lid } };
        }
        return null;
    }

    parser(node) {
        if (node.tag === 'lid') {
            return node.attrs.val;
        }
        return null;
    }
}

class USyncBotProfileProtocol {
    constructor() {
        this.name = 'bot';
    }

    getQueryElement() {
        return {
            tag: 'bot',
            attrs: {},
            content: [{ tag: 'profile', attrs: { v: '1' } }]
        };
    }

    getUserElement(user) {
        return {
            tag: 'bot',
            attrs: {},
            content: [{ tag: 'profile', attrs: { persona_id: user.personaId } }]
        };
    }

    parser(node) {
        const botNode = getBinaryNodeChild(node, 'bot');
        const profile = getBinaryNodeChild(botNode, 'profile');
        const commandsNode = getBinaryNodeChild(profile, 'commands');
        const promptsNode = getBinaryNodeChild(profile, 'prompts');
        const commands = [];
        const prompts = [];
        for (const command of getBinaryNodeChildren(commandsNode, 'command')) {
            commands.push({
                name: getBinaryNodeChildString(command, 'name'),
                description: getBinaryNodeChildString(command, 'description')
            });
        }
        for (const prompt of getBinaryNodeChildren(promptsNode, 'prompt')) {
            prompts.push(`${getBinaryNodeChildString(prompt, 'emoji')} ${getBinaryNodeChildString(prompt, 'text')}`);
        }
        return {
            isDefault: !!getBinaryNodeChild(profile, 'default'),
            jid: node.attrs.jid,
            name: getBinaryNodeChildString(profile, 'name'),
            attributes: getBinaryNodeChildString(profile, 'attributes'),
            description: getBinaryNodeChildString(profile, 'description'),
            category: getBinaryNodeChildString(profile, 'category'),
            personaId: profile.attrs['persona_id'],
            commandsDescription: getBinaryNodeChildString(commandsNode, 'description'),
            commands,
            prompts
        };
    }
}

class USyncQuery {
    constructor() {
        this.protocols = [];
        this.users = [];
        this.context = 'interactive';
        this.mode = 'query';
    }

    withMode(mode) {
        this.mode = mode;
        return this;
    }

    withContext(context) {
        this.context = context;
        return this;
    }

    withUser(user) {
        this.users.push(user);
        return this;
    }

    withContactProtocol() {
        this.protocols.push(new USyncContactProtocol());
        return this;
    }

    withDeviceProtocol() {
        this.protocols.push(new USyncDeviceProtocol());
        return this;
    }

    withStatusProtocol() {
        this.protocols.push(new USyncStatusProtocol());
        return this;
    }

    withDisappearingModeProtocol() {
        this.protocols.push(new USyncDisappearingModeProtocol());
        return this;
    }

    withLIDProtocol() {
        this.protocols.push(new USyncLIDProtocol());
        return this;
    }

    withBotProfileProtocol() {
        this.protocols.push(new USyncBotProfileProtocol());
        return this;
    }

    toQueryNode() {
        const queryContent = this.protocols
            .map(p => p.getQueryElement())
            .filter(Boolean);

        const userNodes = this.users.map(user => {
            const userContent = this.protocols
                .map(p => p.getUserElement(user))
                .filter(Boolean);

            const attrs = {};
            if (user.id) attrs.jid = user.id;

            return {
                tag: 'user',
                attrs,
                content: userContent.length > 0 ? userContent : undefined
            };
        });

        return {
            tag: 'iq',
            attrs: {
                to: 's.whatsapp.net',
                type: 'get',
                xmlns: 'usync'
            },
            content: [
                {
                    tag: 'usync',
                    attrs: {
                        sid: Date.now().toString(),
                        mode: this.mode,
                        last: 'true',
                        index: '0',
                        context: this.context
                    },
                    content: [
                        {
                            tag: 'query',
                            attrs: {},
                            content: queryContent
                        },
                        {
                            tag: 'list',
                            attrs: {},
                            content: userNodes
                        }
                    ]
                }
            ]
        };
    }

    parseUSyncQueryResult(result) {
        if (!result || result.attrs.type !== 'result') {
            return;
        }

        const protocolMap = Object.fromEntries(
            this.protocols.map(protocol => [protocol.name, protocol.parser.bind(protocol)])
        );

        const queryResult = {
            list: [],
            sideList: []
        };

        const usyncNode = getBinaryNodeChild(result, 'usync');
        const listNode = usyncNode ? getBinaryNodeChild(usyncNode, 'list') : undefined;

        if (listNode?.content && Array.isArray(listNode.content)) {
            queryResult.list = listNode.content.reduce((acc, node) => {
                const id = node?.attrs.jid;
                if (id) {
                    const data = Array.isArray(node?.content)
                        ? Object.fromEntries(
                            node.content
                                .map(content => {
                                    const protocol = content.tag;
                                    const parser = protocolMap[protocol];
                                    if (parser) {
                                        return [protocol, parser(content)];
                                    }
                                    return [protocol, null];
                                })
                                .filter(([, b]) => b !== null)
                        )
                        : {};
                    acc.push({ ...data, id });
                }
                return acc;
            }, []);
        }

        const sideListNode = usyncNode ? getBinaryNodeChild(usyncNode, 'side_list') : undefined;
        if (sideListNode?.content && Array.isArray(sideListNode.content)) {
            queryResult.sideList = sideListNode.content.reduce((acc, node) => {
                const id = node?.attrs.jid;
                if (id) {
                    const data = Array.isArray(node?.content)
                        ? Object.fromEntries(
                            node.content
                                .map(content => {
                                    const protocol = content.tag;
                                    const parser = protocolMap[protocol];
                                    if (parser) {
                                        return [protocol, parser(content)];
                                    }
                                    return [protocol, null];
                                })
                                .filter(([, b]) => b !== null)
                        )
                        : {};
                    acc.push({ ...data, id });
                }
                return acc;
            }, []);
        }

        return queryResult;
    }
}

function executeUSyncQuery(sendIq) {
    return async function(query) {
        const node = query.toQueryNode();
        const result = await sendIq(node);
        return query.parseUSyncQueryResult(result);
    };
}

module.exports = {
    USyncQuery,
    USyncUser,
    USyncContactProtocol,
    USyncDeviceProtocol,
    USyncStatusProtocol,
    USyncDisappearingModeProtocol,
    USyncLIDProtocol,
    USyncBotProfileProtocol,
    getBinaryNodeChildString,
    executeUSyncQuery
};
