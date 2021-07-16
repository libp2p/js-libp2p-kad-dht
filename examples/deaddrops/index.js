'use strict'

const _ = require('lodash')
const {
	each,
	series,
	parallel,
	waterfall,
} = require('async')

const instantiateDeaddrop = require('./deaddrop').instantiateDeaddrop

// Dummy example:
// Create 3 deaddrops. One that's always on (for bootstrapping) and two others.
// Once the bootstrapping process completes, userA leaves a message in
// user's B deaddrop, who then later reads it.
const userAlwaysOnId = 'userAlwaysOn'
const userAId = 'userA'
const userBId = 'userB'
let deaddropAlwaysOn, deaddropA, deaddropB

// Utility method for instantiating the three deaddrops.
function instantiateAll(callback) {
	parallel(
		[
			(cb) => instantiateDeaddrop(userAlwaysOnId, cb),
			(cb) => instantiateDeaddrop(userAId, cb),
			(cb) => instantiateDeaddrop(userBId, cb),
		],
		(err, deaddrops) => {
			if (err) callback(err)

			deaddropAlwaysOn = deaddrops[0]
			deaddropA = deaddrops[1]
			deaddropB = deaddrops[2]

			console.log('Deaddrops were instantiated.\n')
			callback()
		}
	)
}

// Adapted from https://github.com/libp2p/js-libp2p-kad-dht/blob/master/test/kad-dht.spec.js#L34-L39
function connectNoSync(a, b, callback) {
	const target = _.cloneDeep(b.dht.getPeerInfo())
	target.id._pubKey = target.id.pubKey
	target.id._privKey = null
	a.dht.dial(target, callback)
}

// Utility method for connecting the two deaddrops with the always-on one.
function bootstrap(callback) {
	series(
		[
			(cb) => connectNoSync(deaddropA, deaddropAlwaysOn, cb),
			(cb) => connectNoSync(deaddropB, deaddropAlwaysOn, cb),
		],
		(err) => {
			if (err) callback(err)

			console.log('Deaddrops connected to the always-on one.')
			callback()
		}
	)
}

waterfall(
	[
		(cb) => instantiateAll(cb),
		(cb) => bootstrap(cb),
		(cb) => deaddropA.leaveMessageToUser(userBId, `Greetings from ${userAId}`, cb),
		(cb) => deaddropB.readMyMessages(cb),
		(message, cb) => {
			console.log(`${userBId}: received message[${message}]`)
			cb()
		},
		(cb) => {
			each(
				[deaddropAlwaysOn, deaddropA, deaddropB],
				(deaddrop, callback) => {
					deaddrop.shutdown(callback)
				},
				(err) => {
					if (err) cb(err)

					console.log('\nAll deaddrops were shutdown.')
					cb()
				}
			)
		}
	]
)
