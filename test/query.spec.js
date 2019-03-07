/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect
const PeerBook = require('peer-book')
const Switch = require('libp2p-switch')
const TCP = require('libp2p-tcp')
const Mplex = require('libp2p-mplex')
const { collect } = require('streaming-iterables')

const DHT = require('../src')
const Query = require('../src/query')

const createPeerInfo = require('./utils/create-peer-info')
const createDisjointTracks = require('./utils/create-disjoint-tracks')

describe('Query', () => {
  let peerInfos
  let dht

  before(async function () {
    this.timeout(5 * 1000)
    peerInfos = await createPeerInfo(10)

    const sw = new Switch(peerInfos[0], new PeerBook())
    sw.transport.add('tcp', new TCP())
    sw.connection.addStreamMuxer(Mplex)
    sw.connection.reuse()
    dht = new DHT(sw)
  })

  it('simple run', async () => {
    const peer = peerInfos[0]

    // mock this so we can dial non existing peers
    dht.switch.dial = (peer, callback) => callback()

    let i = 0
    const query = (p) => {
      i++
      if (i === 4) {
        expect(p.id).to.eql(peerInfos[4].id.id)

        return {
          value: Buffer.from('carrots'),
          success: true
        }
      }
      if (i === 3) {
        expect(p.id).to.eql(peerInfos[3].id.id)

        return {
          closerPeers: [peerInfos[4]]
        }
      }
      if (i === 2) {
        expect(p.id).to.eql(peerInfos[2].id.id)

        return {
          value: Buffer.from('bananas'),
          closerPeers: [peerInfos[3]]
        }
      }
      expect(p.id).to.eql(peerInfos[1].id.id)
      return {
        value: Buffer.from('apples'),
        closerPeers: [peerInfos[2]]
      }
    }

    const q = new Query(dht, peer.id.id, () => query)

    const expected = [
      ['apples', 2],
      ['bananas', 3],
      ['carrots', 4]
    ]
    let r = 0
    for await (const res of q.run([peerInfos[1].id])) {
      expect(res.value.toString()).to.eql(expected[r][0])
      expect(res.peersSeen.length).to.eql(expected[r][1])
      r++
    }
    expect(r).to.eql(3)
  })

  it('does not throw an error if only some queries error', async () => {
    const peer = peerInfos[0]

    // mock this so we can dial non existing peers
    dht.switch.dial = (peer, callback) => callback()

    let i = 0
    const query = (p) => {
      if (i++ === 1) {
        throw new Error('fail')
      }
      return {
        closerPeers: [peerInfos[2]]
      }
    }

    const q = new Query(dht, peer.id.id, () => query)

    const results = await collect(q.run([peerInfos[1].id]))

    expect(results.length).to.eql(1)
    expect(results[0].peersSeen.length).to.eql(2)
  })

  it('throws an error if all queries error', async () => {
    const peer = peerInfos[0]

    // mock this so we can dial non existing peers
    dht.switch.dial = (peer, callback) => callback()

    const query = (p) => {
      throw new Error('fail')
    }

    const q = new Query(dht, peer.id.id, () => query)

    let results = []
    try {
      results = await collect(q.run([peerInfos[1].id]))
    } catch (err) {
      expect(results.length).to.eql(0)
      expect(err.message).to.eql('fail')
      return
    }
    expect.fail('No error thrown')
  })

  it('throws an error if the query times out', async () => {
    const peer = peerInfos[0]

    // mock this so we can dial non existing peers
    dht.switch.dial = (peer, callback) => callback()

    let i = 0
    const query = async (p) => {
      if (i++ === 1) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return {
          closerPeers: [peerInfos[3]]
        }
      }
      return {
        value: 'hello',
        closerPeers: [peerInfos[2]]
      }
    }

    const q = new Query(dht, peer.id.id, () => query)
    const results = []
    try {
      for await (const res of q.run([peerInfos[1].id], 100)) {
        results.push(res)
      }
    } catch (err) {
      expect(err.code).to.eql('ETIMEDOUT')
      expect(results.length).to.eql(1)
      expect(results[0].peersSeen.length).to.eql(2)
      return
    }
    expect.fail('No error thrown')
  })

  it('only closerPeers', async () => {
    const peer = peerInfos[0]

    // mock this so we can dial non existing peers
    dht.switch.dial = (peer, callback) => callback()

    const query = (p) => {
      return {
        closerPeers: [peerInfos[2]]
      }
    }

    const q = new Query(dht, peer.id.id, () => query)
    const results = await collect(q.run([peerInfos[1].id]))

    expect(results.length).to.eql(1)
    expect(results[0].peersSeen.length).to.eql(2)
  })

  it('only closerPeers concurrent', async () => {
    const peer = peerInfos[0]

    // mock this so we can dial non existing peers
    dht.switch.dial = (peer, callback) => callback()

    //    1 -------> 3
    //    1 <-> 2 -> 3 -> 4
    //               3 -> 5 -> 6
    //    1 --------------------> 7
    const topology = {
      [peerInfos[1].id.toB58String()]: [
        peerInfos[2],
        peerInfos[3],
        peerInfos[7]
      ],
      [peerInfos[2].id.toB58String()]: [
        peerInfos[3],
        peerInfos[1]
      ],
      [peerInfos[3].id.toB58String()]: [
        peerInfos[4],
        peerInfos[5]
      ],
      [peerInfos[5].id.toB58String()]: [
        peerInfos[6]
      ]
    }

    const query = (p) => {
      const closer = topology[p.toB58String()]
      return {
        closerPeers: closer || []
      }
    }

    const q = new Query(dht, peer.id.id, () => query)
    const results = await collect(q.run([peerInfos[1].id]))

    expect(results.length).to.eql(1)
    expect(results[0].peersSeen.length).to.eql(7)
  })

  it('concurrent with values', async () => {
    const peer = peerInfos[0]
    const values = ['apples', 'oranges', 'pears', 'strawberries'].map(Buffer.from)

    // mock this so we can dial non existing peers
    dht.switch.dial = (peer, callback) => callback()

    //    1 -------> 3
    //    1 <-> 2 -> 3 -> 4
    //               3 -> 5 -> 6
    //    1 --------------------> 7
    const topology = {
      [peerInfos[1].id.toB58String()]: {
        closer: [
          peerInfos[2],
          peerInfos[3],
          peerInfos[7]
        ],
        value: values[0]
      },
      [peerInfos[2].id.toB58String()]: {
        closer: [
          peerInfos[3],
          peerInfos[1]
        ]
      },
      [peerInfos[3].id.toB58String()]: {
        closer: [
          peerInfos[4],
          peerInfos[5]
        ],
        value: values[1]
      },
      [peerInfos[5].id.toB58String()]: {
        closer: [
          peerInfos[6]
        ],
        value: values[2]
      },
      [peerInfos[6].id.toB58String()]: {
        value: values[3]
      }
    }

    const query = (p) => {
      const res = topology[p.toB58String()] || {}
      return {
        closerPeers: res.closer || [],
        value: res.value
      }
    }

    const q = new Query(dht, peer.id.id, () => query)
    const results = await collect(q.run([peerInfos[1].id]))

    expect(results.length).to.eql(4)
    expect(results.map(r => r.value).sort()).to.eql(values.sort())
    expect(results[results.length - 1].peersSeen.length).to.eql(7)
  })

  it('values with early success', async () => {
    const peer = peerInfos[0]
    const values = ['apples', 'oranges'].map(Buffer.from)

    // mock this so we can dial non existing peers
    dht.switch.dial = (peer, callback) => callback()

    // 1 -> 2 -> 3 -> 4
    const topology = {
      [peerInfos[1].id.toB58String()]: {
        closer: [peerInfos[2]],
        value: values[0]
      },
      [peerInfos[2].id.toB58String()]: {
        closer: [peerInfos[3]],
        success: true
      },
      // Should not reach here because previous query returns success
      [peerInfos[3].id.toB58String()]: {
        closer: [peerInfos[4]],
        value: values[1]
      }
    }

    const query = (p) => {
      const res = topology[p.toB58String()] || {}
      return {
        closerPeers: res.closer || [],
        value: res.value,
        success: res.success
      }
    }

    const q = new Query(dht, peer.id.id, () => query)
    const results = await collect(q.run([peerInfos[1].id]))

    expect(results.length).to.eql(2)
    expect(results[0].value).to.eql(values[0])
    expect(results[1].value).to.eql(undefined)
  })

  /*
   * This test creates two disjoint tracks of peers, one for
   * each of the query's two paths to follow. The "good"
   * track that leads to the target initially has high
   * distances to the target, while the "bad" track that
   * goes nowhere has small distances to the target.
   * Only by going down both simultaneously will it find
   * the target before the end of the bad track. The greedy
   * behavior without disjoint paths would reach the target
   * only after visiting every single peer.
   *
   *                 xor distance to target
   * far <-----------------------------------------------> close
   * <us>
   *     <good 0> <g 1> <g 2>                            <target>
   *                           <bad 0> <b 1> ... <b n>
   *
   */
  it('uses disjoint paths', async () => {
    const goodLength = 3
    const { targetId, tracks, getResponse } = await createDisjointTracks(peerInfos, goodLength)

    // mock this so we can dial non existing peers
    dht.switch.dial = (peer, callback) => callback()
    let badEndVisited = false

    const q = new Query(dht, targetId, (trackNum) => {
      return (p) => {
        const response = getResponse(p, trackNum)
        expect(response).to.exist() // or we aren't on the right track
        if (response.end && !response.success) {
          badEndVisited = true
        }
        if (response.success) {
          expect(badEndVisited).to.eql(false)
        }
        return response
      }
    })
    q.concurrency = 1

    // due to round-robin allocation of peers from tracks, first
    // path is good, second bad
    const results = await collect(q.run(tracks))

    // there should be one successful path
    expect(results.length).to.eql(1)
    // we should visit all nodes (except the target)
    expect(results[0].peersSeen.length).to.eql(peerInfos.length - 1)
  })
})
