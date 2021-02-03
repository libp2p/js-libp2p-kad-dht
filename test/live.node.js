'use strict'
/**
 * TODO
 * Create a live network test to evaluate routing table performance.
 * We can spin up and do some serial refreshes to evaulate RT churn.
 * - Run in client mode
 * - Run serial refreshes
 */

const Libp2p = require('libp2p')
const TCP = require('libp2p-tcp')
const MPLEX = require('libp2p-mplex')
const { NOISE } = require('libp2p-noise')
const DHT = require('../src')
const PeerId = require('peer-id')

async function main () {
  const peerId = await PeerId.createFromJSON({
    id: '12D3KooWRjLeNhG7cQqMJUgZYsyTbFWbEbMSQfTChD794QAHFswW',
    privKey: 'CAESYCSIF8jh0VVIv4OWHz+lt3m6p1QkOtBfiOdt/I/0vUVY7HFdMHZ99Zw3fYDBsw0L79z3aC2tkHGGP1YbfMNxMnHscV0wdn31nDd9gMGzDQvv3PdoLa2QcYY/Vht8w3EycQ==',
    pubKey: 'CAESIOxxXTB2ffWcN32AwbMNC+/c92gtrZBxhj9WG3zDcTJx'
  })

  const node = await Libp2p.create({
    peerId,
    modules: {
      transport: [TCP],
      streamMuxer: [MPLEX],
      connEncryption: [NOISE],
      dht: DHT
    },
    config: {
      dht: { // The DHT options (and defaults) can be found in its documentation
        kBucketSize: 20,
        enabled: true,
        randomWalk: {
          enabled: false, // Allows to disable discovery (enabled by default)
          interval: 300e3,
          timeout: 10e3
        }
      }
    },
    peerRouting: {
      refreshManager: { // Connect to our closest peers
        enabled: true, // Should find the closest peers.
        interval: 120e3, // 2 mins
        bootDelay: 10e3 // Delay for the initial query for closest peers
      }
    }
  })

  await node.start()
  // Connect to some bootstrap peers
  await Promise.all([
    node.dial('/dnsaddr/bootstrap.libp2p.io/ipfs/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN'),
    node.dial('/dnsaddr/bootstrap.libp2p.io/ipfs/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa')
  ])

  setInterval(() => {
    const buckets = node._dht.routingTable.bucketsToArray()
    console.log('DHT (%d peers):\t\t\t', node._dht.routingTable.size)
    for (let i = 0; i < buckets.length; i++) {
      console.log('  Bucket %d (%d peers)\t\t\t', i, buckets[i].contacts.length)
      console.log('    Peer\t\t\t\t\t\t\tlast useful\tlast queried\tAgent Version')
      for (const contact of buckets[i].contacts) {
        const state = ' ' // should be '@' if peer is connected
        console.log('  %s %s\t%s\t%s\t%s', state, contact.peerId.toB58String(), contact.lastUsefulAt, contact.lastSuccessfulOutboundQueryAt, '-')
      }
    }
  }, 10e3)
}

main()
