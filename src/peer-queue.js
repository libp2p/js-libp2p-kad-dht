'use strict'

const Heap = require('heap')
const distance = require('xor-distance')
const debug = require('debug')
const promisify = require('promisify-es6')
const promiseToCallback = require('promise-to-callback')

const utils = require('./utils')

const log = debug('libp2p:dht:peer-queue')

/**
 * PeerQueue is a heap that sorts its entries (PeerIds) by their
 * xor distance to the inital provided key.
 */
class PeerQueue {
  /**
   * Create from a given peer id.
   *
   * @param {PeerId} id
   * @param {function(Error, PeerQueue)} callback
   * @returns {void}
   */
  static fromPeerId (id, callback) {
    promiseToCallback(this.fromPeerIdAsync(id))(callback)
  }

  static async fromPeerIdAsync (id) {
    const key = await promisify(cb => utils.convertPeerId(id, cb))()
    return new PeerQueue(key)
  }

  /**
   * Create from a given buffer.
   *
   * @param {Buffer} keyBuffer
   * @param {function(Error, PeerQueue)} callback
   * @returns {void}
   */
  static fromKey (keyBuffer, callback) {
    promiseToCallback(this.fromKeyAsync(keyBuffer))(callback)
  }

  static async fromKeyAsync (keyBuffer) {
    const key = await promisify(cb => utils.convertBuffer(keyBuffer, cb))()
    return new PeerQueue(key)
  }

  /**
   * Create a new PeerQueue.
   *
   * @param {Buffer} from - The sha2-256 encoded peer id
   */
  constructor (from) {
    log('create: %b', from)
    this.from = from
    this.heap = new Heap(utils.xorCompare)
  }

  /**
   * Add a new PeerId to the queue.
   *
   * @param {PeerId} id
   * @param {function(Error)} callback
   * @returns {void}
   */
  enqueue (id, callback) {
    promiseToCallback(this.enqueueAsync(id))(callback)
  }

  async enqueueAsync (id) {
    log('enqueue %s', id.toB58String())
    const key = await promisify(cb => utils.convertPeerId(id, cb))()

    const el = {
      id: id,
      distance: distance(this.from, key)
    }

    this.heap.push(el)
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

  get length () {
    return this.heap.size()
  }
}

module.exports = PeerQueue
