'use strict'

const errcode = require('err-code')
const pTimeout = require('p-timeout')

const PeerInfo = require('peer-info')

const c = require('../constants')
const LimitedPeerList = require('../peer-list/limited-peer-list')
const Message = require('../message')
const Query = require('../query')
const utils = require('../utils')

module.exports = (dht) => {
  /**
   * Check for providers from a single node.
   *
   * @param {PeerId} peer
   * @param {CID} key
   * @returns {Promise<Message>}
   *
   * @private
   */
  const findProvidersSingle = async (peer, key) => { // eslint-disable-line require-await
    const msg = new Message(Message.TYPES.GET_PROVIDERS, key.buffer, 0)
    return dht.network.sendRequest(peer, msg)
  }

  return {
    /**
     * Announce to the network that we can provide given key's value.
     * @param {CID} key
     * @returns {Promise<void>}
     */
    async provide (key) {
      dht._log('provide: %s', key.toBaseEncodedString())

      const errors = []

      // Add peer as provider
      await dht.providers.addProvider(key, dht.peerInfo.id)

      const msg = new Message(Message.TYPES.ADD_PROVIDER, key.buffer, 0)
      msg.providerPeers = [dht.peerInfo]

      // Notify closest peers
      for await (const peer of dht.getClosestPeers(key.buffer)) {
        dht._log('putProvider %s to %s', key.toBaseEncodedString(), peer.toB58String())
        try {
          await dht.network.sendMessage(peer, msg)
        } catch (err) {
          errors.push(err)
        }
      }

      if (errors.length) {
        // TODO:
        // This should be infrequent. This means a peer we previously connected
        // to failed to exchange the provide message. If getClosestPeers was an
        // iterator, we could continue to pull until we announce to kBucketSize peers.
        throw errcode(`Failed to provide to ${errors.length} of ${dht.kBucketSize} peers`, 'ERR_SOME_PROVIDES_FAILED', { errors })
      }
    },

    /**
     * Search the dht for up to `K` providers of the given CID.
     * @param {CID} key
     * @param {Object} options - findProviders options
     * @param {number} options.timeout - how long the query should maximally run, in milliseconds (default: 60000)
     * @param {number} options.maxNumProviders - maximum number of providers to find
     * @returns {AsyncIterable<PeerInfo>}
     */
    async * findProviders (key, options = {}) {
      const providerTimeout = options.timeout || c.minute
      const n = options.maxNumProviders || c.K

      dht._log('findProviders %s', key.toBaseEncodedString())

      const out = new LimitedPeerList(n)
      const provs = await dht.providers.getProviders(key)

      provs.forEach((id) => {
        let info
        if (dht.peerStore.has(id)) {
          info = dht.peerStore.get(id)
        } else {
          info = dht.peerStore.put(new PeerInfo(id))
        }
        out.push(info)
      })

      // All done
      if (out.length >= n) {
        // yield values
        for (const pInfo of out.toArray()) {
          yield pInfo
        }
        return
      }

      // need more, query the network
      const paths = []
      const query = new Query(dht, key.buffer, (pathIndex, numPaths) => {
        // This function body runs once per disjoint path
        const pathSize = utils.pathSize(n - out.length, numPaths)
        const pathProviders = new LimitedPeerList(pathSize)
        paths.push(pathProviders)

        // Here we return the query function to use on this particular disjoint path
        return async (peer) => {
          const msg = await findProvidersSingle(peer, key)
          const provs = msg.providerPeers
          dht._log('(%s) found %s provider entries', dht.peerInfo.id.toB58String(), provs.length)

          provs.forEach((prov) => {
            pathProviders.push(dht.peerStore.put(prov))
          })

          // hooray we have all that we want
          if (pathProviders.length >= pathSize) {
            return { pathComplete: true }
          }

          // it looks like we want some more
          return { closerPeers: msg.closerPeers }
        }
      })

      const peers = dht.routingTable.closestPeers(key.buffer, dht.kBucketSize)

      try {
        await pTimeout(
          query.run(peers),
          providerTimeout
        )
      } catch (err) {
        if (err.name !== pTimeout.TimeoutError.name) {
          throw err
        }
      } finally {
        query.stop()
      }

      // combine peers from each path
      paths.forEach((path) => {
        path.toArray().forEach((peer) => {
          out.push(peer)
        })
      })

      if (out.length === 0) {
        throw errcode(new Error('no providers found'), 'ERR_NOT_FOUND')
      }

      for (const pInfo of out.toArray()) {
        yield pInfo
      }
    }
  }
}
