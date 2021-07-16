'use strict'

const {
	series
} = require('async')

const TCP = require('libp2p-tcp')
const Switch = require('libp2p-switch')
const Mplex = require('libp2p-mplex')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const PeerBook = require('peer-book')

const KadDHT = require('../../src');

function createPeerInfo(callback) {
	// Creation of PeerId should be done only once, persisted and then read upon initialization.
	PeerId.create({bits: 512}, (err, id) => {
		if (err) callback(err, null)

		callback(null, new PeerInfo(id))
	})
}

function createTCPSwitch(peerInfo) {
	// Required for the nodes to be able to communicate
	// N.B. You cannot add solely a transport, a stream multiplexer is needed as well so that it
	// allows for a TCP stream to be multiplexed over a connection (even though you have only one transport), IIUC.
	const sw = new Switch(peerInfo, new PeerBook())
	sw.transport.add('tcp', new TCP())
	sw.connection.addStreamMuxer(Mplex)
	sw.connection.reuse()
	return sw
}

class DHTNode {
	/**
	 * Initializes a DHT node.
	 * @param {Switch} sw A libp2p-switch implementation. More info https://github.com/libp2p/js-libp2p-switch
	 */
	constructor(sw) {
		const options = { kBucketSize: 1 }
		this._sw = sw
		// Discovery is enabled by default since KadDHT implements also
		// https://github.com/libp2p/interface-peer-discovery through its RandomWalk module.
		this._dht = new KadDHT(sw, options)
	}

	/**
	 * Creates a new DHT Node.
	 * The node listens on localhost, using TCP, at any port, using the js-libp2p-switch implementation.
	 */
	static createInstance(callback) {
		createPeerInfo((err, peerInfo) => {
			if (err) callback(err, null)

			// This allows the node (its switch actually) to act as a "listener" (server).
			peerInfo.multiaddrs.add('/ip4/127.0.0.1/tcp/0')

			const sw = createTCPSwitch(peerInfo)
			const dht = new DHTNode(sw)
			callback(null, dht)
		})
	}

	start(callback) {
		series(
			[
				(cb) => this._sw.start(cb),
				(cb) => this._dht.start(cb),
			],
			(err) => {
				if (err) callback(err, null)

				console.log(`DHTNode[${this._dht.peerInfo.id.toB58String()}] initialized and listening on:`)
				this._dht.peerInfo.multiaddrs.forEach(ma => console.log(`\tMultiAddress[${ma.toString()}]`))

				callback()
			}
		)
	}

	stop(callback) {
		series(
			[
				(cb) => this._dht.stop(cb),
				(cb) => this._sw.stop(cb),
			],
			(err) => {
				if (err) callback(err, null)

				callback()
			}
		)
	}

	dial(target, cb) {
		this._sw.dial(target, cb)
	}

	put(key, value, cb) {
		this._dht.put(key, value, cb)
	}

	get(key, cb) {
		this._dht.get(key, null, cb)
	}

	getPeerInfo() {
		return this._dht.peerInfo
	}
}

module.exports.DHTNode = DHTNode