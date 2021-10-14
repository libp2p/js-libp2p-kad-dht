/* eslint-env mocha */
'use strict'

const { expect } = require('aegir/utils/chai')
const delay = require('delay')
const { fromString: uint8ArrayFromString } = require('uint8arrays/from-string')
const { QueryManager } = require('../src/query/manager')
const createPeerId = require('./utils/create-peer-id')
const all = require('it-all')
const drain = require('it-drain')
const { AbortController, AbortSignal } = require('native-abort-controller')
const { sortClosestPeers } = require('./utils/sort-closest-peers')
const { convertBuffer } = require('../src/utils')

/**
 * @typedef {import('peer-id')} PeerId
 */

describe('QueryManager', () => {
  let ourPeerId
  /** @type {PeerId[]} */
  let peers
  let key

  before(async () => {
    const unsortedPeers = await createPeerId(40)
    ourPeerId = unsortedPeers.pop()
    key = unsortedPeers.pop().toBytes()

    // sort remaining peers by XOR distance to the key, low -> high
    peers = await sortClosestPeers(unsortedPeers, await convertBuffer(key))
  })

  it('does not run queries before start', async () => {
    const manager = new QueryManager(ourPeerId, 1)
    await expect(all(manager.run())).to.eventually.be.rejectedWith(/not started/)
  })

  it('does not run queries after stop', async () => {
    const manager = new QueryManager(ourPeerId, 1)
    manager.start()
    manager.stop()

    await expect(all(manager.run())).to.eventually.be.rejectedWith(/not started/)
  })

  it('should pass query context', async () => {
    const manager = new QueryManager(ourPeerId, 1)
    manager.start()

    /** @type {import('../src/types').QueryFunc<Uint8Array>} */
    const queryFunc = async (context) => { // eslint-disable-line require-await
      expect(context).to.have.property('key').that.equalBytes(key)
      expect(context).to.have.property('peer').that.deep.equals(peers[0])
      expect(context).to.have.property('signal').that.is.an.instanceOf(AbortSignal)
      expect(context).to.have.property('pathIndex').that.equals(0)
      expect(context).to.have.property('numPaths').that.equals(1)

      return {
        done: true,
        value: uint8ArrayFromString('cool')
      }
    }

    const results = await all(manager.run(key, peers, queryFunc))

    expect(results).to.have.lengthOf(1)
    expect(results).to.deep.containSubset([{
      done: true,
      value: uint8ArrayFromString('cool')
    }])

    manager.stop()
  })

  it('simple run - succeed finding value', async () => {
    const manager = new QueryManager(ourPeerId, 1, 1)
    manager.start()

    const peersQueried = []

    /** @type {import('../src/types').QueryFunc<Uint8Array>} */
    const queryFunc = async ({ peer, signal }) => { // eslint-disable-line require-await
      expect(signal).to.be.an.instanceOf(AbortSignal)
      peersQueried.push(peer)

      if (peersQueried.length === 1) {
        // query more peers
        return {
          closerPeers: peers.slice(0, 5)
        }
      }

      // all peers queried, return result
      if (peersQueried.length === 6) {
        return {
          done: true,
          value: uint8ArrayFromString('cool')
        }
      }
    }

    const results = await all(manager.run(key, [peers[7]], queryFunc))

    // e.g. our starting peer plus the 5x closerPeers returned n the first iteration
    expect(results).to.have.lengthOf(6)
    expect(results).to.deep.containSubset([{
      done: true,
      value: uint8ArrayFromString('cool')
    }])
    // should be a result in there somewhere
    expect(results.find(res => res.value)).to.be.ok()

    manager.stop()
  })

  it('simple run - fail to find value', async () => {
    const manager = new QueryManager(ourPeerId, 1, 1)
    manager.start()

    const peersQueried = []

    /** @type {import('../src/types').QueryFunc<Uint8Array>} */
    const queryFunc = async ({ peer }) => { // eslint-disable-line require-await
      peersQueried.push(peer)

      if (peersQueried.length === 1) {
        // query more peers
        return {
          closerPeers: peers.slice(0, 5)
        }
      }
    }

    const results = await all(manager.run(key, [peers[7]], queryFunc))

    // e.g. our starting peer plus the 5x closerPeers returned n the first iteration
    expect(results).to.have.lengthOf(6)
    // should not be a result in there
    expect(results.find(res => res.value)).to.not.be.ok()

    manager.stop()
  })

  it('should abort a query', async () => {
    const manager = new QueryManager(ourPeerId, 2)
    manager.start()

    const controller = new AbortController()
    let aborted

    // 0 -> 10 -> 11 -> 12...
    // 1 -> 20 -> 21 -> 22...
    const topology = {
      [peers[0]]: {
        closerPeers: [
          peers[10]
        ]
      },
      [peers[10]]: {
        closerPeers: [
          peers[11]
        ]
      },
      [peers[11]]: {
        closerPeers: [
          peers[12]
        ]
      },

      [peers[1]]: {
        closerPeers: [
          peers[20]
        ]
      },
      [peers[20]]: {
        closerPeers: [
          peers[21]
        ]
      },
      [peers[21]]: {
        closerPeers: [
          peers[22]
        ]
      }
    }

    /** @type {import('../src/types').QueryFunc<Uint8Array>} */
    const queryFunc = async ({ peer, signal }) => { // eslint-disable-line require-await
      signal.addEventListener('abort', () => {
        aborted = true
      })

      await delay(1000)

      return topology[peer]
    }

    setTimeout(() => {
      controller.abort()
    }, 10)

    await expect(all(manager.run(key, peers, queryFunc, { signal: controller.signal }))).to.eventually.be.rejected().with.property('code', 'ERR_QUERY_ABORTED')

    expect(aborted).to.be.true()

    manager.stop()
  })

  it('should allow a sub-query to timeout without aborting the whole query', async () => {
    const manager = new QueryManager(ourPeerId, 2, 2)
    manager.start()

    // 2 -> 1 -> 0
    // 4 -> 3 -> 0
    const topology = {
      [peers[0]]: {
        value: true
      },
      [peers[1]]: {
        delay: 1000,
        closerPeers: [
          peers[0]
        ]
      },
      [peers[2]]: {
        delay: 1000,
        closerPeers: [
          peers[1]
        ]
      },

      [peers[3]]: {
        delay: 10,
        closerPeers: [
          peers[0]
        ]
      },
      [peers[4]]: {
        delay: 10,
        closerPeers: [
          peers[3]
        ]
      }
    }

    /** @type {import('../src/types').QueryFunc<boolean>} */
    const queryFunc = async ({ peer, signal }) => { // eslint-disable-line require-await
      let aborted = false

      signal.addEventListener('abort', () => {
        aborted = true
      })

      const res = topology[peer]

      if (res.delay) {
        await delay(res.delay)
        delete res.delay
      }

      if (aborted) {
        throw new Error('Aborted by signal')
      }

      return res
    }

    const result = await all(manager.run(key, [peers[2], peers[4]], queryFunc, { queryFuncTimeout: 500 }))

    // should have traversed through the three nodes to the value and the one that timed out
    expect(result).to.have.lengthOf(4)
    expect(result).to.have.nested.property('[2].value', true)
    expect(result).to.have.nested.property('[3].err.message', 'Aborted by signal')

    manager.stop()
  })

  it('does not return an error if only some queries error', async () => {
    const manager = new QueryManager(ourPeerId, 10)
    manager.start()

    /** @type {import('../src/types').QueryFunc<Uint8Array>} */
    const queryFunc = async ({ pathIndex }) => { // eslint-disable-line require-await
      return {
        err: pathIndex % 2 === 0 ? new Error('Urk!') : undefined
      }
    }

    const results = await all(manager.run(key, peers, queryFunc))

    // didn't add any extra peers during the query
    expect(results).to.have.lengthOf(manager._disjointPaths)
    // should not be a result in there
    expect(results.find(res => res.value)).to.not.be.ok()
    // half of the results should have the error property
    expect(results.reduce((acc, curr) => {
      if (curr.err) {
        return acc + 1
      }

      return acc
    }, 0)).to.equal(5)

    manager.stop()
  })

  it('returns an error if all queries error', async () => {
    const manager = new QueryManager(ourPeerId, 10)
    manager.start()

    /** @type {import('../src/types').QueryFunc<Uint8Array>} */
    const queryFunc = async () => { // eslint-disable-line require-await
      return {
        err: new Error('Urk!')
      }
    }

    await expect(all(manager.run(key, peers, queryFunc))).to.eventually.be.rejectedWith(/Urk!/)

    manager.stop()
  })

  it('returns empty run if initial peer list is empty', async () => {
    const manager = new QueryManager(ourPeerId, 10)
    manager.start()

    /** @type {import('../src/types').QueryFunc<Uint8Array>} */
    const queryFunc = async () => { // eslint-disable-line require-await
      return {
        done: true,
        value: uint8ArrayFromString('cool')
      }
    }

    const results = await all(manager.run(key, [], queryFunc))

    expect(results).to.have.lengthOf(0)

    manager.stop()
  })

  it('should query closer peers first', async () => {
    const manager = new QueryManager(ourPeerId, 1, 1)
    manager.start()

    // 9 -> 8 -> 7 -> 6 -> 5 -> 0
    //  \-> 4 -> 3 -> 2 -> 1 -> 0     <-- should take this branch
    const topology = {
      [peers[9]]: {
        closerPeers: [
          peers[8],
          peers[4]
        ]
      },
      [peers[8]]: {
        closerPeers: [
          peers[7]
        ]
      },
      [peers[7]]: {
        closerPeers: [
          peers[6]
        ]
      },
      [peers[6]]: {
        closerPeers: [
          peers[5]
        ]
      },
      [peers[5]]: {
        closerPeers: [
          peers[0]
        ]
      },

      [peers[4]]: {
        closerPeers: [
          peers[3]
        ]
      },
      [peers[3]]: {
        closerPeers: [
          peers[2]
        ]
      },

      [peers[2]]: {
        closerPeers: [
          peers[1]
        ]
      },
      [peers[1]]: {
        closerPeers: [
          peers[0]
        ]
      },

      [peers[0]]: {
        value: 'hello world',
        done: true
      }
    }

    let done

    /** @type {import('../src/types').QueryFunc<string>} */
    const queryFunc = async ({ peer }) => { // eslint-disable-line require-await
      if (topology[peer].value) {
        done = true
      }

      return {
        ...topology[peer],
        done
      }
    }

    const results = await all(manager.run(key, [peers[9]], queryFunc))

    expect(results).to.have.lengthOf(6)

    // should include start point
    expect(results).to.deep.containSubset([{
      peer: peers[9]
    }])

    // should not have taken this path
    expect(results).to.not.deep.containSubset([{
      peer: peers[8]
    }])
    expect(results).to.not.deep.containSubset([{
      peer: peers[7]
    }])
    expect(results).to.not.deep.containSubset([{
      peer: peers[6]
    }])
    expect(results).to.not.deep.containSubset([{
      peer: peers[5]
    }])

    // should have taken this path
    expect(results).to.deep.containSubset([{
      peer: peers[4]
    }])
    expect(results).to.deep.containSubset([{
      peer: peers[3]
    }])
    expect(results).to.deep.containSubset([{
      peer: peers[2]
    }])
    expect(results).to.deep.containSubset([{
      peer: peers[1]
    }])

    // should have included result
    expect(results).to.deep.containSubset([{
      peer: peers[0],
      value: 'hello world'
    }])

    manager.stop()
  })

  it('only closerPeers', async () => {
    const manager = new QueryManager(ourPeerId, 1, 1)
    manager.start()

    /** @type {import('../src/types').QueryFunc<Uint8Array>} */
    const queryFunc = async () => { // eslint-disable-line require-await
      return {
        closerPeers: [peers[2]]
      }
    }

    const results = await all(manager.run(key, [peers[3]], queryFunc))

    expect(results).to.have.lengthOf(2)
    expect(results).to.have.nested.deep.property('[0].closerPeers[0]', peers[2])
    expect(results).to.have.nested.deep.property('[1].closerPeers[0]', peers[2])

    manager.stop()
  })

  it('only closerPeers concurrent', async () => {
    const manager = new QueryManager(ourPeerId, 3)
    manager.start()

    //  9 -> 2
    //  8 -> 6 -> 4
    //       5 -> 3
    //  7 -> 1 -> 0
    const topology = {
      [peers[0]]: {
        closerPeers: []
      },
      [peers[1]]: {
        closerPeers: [
          peers[0]
        ]
      },
      [peers[2]]: {
        closerPeers: []
      },
      [peers[3]]: {
        closerPeers: []
      },
      [peers[4]]: {
        closerPeers: []
      },
      [peers[5]]: {
        closerPeers: [
          peers[3]
        ]
      },
      [peers[6]]: {
        closerPeers: [
          peers[4],
          peers[5]
        ]
      },
      [peers[7]]: {
        closerPeers: [
          peers[1]
        ]
      },
      [peers[8]]: {
        closerPeers: [
          peers[6]
        ]
      },
      [peers[9]]: {
        closerPeers: [
          peers[2]
        ]
      }
    }

    /** @type {import('../src/types').QueryFunc<Uint8Array>} */
    const queryFunc = async ({ peer }) => { // eslint-disable-line require-await
      return topology[peer]
    }

    const results = await all(manager.run(key, [peers[9], peers[8], peers[7]], queryFunc))

    // Should visit all peers
    expect(results).to.have.lengthOf(10)

    manager.stop()
  })

  it('early success', async () => {
    const manager = new QueryManager(ourPeerId, 1, 1)
    manager.start()

    // 3 -> 2 -> 1 -> 0
    const topology = {
      // Should not reach here because previous query returns done: true
      [peers[0]]: {
        value: false
      },
      // Should stop here because done is true
      [peers[1]]: {
        closerPeers: [
          peers[0]
        ],
        done: true,
        value: true
      },
      [peers[2]]: {
        closerPeers: [
          peers[1]
        ]
      },
      [peers[3]]: {
        closerPeers: [
          peers[2]
        ]
      }
    }

    /** @type {import('../src/types').QueryFunc<boolean>} */
    const queryFunc = async ({ peer }) => { // eslint-disable-line require-await
      return topology[peer]
    }

    const results = await all(manager.run(key, [peers[3]], queryFunc))

    // Should not visit peer 0
    expect(results).to.have.lengthOf(3)
    expect(results).to.have.nested.property('[2].value', true)

    manager.stop()
  })

  it('queries stop after shutdown', async () => {
    const manager = new QueryManager(ourPeerId, 1, 1)
    manager.start()

    // 3 -> 2 -> 1 -> 0
    const topology = {
      [peers[0]]: {
        closerPeers: []
      },
      // Should not reach here because query gets shut down
      [peers[1]]: {
        closerPeers: [
          peers[0]
        ]
      },
      [peers[2]]: {
        closerPeers: [
          peers[1]
        ]
      },
      [peers[3]]: {
        closerPeers: [
          peers[2]
        ]
      }
    }

    const visited = []

    /** @type {import('../src/types').QueryFunc<boolean>} */
    const queryFunc = async ({ peer }) => { // eslint-disable-line require-await
      visited.push(peer)

      const getResult = async () => {
        const res = topology[peer]
        // this delay is necessary so `dhtA.stop` has time to stop the
        // requests before they all complete
        await delay(100)

        return res
      }

      // Shut down after visiting peers[2]
      if (peer === peers[2]) {
        manager.stop()

        return getResult()
      }

      return getResult()
    }

    // shutdown will cause the query to stop early but without an error
    await drain(manager.run(key, [peers[3]], queryFunc))

    // Should only visit peers up to the point where we shut down
    expect(visited).to.have.lengthOf(2)
    expect(visited).to.deep.include(peers[3])
    expect(visited).to.deep.include(peers[2])
  })

  it('disjoint path values', async () => {
    const manager = new QueryManager(ourPeerId, 2)
    manager.start()

    const values = ['v0', 'v1'].map((str) => uint8ArrayFromString(str))

    // 2 -> 1 -> 0 (v0)
    // 4 -> 3 (v1)
    const topology = {
      [peers[0]]: {
        value: values[0],
        done: true
      },
      // Top level node
      [peers[1]]: {
        closerPeers: [
          peers[0]
        ]
      },
      [peers[2]]: {
        closerPeers: [
          peers[1]
        ]
      },
      [peers[3]]: {
        value: values[1],
        done: true
      },
      [peers[4]]: {
        closerPeers: [
          peers[3]
        ]
      }
    }

    /** @type {import('../src/types').QueryFunc<Uint8Array>} */
    const queryFunc = async ({ peer }) => {
      return topology[peer]
    }

    const results = await all(manager.run(key, [peers[2], peers[4]], queryFunc))

    // visited all the nodes
    expect(results).to.have.lengthOf(5)

    // found both values
    expect(results).to.deep.containSubset([{
      value: values[0],
      done: true
    }])
    expect(results).to.deep.containSubset([{
      value: values[1],
      done: true
    }])

    manager.stop()
  })

  it('disjoint path values with early completion', async () => {
    const manager = new QueryManager(ourPeerId, 2)
    manager.start()

    // 2 -> 1 (delay) -> 0
    // 4 -> 3 [query complete]
    const topology = {
      // Query has stopped by the time we reach here, should be ignored
      [peers[0]]: {
        value: false
      },
      // This query has a delay which means it only returns after the other
      // path has already indicated the query is complete, so its result
      // should be ignored
      [peers[1]]: {
        delay: 100,
        done: true,
        closerPeers: [
          peers[0]
        ]
      },
      [peers[2]]: {
        closerPeers: [
          peers[1]
        ]
      },
      // This peer indicates that the query is complete
      [peers[3]]: {
        value: true,
        done: true
      },
      [peers[4]]: {
        closerPeers: [
          peers[3]
        ]
      }
    }

    const visited = []

    /** @type {import('../src/types').QueryFunc<boolean>} */
    const queryFunc = async ({ peer }) => {
      visited.push(peer)

      const res = topology[peer] || {}

      await delay(res.delay)

      delete res.delay

      return res
    }

    const results = await all(manager.run(key, [peers[2], peers[4]], queryFunc))

    expect(results).to.not.deep.containSubset([{
      done: true,
      value: false
    }])
    expect(results).to.deep.containSubset([{
      done: true,
      value: true
    }])

    manager.stop()
  })

  it('disjoint path continue other paths after error on one path', async () => {
    const manager = new QueryManager(ourPeerId, 2)
    manager.start()

    // 2 -> 1 (delay) -> 0 [pathComplete]
    // 5 -> 4 [error] -> 3
    const topology = {
      [peers[0]]: {
        done: true,
        value: true
      },
      // This query has a delay which means it only returns after the other
      // path has already returned an error
      [peers[1]]: {
        delay: 100,
        closerPeers: [
          peers[0]
        ]
      },
      [peers[2]]: {
        closerPeers: [
          peers[1]
        ]
      },
      [peers[3]]: {
        value: false
      },
      // Return an error at this point, also done
      [peers[4]]: {
        closerPeers: [
          peers[3]
        ],
        err: new Error('Nooo!'),
        done: true
      },
      [peers[5]]: {
        closerPeers: [
          peers[4]
        ]
      }
    }

    const visited = []

    /** @type {import('../src/types').QueryFunc<boolean>} */
    const queryFunc = async ({ peer }) => {
      visited.push(peer)

      const res = topology[peer] || {}

      await delay(res.delay)

      delete res.delay

      return res
    }

    const results = await all(manager.run(key, [peers[2], peers[5]], queryFunc))

    expect(results).to.deep.containSubset([{
      value: true
    }])
    expect(results).to.not.deep.containSubset([{
      value: false
    }])

    manager.stop()
  })

  it.skip('should end paths when they have no closer peers to those already queried', async () => {
    const manager = new QueryManager(ourPeerId, 1, 1)
    manager.start()

    // 3 -> 2 -> 1 -> 4 -> 5 -> 6 // should stop at 1
    const topology = {
      [peers[1]]: {
        closerPeers: [
          peers[4]
        ]
      },
      [peers[2]]: {
        closerPeers: [
          peers[1]
        ]
      },
      [peers[3]]: {
        closerPeers: [
          peers[2]
        ]
      },
      [peers[4]]: {
        closerPeers: [
          peers[5]
        ]
      },
      [peers[5]]: {
        closerPeers: [
          peers[6]
        ]
      },
      [peers[6]]: {
        closerPeers: []
      }
    }

    const seenPeers = new Set()

    /** @type {import('../src/types').QueryFunc<Uint8Array>} */
    const queryFunc = async ({ peer }) => { // eslint-disable-line require-await
      seenPeers.add(peer.toB58String())
      return topology[peer]
    }

    const results = await all(manager.run(key, [peers[3]], queryFunc))

    // should not have a value
    expect(results.find(res => Boolean(res.value))).to.not.be.ok()

    // should have traversed peers 3, 2 & 1
    expect(seenPeers).to.contain(peers[3].toB58String())
    expect(seenPeers).to.contain(peers[2].toB58String())
    expect(seenPeers).to.contain(peers[1].toB58String())

    // should not have traversed peers 4, 5 & 6
    expect(seenPeers).to.not.contain(peers[4].toB58String())
    expect(seenPeers).to.not.contain(peers[5].toB58String())
    expect(seenPeers).to.not.contain(peers[6].toB58String())

    manager.stop()
  })

/*
  it.skip('stop after finding k closest peers', async () => {
    // Sort peers by distance from dht.peerId
    const peerZeroDhtKey = await kadUtils.convertPeerId(dht.peerId)
    const sorted = await sortClosestPeers(peerIds, peerZeroDhtKey)

    // Local node has nodes 10, 16 and 18 in k-bucket
    const initial = [sorted[10], sorted[16], sorted[18]]

    // Should zoom in to peers near target, and then zoom out again until it
    // has successfully queried 20 peers
    const topology = {
      // Local node has nodes 10, 16 and 18 in k-bucket
      10: [12, 20, 22, 24, 26, 28],
      16: [14, 18, 20, 22, 24, 26],
      18: [4, 6, 8, 12, 14, 16],

      26: [24, 28, 30, 38],
      30: [14, 28],
      38: [2],

      // Should zoom out from this point, until it has 20 peers
      2: [13],
      13: [15],
      15: [17],

      // Right before we get to 20 peers, it finds some new peers that are
      // closer than some of the ones it has already queried
      17: [1, 3, 5, 11],
      1: [7, 9],
      9: [19],

      // At this point it's visited 20 (actually more than 20 peers), and
      // there are no closer peers to be found, so it should stop querying.
      // Because there are 3 paths, each with a worker queue with
      // concurrency 3, the exact order in which peers are visited is
      // unpredictable, so we add a long tail and below we test to make
      // sure that it never reaches the end of the tail.
      19: [21],
      21: [23],
      23: [25],
      25: [27],
      27: [29],
      29: [31]
    }

    const peerIndex = (peerId) => sorted.findIndex(p => p === peerId)
    const peerIdToPeerData = (peerId) => peerIds.find(pi => pi === peerId)

    const visited = []
    const queryFunc = async (peerId) => { // eslint-disable-line require-await
      visited.push(peerId)
      const i = peerIndex(peerId)
      const closerIndexes = topology[i] || []
      const closerPeers = closerIndexes.map(j => peerIdToPeerData(sorted[j])).map((p) => ({ id: p }))
      return { closerPeers }
    }

    const q = new Query(dht, dht.peerId.id, () => queryFunc)
    const res = await q.run(initial)

    // Should query 19 peers, then find some peers closer to the key, and
    // finally stop once those closer peers have been queried
    const expectedVisited = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 38])
    const visitedSet = new Set(visited.map(peerIndex))
    for (const i of expectedVisited) {
      expect(visitedSet.has(i))
    }

    // Should never get to end of tail (see note above)
    expect(visited.find(p => peerIndex(p) === 29)).not.to.exist()

    // Final set should have 20 peers, and the closer peers that were
    // found near the end of the query should displace further away
    // peers that were found at the beginning
    expect(res.finalSet.size).to.eql(20)
    expect(res.finalSet.has(sorted[1])).to.eql(true)
    expect(res.finalSet.has(sorted[3])).to.eql(true)
    expect(res.finalSet.has(sorted[5])).to.eql(true)
    expect(res.finalSet.has(sorted[38])).to.eql(false)
  })
*/
})
