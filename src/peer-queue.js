'use strict'

const Heap = require('heap')
const distance = require('xor-distance')
const debug = require('debug')
const EventEmitter = require('events')

const utils = require('./utils')
const QueueTransform = require('./queue-transform')

const log = debug('libp2p:dht:peer-queue')

/**
 * PeerQueue is a heap that sorts its entries (PeerIds) by their
 * xor distance to the inital provided key.
 */
class PeerQueue extends EventEmitter {
  /**
   * Create from a given peer id.
   *
   * @param {PeerId} id
   * @returns {Promise<PeerQueue>}
   */
  static async fromPeerId (id) {
    const key = await utils.convertPeerId(id)
    return new PeerQueue(key)
  }

  /**
   * Create from a given buffer.
   *
   * @param {Buffer} buff
   * @returns {Promise<PeerQueue>}
   */
  static async fromKey (buff) {
    const key = await utils.convertBuffer(buff)
    return new PeerQueue(key)
  }

  /**
   * Create a new PeerQueue.
   *
   * @param {Buffer} from - The sha2-256 encoded peer id
   */
  constructor (from) {
    super()

    log('create: %b', from)
    this.from = from
    this.heap = new Heap(utils.xorCompare)
  }

  /**
   * Add a new PeerId to the queue.
   *
   * @param {PeerId} id
   * @returns {Promise}
   */
  async enqueue (id) {
    log('enqueue %s', id.toB58String())
    const key = await utils.convertPeerId(id)

    const el = {
      id: id,
      distance: distance(this.from, key)
    }

    this.heap.push(el)
    this.emit('enqueued', id)
  }

  /**
   * Returns the closest peer to the `from` peer.
   *
   * @returns {PeerId}
   */
  dequeue () {
    const el = this.heap.pop()
    log('dequeue %s', el.id.toB58String())
    return el.id
  }

  /**
   * Iterable interface
   *
   * @yields {PeerId}
   */
  * [Symbol.iterator] () {
    while (this.length) {
      yield this.dequeue()
    }
  }

  /**
   * Create a new QueueTransform for this queue
   *
   * @param {function} processFn
   * @param {number} concurrency
   * @returns {AsyncIterator<Object>}
   */
  transform (processFn, concurrency = 1) {
    return new QueueTransform(this, processFn, concurrency)
  }

  get length () {
    return this.heap.size()
  }
}

module.exports = PeerQueue
