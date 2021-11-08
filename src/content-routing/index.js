'use strict'

const errcode = require('err-code')
const { Message } = require('../message')
const parallel = require('it-parallel')
const map = require('it-map')
const { convertBuffer, logger } = require('../utils')
const { ALPHA } = require('../constants')
const { pipe } = require('it-pipe')
const {
  queryErrorEvent,
  peerResponseEvent
} = require('../query/events')

const log = logger('libp2p:kad-dht:content-routing')

/**
 * @typedef {import('multiformats/cid').CID} CID
 * @typedef {import('peer-id')} PeerId
 * @typedef {import('multiaddr').Multiaddr} Multiaddr
 */

class ContentRouting {
  /**
   * @param {import('peer-id')} peerId
   * @param {import('../network').Network} network
   * @param {import('../peer-routing').PeerRouting} peerRouting
   * @param {import('../query/manager').QueryManager} queryManager
   * @param {import('../routing-table').RoutingTable} routingTable
   * @param {import('../providers').Providers} providers
   * @param {import('../types').PeerStore} peerStore
   */
  constructor (peerId, network, peerRouting, queryManager, routingTable, providers, peerStore) {
    this._peerId = peerId
    this._network = network
    this._peerRouting = peerRouting
    this._queryManager = queryManager
    this._routingTable = routingTable
    this._providers = providers
    this._peerStore = peerStore
  }

  /**
   * Announce to the network that we can provide the value for a given key and
   * are contactable on the given multiaddrs
   *
   * @param {CID} key
   * @param {Multiaddr[]} multiaddrs
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   */
  async * provide (key, multiaddrs, options = {}) {
    log('provide %s', key)

    /** @type {Error[]} */
    const errors = []

    // Add peer as provider
    await this._providers.addProvider(key, this._peerId)

    const msg = new Message(Message.TYPES.ADD_PROVIDER, key.bytes, 0)
    msg.providerPeers = [{
      id: this._peerId,
      multiaddrs
    }]

    let sent = 0

    /**
     * @param {import('../types').QueryEvent} event
     */
    const maybeNotifyPeer = (event) => {
      return async () => {
        if (event.name !== 'finalPeer') {
          return [event]
        }

        const events = []

        log('putProvider %s to %p', key, event.peer.id)

        try {
          log('sending provider record for %s to %p', key, event.peer.id)

          for await (const sendEvent of this._network.sendMessage(event.peer.id, msg, options)) {
            if (sendEvent.name === 'peerResponse') {
              log('sent provider record for %s to %p', key, event.peer.id)
              sent++
            }

            events.push(sendEvent)
          }
        } catch (/** @type {any} */ err) {
          log.error('error sending provide record to peer %p', event.peer.id, err)
          errors.push(err)

          events.push(queryErrorEvent({ from: event.peer.id, error: err }))
        }

        return events
      }
    }

    // Notify closest peers
    yield * pipe(
      this._peerRouting.getClosestPeers(key.multihash.bytes, options),
      (source) => map(source, (event) => maybeNotifyPeer(event)),
      (source) => parallel(source, {
        ordered: false,
        concurrency: ALPHA
      }),
      async function * (source) {
        for await (const events of source) {
          yield * events
        }
      }
    )

    log('sent provider records to %d peers', sent)

    if (sent === 0) {
      if (errors.length) {
        // if all sends failed, throw an error to inform the caller
        throw errcode(new Error(`Failed to provide to ${errors.length} of ${this._routingTable._kBucketSize} peers`), 'ERR_PROVIDES_FAILED', { errors })
      }

      throw errcode(new Error('Failed to provide - no peers found'), 'ERR_PROVIDES_FAILED')
    }
  }

  /**
   * Search the dht for up to `K` providers of the given CID.
   *
   * @param {CID} key
   * @param {object} [options] - findProviders options
   * @param {number} [options.maxNumProviders=5] - maximum number of providers to find
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.queryFuncTimeout]
   */
  async * findProviders (key, options = { maxNumProviders: 5 }) {
    const toFind = options.maxNumProviders || this._routingTable._kBucketSize
    const target = key.multihash.bytes
    const id = await convertBuffer(target)
    const self = this

    log(`findProviders ${key}`)

    const provs = await this._providers.getProviders(key)

    // yield values if we have some, also slice because maybe we got lucky and already have too many?
    if (provs.length) {
      const providers = provs.slice(0, toFind)
      const response = new Message(Message.TYPES.GET_PROVIDERS, target, 0)
      response.providerPeers = providers.map(peerId => ({
        id: peerId,
        multiaddrs: (this._peerStore.addressBook.get(peerId) || []).map(address => address.multiaddr)
      }))

      yield peerResponseEvent({ from: this._peerId, response })
    }

    // All done
    if (provs.length >= toFind) {
      return
    }

    /**
     * The query function to use on this particular disjoint path
     *
     * @type {import('../query/types').QueryFunc}
     */
    const findProvidersQuery = async function * ({ peer, signal }) {
      const request = new Message(Message.TYPES.GET_PROVIDERS, target, 0)

      yield * self._network.sendRequest(peer, request, { signal })
    }

    const providers = new Set(provs.map(p => p.toB58String()))

    for await (const event of this._queryManager.run(target, this._routingTable.closestPeers(id), findProvidersQuery, options)) {
      yield event

      if (event.name === 'peerResponse' && event.response) {
        log(`Found ${event.response.providerPeers.length} provider entries for ${key} and ${event.response.closerPeers.length} closer peers`)

        for (const peer of event.response.providerPeers) {
          providers.add(peer.id.toB58String())

          if (providers.size === toFind) {
            return
          }
        }
      }
    }
  }
}

module.exports.ContentRouting = ContentRouting
