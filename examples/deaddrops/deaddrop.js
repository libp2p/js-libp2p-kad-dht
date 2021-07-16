'use strict'

const waterfall = require('async').waterfall

const DHTNode = require('./dht').DHTNode

class DeadDrop {
	constructor(userId, dht) {
		this.userId = userId
		this.userIdKey = Buffer.from(userId)
		this.dht = dht
	}

	init(cb) {
		this.dht.start(cb)
	}

	dial(target, cb) {
		this.dht.dial(target, cb)
	}

	shutdown(cb) {
		this.dht.stop(cb)
	}

	leaveMessageToUser(receiver, message, cb) {
		const key = Buffer.from(receiver)
		const value = Buffer.from(message)
		this.dht.put(key, value, cb)
	}

	readMyMessages(cb) {
		this.dht.get(this.userIdKey, cb)
	}
}

function instantiateDeaddrop(userId, callback) {
	let deaddrop
	waterfall(
		[
			(cb) => DHTNode.createInstance(cb),
			(dht, cb) => {
				deaddrop = new DeadDrop(userId, dht)
				deaddrop.init(cb)
			}
		],
		(err) => {
			if (err) callback(err, null);

			console.log(`Deaddrop[${userId}] was successfuly initialized...`);
			callback(null, deaddrop)
		}
	)
}

module.exports = {
	instantiateDeaddrop
}