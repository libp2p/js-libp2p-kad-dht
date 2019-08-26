/**
 * Random walk options
 *
 * @typedef {Object} randomWalkOptions
 * @property {boolean} enabled discovery enabled (default: true)
 * @property {number} queriesPerPeriod how many queries to run per period (default: 1)
 * @property {number} interval how often to run the the random-walk process, in milliseconds (default: 300000)
 * @property {number} timeout how long to wait for the the random-walk query to run, in milliseconds (default: 30000)
 * @property {number} delay how long to wait before starting the first random walk, in milliseconds (default: 10000)
 */
declare type randomWalkOptions = {
    enabled: boolean;
    queriesPerPeriod: number;
    interval: number;
    timeout: number;
    delay: number;
};

/**
 * Create a new KadDHT.
 *
 * @param {Switch} sw libp2p-switch instance
 * @param {object} options DHT options
 * @param {number} options.kBucketSize k-bucket size (default 20)
 * @param {number} options.concurrency alpha concurrency of queries (default 3)
 * @param {Datastore} options.datastore datastore (default MemoryDatastore)
 * @param {object} options.validators validators object with namespace as keys and function(key, record, callback)
 * @param {object} options.selectors selectors object with namespace as keys and function(key, records)
 * @param {randomWalkOptions} options.randomWalk randomWalk options
 */
declare class KadDHT {
    constructor(sw: Switch, options: {
        kBucketSize: number;
        concurrency: number;
        datastore: Datastore;
        validators: any;
        selectors: any;
        randomWalk: randomWalkOptions;
    });
    /**
     * Local reference to the libp2p-switch instance
     *
     * @type {Switch}
     */
    switch: Switch;
    /**
     * k-bucket size, defaults to 20
     *
     * @type {number}
     */
    kBucketSize: number;
    /**
     * ALPHA concurrency at which each query path with run, defaults to 3
     * @type {number}
     */
    concurrency: number;
    /**
     * Number of disjoint query paths to use
     * This is set to `kBucketSize`/2 per the S/Kademlia paper
     * @type {number}
     */
    disjointPaths: number;
    /**
     * The routing table.
     *
     * @type {RoutingTable}
     */
    routingTable: RoutingTable;
    /**
     * Reference to the datastore, uses an in-memory store if none given.
     *
     * @type {Datastore}
     */
    datastore: Datastore;
    /**
     * Provider management
     *
     * @type {Providers}
     */
    providers: Providers;
    /**
     * Random walk management
     *
     * @type {RandomWalk}
     */
    randomWalk: RandomWalk;
    /**
     * Keeps track of running queries
     *
     * @type {QueryManager}
     */
    _queryManager: QueryManager;
    /**
     * Is this DHT running.
     *
     * @type {bool}
     */
    isStarted: boolean;
    /**
     * Start listening to incoming connections.
     *
     * @param {function(Error)} callback
     * @returns {void}
     */
    start(callback: (...params: any[]) => any): void;
    /**
     * Stop accepting incoming connections and sending outgoing
     * messages.
     *
     * @param {function(Error)} callback
     * @returns {void}
     */
    stop(callback: (...params: any[]) => any): void;
    /**
     * Local peer (yourself)
     *
     * @type {PeerInfo}
     */
    peerInfo: PeerInfo;
    /**
     * Store the given key/value  pair in the DHT.
     *
     * @param {Buffer} key
     * @param {Buffer} value
     * @param {Object} options - get options
     * @param {number} options.minPeers - minimum peers that must be put to to consider this a successful operation
     * (default: closestPeers.length)
     * @param {function(Error)} callback
     * @returns {void}
     */
    put(key: Buffer, value: Buffer, options: {
        minPeers: number;
    }, callback: (...params: any[]) => any): void;
    /**
     * Get the value to the given key.
     * Times out after 1 minute.
     *
     * @param {Buffer} key
     * @param {Object} options - get options
     * @param {number} options.timeout - optional timeout (default: 60000)
     * @param {function(Error, Buffer)} callback
     * @returns {void}
     */
    get(key: Buffer, options: {
        timeout: number;
    }, callback: (...params: any[]) => any): void;
    /**
     * Get the `n` values to the given key without sorting.
     *
     * @param {Buffer} key
     * @param {number} nvals
     * @param {Object} options - get options
     * @param {number} options.timeout - optional timeout (default: 60000)
     * @param {function(Error, Array<{from: PeerId, val: Buffer}>)} callback
     * @returns {void}
     */
    getMany(key: Buffer, nvals: number, options: {
        timeout: number;
    }, callback: (...params: any[]) => any): void;
    /**
     * Kademlia 'node lookup' operation.
     *
     * @param {Buffer} key
     * @param {Object} options
     * @param {boolean} options.shallow shallow query
     * @param {function(Error, Array<PeerId>)} callback
     * @returns {void}
     */
    getClosestPeers(key: Buffer, options: {
        shallow: boolean;
    }, callback: (...params: any[]) => any): void;
    /**
     * Get the public key for the given peer id.
     *
     * @param {PeerId} peer
     * @param {function(Error, PubKey)} callback
     * @returns {void}
     */
    getPublicKey(peer: PeerId, callback: (...params: any[]) => any): void;
    /**
     * Look if we are connected to a peer with the given id.
     * Returns the `PeerInfo` for it, if found, otherwise `undefined`.
     *
     * @param {PeerId} peer
     * @param {function(Error, PeerInfo)} callback
     * @returns {void}
     */
    findPeerLocal(peer: PeerId, callback: (...params: any[]) => any): void;
    /**
     * Announce to the network that we can provide given key's value.
     *
     * @param {CID} key
     * @param {function(Error)} callback
     * @returns {void}
     */
    provide(key: CID, callback: (...params: any[]) => any): void;
    /**
     * Search the dht for up to `K` providers of the given CID.
     *
     * @param {CID} key
     * @param {Object} options - findProviders options
     * @param {number} options.timeout - how long the query should maximally run, in milliseconds (default: 60000)
     * @param {number} options.maxNumProviders - maximum number of providers to find
     * @param {function(Error, Array<PeerInfo>)} callback
     * @returns {void}
     */
    findProviders(key: CID, options: {
        timeout: number;
        maxNumProviders: number;
    }, callback: (...params: any[]) => any): void;
    /**
     * Search for a peer with the given ID.
     *
     * @param {PeerId} id
     * @param {Object} options - findPeer options
     * @param {number} options.timeout - how long the query should maximally run, in milliseconds (default: 60000)
     * @param {function(Error, PeerInfo)} callback
     * @returns {void}
     */
    findPeer(id: PeerId, options: {
        timeout: number;
    }, callback: (...params: any[]) => any): void;
}

/**
 * Create a new limited peer list.
 *
 * @param {number} limit
 */
declare class LimitedPeerList {
    constructor(limit: number);
    /**
     * Add a PeerInfo if it fits in the list
     *
     * @param {PeerInfo} info
     * @returns {bool}
     */
    push(info: PeerInfo): boolean;
}

/**
 * @param {MessageType} type
 * @param {Buffer} key
 * @param {number} level
 */
declare class Message {
    constructor(type: MessageType, key: Buffer, level: number);
    /**
     * @type {number}
     */
    clusterLevel: number;
    /**
     * Encode into protobuf
     * @returns {Buffer}
     */
    serialize(): Buffer;
    /**
     * Decode from protobuf
     *
     * @param {Buffer} raw
     * @returns {Message}
     */
    static deserialize(raw: Buffer): Message;
}

/**
 * Create a new network.
 *
 * @param {KadDHT} self
 */
declare class Network {
    constructor(self: KadDHT);
    /**
     * Start the network.
     *
     * @param {function(Error)} callback
     * @returns {void}
     */
    start(callback: (...params: any[]) => any): void;
    /**
     * Stop all network activity.
     *
     * @param {function(Error)} callback
     * @returns {void}
     */
    stop(callback: (...params: any[]) => any): void;
    /**
     * Is the network online?
     *
     * @type {bool}
     */
    isStarted: boolean;
    /**
     * Are all network components there?
     *
     * @type {bool}
     */
    isConnected: boolean;
    /**
     * Send a request and record RTT for latency measurements.
     *
     * @param {PeerId} to - The peer that should receive a message
     * @param {Message} msg - The message to send.
     * @param {function(Error, Message)} callback
     * @returns {void}
     */
    sendRequest(to: PeerId, msg: Message, callback: (...params: any[]) => any): void;
    /**
     * Sends a message without expecting an answer.
     *
     * @param {PeerId} to
     * @param {Message} msg
     * @param {function(Error)} callback
     * @returns {void}
     */
    sendMessage(to: PeerId, msg: Message, callback: (...params: any[]) => any): void;
}

/**
 * Creates a new PeerDistanceList.
 *
 * @param {Buffer} originDhtKey - the DHT key from which distance is calculated
 * @param {number} capacity - the maximum size of the list
 */
declare class PeerDistanceList {
    constructor(originDhtKey: Buffer, capacity: number);
    /**
     * @method
     * @returns {number}
     * The length of the list
     */
    length(): number;
    /**
     * @method
     *
     * @returns {Array<String>}
     * The peerIds in the list, in order of distance from the origin key
     */
    peers(): String[];
    /**
     * Add a peerId to the list.
     *
     * @param {PeerId} peerId
     * @param {function(Error)} callback
     * @returns {void}
     */
    add(peerId: PeerId, callback: (...params: any[]) => any): void;
    /**
     * Indicates whether any of the peerIds passed as a parameter are closer
     * to the origin key than the furthest peerId in the PeerDistanceList.
     *
     * @param {Array<PeerId>} peerIds
     * @param {function(Error, Boolean)} callback
     * @returns {void}
     */
    anyCloser(peerIds: PeerId[], callback: (...params: any[]) => any): void;
}

declare class PeerList {
    /**
     * Add a new info. Returns `true` if it was a new one
     *
     * @param {PeerInfo} info
     * @returns {bool}
     */
    push(info: PeerInfo): boolean;
    /**
     * Check if this PeerInfo is already in here.
     *
     * @param {PeerInfo} info
     * @returns {bool}
     */
    has(info: PeerInfo): boolean;
    /**
     * Get the list as an array.
     *
     * @returns {Array<PeerInfo>}
     */
    toArray(): PeerInfo[];
    /**
     * Remove the last element
     *
     * @returns {PeerInfo}
     */
    pop(): PeerInfo;
    /**
     * The length of the list
     *
     * @type {number}
     */
    length: number;
}

/**
 * Create a new PeerQueue.
 *
 * @param {Buffer} from - The sha2-256 encoded peer id
 */
declare class PeerQueue {
    constructor(from: Buffer);
    /**
     * Create from a given peer id.
     *
     * @param {PeerId} id
     * @returns {Promise<PeerQueue>}
     */
    static fromPeerId(id: PeerId): Promise<PeerQueue>;
    /**
     * Create from a given buffer.
     *
     * @param {Buffer} keyBuffer
     * @returns {Promise<PeerQueue>}
     */
    static fromKey(keyBuffer: Buffer): Promise<PeerQueue>;
    /**
     * Add a new PeerId to the queue.
     *
     * @param {PeerId} id
     * @returns {Promise}
     */
    enqueue(id: PeerId): Promise;
    /**
     * Returns the closest peer to the `from` peer.
     *
     * @returns {PeerId}
     */
    dequeue(): PeerId;
}

/**
 * @param {Object} datastore
 * @param {PeerId} [self]
 * @param {number} [cacheSize=256]
 */
declare class Providers {
    constructor(datastore: any, self?: PeerId, cacheSize?: number);
    /**
     * How often invalid records are cleaned. (in seconds)
     *
     * @type {number}
     */
    cleanupInterval: number;
    /**
     * How long is a provider valid for. (in seconds)
     *
     * @type {number}
     */
    provideValidity: number;
    /**
     * LRU cache size
     *
     * @type {number}
     */
    lruCacheSize: number;
    /**
     * Release any resources.
     *
     * @returns {undefined}
     */
    stop(): undefined;
    /**
     * Add a new provider for the given CID.
     *
     * @param {CID} cid
     * @param {PeerId} provider
     * @returns {Promise}
     */
    addProvider(cid: CID, provider: PeerId): Promise;
    /**
     * Get a list of providers for the given CID.
     *
     * @param {CID} cid
     * @returns {Promise<Array<PeerId>>}
     */
    getProviders(cid: CID): Promise<PeerId[]>;
}

/**
 * User-supplied function to set up an individual disjoint path. Per-path
 * query state should be held in this function's closure.
 * @typedef {function} makePath
 * @param {number} pathNum - Numeric index from zero to numPaths - 1
 * @returns {queryFunc} - Function to call on each peer in the query
 */
declare type makePath = (pathNum: number) => queryFunc;

/**
 * Query function.
 * @typedef {function} queryFunc
 * @param {PeerId} next - Peer to query
 * @param {function(Error, Object)} callback - Query result callback
 */
declare type queryFunc = (next: PeerId, callback: (...params: any[]) => any) => void;

/**
 * Create a new query. The makePath function is called once per disjoint path, so that per-path
 * variables can be created in that scope. makePath then returns the actual query function (queryFunc) to
 * use when on that path.
 *
 * @param {DHT} dht - DHT instance
 * @param {Buffer} key
 * @param {makePath} makePath - Called to set up each disjoint path. Must return the query function.
 */
declare class Query {
    constructor(dht: DHT, key: Buffer, makePath: makePath);
    /**
     * Run this query, start with the given list of peers first.
     *
     * @param {Array<PeerId>} peers
     * @returns {Promise}
     */
    run(peers: PeerId[]): Promise;
    /**
     * Called when the run starts.
     */
    _onStart(): void;
    /**
     * Called when the run completes (even if there's an error).
     */
    _onComplete(): void;
    /**
     * Stop the query.
     */
    stop(): void;
}

/**
 * Creates a Path.
 *
 * @param {Run} run
 * @param {queryFunc} queryFunc
 */
declare class Path {
    constructor(run: Run, queryFunc: queryFunc);
    /**
     * @type {Array<PeerId>}
     */
    initialPeers: PeerId[];
    /**
     * @type {PeerQueue}
     */
    peersToQuery: PeerQueue;
    /**
     * Add a peer to the set of peers that are used to intialize the path.
     *
     * @param {PeerId} peer
     */
    addInitialPeer(peer: PeerId): void;
    /**
     * Execute the path.
     *
     * @returns {Promise}
     *
     */
    execute(): Promise;
    /**
     * Add a peer to the peers to be queried.
     *
     * @param {PeerId} peer
     * @returns {Promise<void>}
     */
    addPeerToQuery(peer: PeerId): Promise<void>;
}

/**
 * Creates a Run.
 *
 * @param {Query} query
 */
declare class Run {
    constructor(query: Query);
    /**
     * Stop all the workers
     */
    stop(): void;
    /**
     * Execute the run with the given initial set of peers.
     *
     * @param {Array<PeerId>} peers
     * @returns {Promise}
     */
    execute(peers: PeerId[]): Promise;
    /**
     * Execute all paths through the DHT.
     *
     * @param {Array<Path>} paths
     * @returns {Promise<void>}
     */
    executePaths(paths: Path[]): Promise<void>;
    /**
     * Initialize the list of queried peers, then start a worker queue for the
     * given path.
     *
     * @param {Path} path
     * @returns {Promise<void>}
     */
    workerQueue(path: Path): Promise<void>;
    /**
     * Create and start a worker queue for a particular path.
     *
     * @param {Path} path
     * @returns {Promise<void>}
     */
    startWorker(path: Path): Promise<void>;
    /**
     * Initialize the list of closest peers we've queried - this is shared by all
     * paths in the run.
     *
     * @returns {Promise<void>}
     */
    init(): Promise<void>;
    /**
     * If we've queried K peers, and the remaining peers in the given `worker`'s queue
     * are all further from the key than the peers we've already queried, then we should
     * stop querying on that `worker`.
     *
     * @param {WorkerQueue} worker
     * @returns {Promise<Boolean>}
     */
    continueQuerying(worker: WorkerQueue): Promise<Boolean>;
}

/**
 * Creates a new WorkerQueue.
 *
 * @param {DHT} dht
 * @param {Run} run
 * @param {Object} path
 * @param {function} log
 */
declare class WorkerQueue {
    constructor(dht: DHT, run: Run, path: any, log: (...params: any[]) => any);
    /**
     * Create the underlying async queue.
     *
     * @returns {Object}
     */
    setupQueue(): any;
    /**
     * Stop the worker, optionally providing an error to pass to the worker's
     * callback.
     *
     * @param {Error} err
     */
    stop(err: Error): void;
    /**
     * Use the queue from async to keep `concurrency` amount items running
     * per path.
     *
     * @return {Promise<void>}
     */
    execute(): Promise<void>;
    /**
     * Add peers to the worker queue until there are enough to satisfy the
     * worker queue concurrency.
     * Note that we don't want to take any more than those required to satisfy
     * concurrency from the peers-to-query queue, because we always want to
     * query the closest peers to the key first, and new peers are continously
     * being added to the peers-to-query queue.
     */
    fill(): void;
    /**
     * Process the next peer in the queue
     *
     * @param {PeerId} peer
     * @returns {Promise<void>}
     */
    processNext(peer: PeerId): Promise<void>;
}

/**
 * Creates a new QueryManager.
 */
declare class QueryManager {
    /**
     * Called when a query is started.
     *
     * @param {Query} query
     */
    queryStarted(query: Query): void;
    /**
     * Called when a query completes.
     *
     * @param {Query} query
     */
    queryCompleted(query: Query): void;
    /**
     * Starts the query manager.
     */
    start(): void;
    /**
     * Stops all queries.
     */
    stop(): void;
}

/**
 * @constructor
 * @param {DHT} dht
 * @param {object} options
 * @param {randomWalkOptions.enabled} options.enabled
 * @param {randomWalkOptions.queriesPerPeriod} options.queriesPerPeriod
 * @param {randomWalkOptions.interval} options.interval
 * @param {randomWalkOptions.timeout} options.timeout
 * @param {randomWalkOptions.delay} options.delay
 * @param {DHT} options.dht
 */
declare class RandomWalk {
    constructor(dht: DHT, options: {
        enabled: randomWalkOptions.enabled;
        queriesPerPeriod: randomWalkOptions.queriesPerPeriod;
        interval: randomWalkOptions.interval;
        timeout: randomWalkOptions.timeout;
        delay: randomWalkOptions.delay;
        dht: DHT;
    });
    /**
     * Start the Random Walk process. This means running a number of queries
     * every interval requesting random data. This is done to keep the dht
     * healthy over time.
     *
     * @returns {void}
     */
    start(): void;
    /**
     * Stop the random-walk process. Any active
     * queries will be aborted.
     *
     * @returns {void}
     */
    stop(): void;
}

/**
 * @param {PeerId} self
 * @param {number} kBucketSize
 */
declare class RoutingTable {
    constructor(self: PeerId, kBucketSize: number);
    /**
     * Amount of currently stored peers.
     *
     * @type {number}
     */
    size: number;
    /**
     * Find a specific peer by id.
     *
     * @param {PeerId} peer
     * @param {function(Error, PeerId)} callback
     * @returns {void}
     */
    find(peer: PeerId, callback: (...params: any[]) => any): void;
    /**
     * Retrieve the closest peers to the given key.
     *
     * @param {Buffer} key
     * @param {number} count
     * @returns {PeerId|undefined}
     */
    closestPeer(key: Buffer, count: number): PeerId | undefined;
    /**
     * Retrieve the `count`-closest peers to the given key.
     *
     * @param {Buffer} key
     * @param {number} count
     * @returns {Array<PeerId>}
     */
    closestPeers(key: Buffer, count: number): PeerId[];
    /**
     * Add or update the routing table with the given peer.
     *
     * @param {PeerId} peer
     * @param {function(Error)} callback
     * @returns {undefined}
     */
    add(peer: PeerId, callback: (...params: any[]) => any): undefined;
    /**
     * Remove a given peer from the table.
     *
     * @param {PeerId} peer
     * @param {function(Error)} callback
     * @returns {undefined}
     */
    remove(peer: PeerId, callback: (...params: any[]) => any): undefined;
}

/**
 * @method
 *
 * @param {object} dht
 */
declare function providers(dht: any): void;

/**
 * Creates a DHT ID by hashing a given buffer.
 *
 * @param {Buffer} buf
 * @param {function(Error, Buffer)} callback
 * @returns {void}
 */
declare function convertBuffer(buf: Buffer, callback: (...params: any[]) => any): void;

/**
 * Creates a DHT ID by hashing a Peer ID
 *
 * @param {PeerId} peer
 * @param {function(Error, Buffer)} callback
 * @returns {void}
 */
declare function convertPeerId(peer: PeerId, callback: (...params: any[]) => any): void;

/**
 * Convert a buffer to their SHA2-256 hash.
 *
 * @param {Buffer} buf
 * @returns {Key}
 */
declare function bufferToKey(buf: Buffer): Key;

/**
 * Generate the key for a public key.
 *
 * @param {PeerId} peer
 * @returns {Buffer}
 */
declare function keyForPublicKey(peer: PeerId): Buffer;

/**
 * Get the current time as timestamp.
 *
 * @returns {number}
 */
declare function now(): number;

/**
 * Encode a given buffer into a base32 string.
 * @param {Buffer} buf
 * @returns {string}
 */
declare function encodeBase32(buf: Buffer): string;

/**
 * Decode a given base32 string into a buffer.
 * @param {string} raw
 * @returns {Buffer}
 */
declare function decodeBase32(raw: string): Buffer;

/**
 * Sort peers by distance to the given `target`.
 *
 * @param {Array<PeerId>} peers
 * @param {Buffer} target
 * @param {function(Error, Array<PeerId>)} callback
 * @returns {void}
 */
declare function sortClosestPeers(peers: PeerId[], target: Buffer, callback: (...params: any[]) => any): void;

/**
 * Compare function to sort an array of elements which have a distance property which is the xor distance to a given element.
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
declare function xorCompare(a: any, b: any): number;

/**
 * Computes how many results to collect on each disjoint path, rounding up.
 * This ensures that we look for at least one result per path.
 *
 * @param {number} resultsWanted
 * @param {number} numPaths - total number of paths
 * @returns {number}
 */
declare function pathSize(resultsWanted: number, numPaths: number): number;

/**
 * Create a new put record, encodes and signs it if enabled.
 *
 * @param {Buffer} key
 * @param {Buffer} value
 * @param {function(Error, Buffer)} callback
 * @returns {void}
 */
declare function createPutRecord(key: Buffer, value: Buffer, callback: (...params: any[]) => any): void;

