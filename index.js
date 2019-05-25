const Nimiq = require('@nimiq/core');
const argv = require('minimist')(process.argv.slice(2));
const config = require('./src/Config.js')(argv.config);

const PoolServer = require('./src/PoolServer.js');

const START = Date.now();
const TAG = 'Node';
const $ = {};

if (!config) {
    Nimiq.Log.e(TAG, 'Specify a valid config file with --config=FILE');
    process.exit(1);
}
if (config.type !== 'full') {
    Nimiq.Log.e(TAG, 'Pool server must run as a \'full\' node');
    process.exit(1);
}
// Deprecated dumb config flag.
if (config.dumb) {
    console.error(`The '--dumb' flag is deprecated, use '--protocol=dumb' instead.`);
    config.protocol = 'dumb';
}

Nimiq.Log.instance.level = config.log.level;
for (const tag in config.log.tags) {
    Nimiq.Log.instance.setLoggable(tag, config.log.tags[tag]);
}

for (const key in config.constantOverrides) {
    Nimiq.ConstantHelper.instance.set(key, config.constantOverrides[key]);
}

(async () => {
    Nimiq.Log.i(TAG, `Nimiq NodeJS Mining Pool starting (network=${config.network}`
        + `, ${config.host ? `host=${config.host}, port=${config.port}` : 'dumb'})`);

    Nimiq.GenesisConfig.init(Nimiq.GenesisConfig.CONFIGS[config.network]);

    for (const seedPeer of config.seedPeers) {
        let address;
        switch (seedPeer.protocol) {
            case 'ws':
                address = Nimiq.WsPeerAddress.seed(seedPeer.host, seedPeer.port, seedPeer.publicKey);
                break;
            case 'wss':
            default:
                address = Nimiq.WssPeerAddress.seed(seedPeer.host, seedPeer.port, seedPeer.publicKey);
                break;
        }
        Nimiq.GenesisConfig.SEED_PEERS.push(address);
    }

    let networkConfig;
    switch (config.protocol) {
        case 'wss':
            networkConfig = new Nimiq.WssNetworkConfig(config.host, config.port, config.tls.key, config.tls.cert, config.reverseProxy);
            break;
        case 'ws':
            networkConfig = new Nimiq.WsNetworkConfig(config.host, config.port, config.reverseProxy);
            break;
        case 'dumb':
            networkConfig = new Nimiq.DumbNetworkConfig();
            break;
    }

    switch (config.type) {
        case 'full':
            $.consensus = await Nimiq.Consensus.full(networkConfig);
            break;
        case 'light':
            $.consensus = await Nimiq.Consensus.light(networkConfig);
            break;
        case 'nano':
            $.consensus = await Nimiq.Consensus.nano(networkConfig);
            break;
    }

    $.blockchain = $.consensus.blockchain;
    $.accounts = $.blockchain.accounts;
    $.mempool = $.consensus.mempool;
    $.network = $.consensus.network;

    Nimiq.Log.i(TAG, `Peer address: ${networkConfig.peerAddress.toString()} - public key: ${networkConfig.keyPair.publicKey.toHex()}`);

    // TODO: Wallet key.
    $.walletStore = await new Nimiq.WalletStore();
    if (!config.pool.address) {
        // Load or create default wallet.
        $.wallet = await $.walletStore.getDefault();
    } else {
        const address = Nimiq.Address.fromUserFriendlyAddress(config.pool.address);
        $.wallet = {address: address};
        // Check if we have a full wallet in store.
        const wallet = await $.walletStore.get(address);
        if (wallet) {
            $.wallet = wallet;
            await $.walletStore.setDefault(wallet.address);
        }
    }

    const poolServer = new PoolServer($.consensus, config.pool, config.poolServer.port, config.poolServer.sslKeyPath, config.poolServer.sslCertPath, config.reverseProxy);

    process.on('SIGTERM', () => {
        poolServer.stop();
        process.exit(0);
    });
    process.on('SIGINT', () => {
        poolServer.stop();
        process.exit(0);
    });

    const addresses = await $.walletStore.list();
    Nimiq.Log.i(TAG, `Managing wallets [${addresses.map(address => address.toUserFriendlyAddress())}]`);

    const isNano = config.type === 'nano';
    const account = !isNano ? await $.accounts.get($.wallet.address) : null;
    Nimiq.Log.i(TAG, `Wallet initialized for address ${$.wallet.address.toUserFriendlyAddress()}.`
        + (!isNano ? ` Balance: ${Nimiq.Policy.satoshisToCoins(account.balance)} NIM` : ''));

    Nimiq.Log.i(TAG, `Blockchain state: height=${$.blockchain.height}, headHash=${$.blockchain.headHash}`);

    $.blockchain.on('head-changed', (head) => {
        if ($.consensus.established || head.height % 100 === 0) {
            Nimiq.Log.i(TAG, `Now at block: ${head.height}`);
        }
    });

    $.network.on('peer-joined', (peer) => {
        Nimiq.Log.i(TAG, `Connected to ${peer.peerAddress.toString()}`);
    });

    $.consensus.on('established', () => {
        Nimiq.Log.i(TAG, `Blockchain ${config.type}-consensus established in ${(Date.now() - START) / 1000}s.`);
        Nimiq.Log.i(TAG, `Current state: height=${$.blockchain.height}, totalWork=${$.blockchain.totalWork}, headHash=${$.blockchain.headHash}`);
    });

    $.network.connect();
})().catch(e => {
    console.error(e);
    process.exit(1);
});
